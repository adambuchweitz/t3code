import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";
import { clampSpeechText } from "@t3tools/shared/readAloudText";

import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";

/**
 * One-way read-aloud for hands-free use. Sends the last assistant response
 * text to the server TTS endpoint and returns playable audio. The API key
 * lives in this client's local settings with `OPENAI_API_KEY` on the server
 * as fallback.
 *
 * @module web/readAloud
 */

const READ_ALOUD_TIMEOUT_MS = 120_000;

export interface ReadAloudTarget {
  readonly baseUrl: string;
  readonly authorization: PreparedHttpAuthorization | null;
}

export interface ReadAloudConfig {
  readonly apiKey: string;
  readonly voice: string;
}

/**
 * Relay connections sign each request with a DPoP proof, which this fetch path
 * cannot build. Report them as unsupported so the button stays hidden instead
 * of sending an unauthenticated request or the wrong environment's token.
 */
export function isReadAloudTargetSupported(
  target: ReadAloudTarget | null,
): target is ReadAloudTarget {
  return target !== null && target.authorization?._tag !== "Dpop";
}

function ttsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/api/tts";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function ttsSpeechUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/api/tts/speech";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function resolveAuth(
  target: ReadAloudTarget,
): Promise<{ headers: Record<string, string>; credentials: RequestCredentials }> {
  if (target.authorization?._tag === "Bearer") {
    return {
      headers: { authorization: `Bearer ${target.authorization.token}` },
      credentials: "omit",
    };
  }
  // No prepared credential means a local/primary connection, which desktop
  // authorizes with its managed bearer token and the browser authorizes with a
  // session cookie.
  const desktopToken = await readDesktopPrimaryBearerToken();
  if (desktopToken) {
    return { headers: { authorization: `Bearer ${desktopToken}` }, credentials: "omit" };
  }
  return { headers: {}, credentials: "include" };
}

/**
 * Owns the abort controller and timeout for one request. The timeout spans the
 * whole exchange, including reading the audio body, and an external signal
 * (stop, thread switch, unmount) cancels it immediately.
 */
async function withTtsFetch<T>(
  target: ReadAloudTarget,
  init: {
    readonly method: "GET" | "POST";
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
  externalSignal: AbortSignal | null,
  run: (response: Response) => Promise<T>,
): Promise<T> {
  const { headers, credentials } = await resolveAuth(target);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), READ_ALOUD_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort);
    }
  }
  try {
    const response = await globalThis.fetch(ttsUrl(target.baseUrl), {
      method: init.method,
      credentials,
      headers: { ...headers, ...init.headers },
      signal: controller.signal,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return await run(response);
  } catch (error) {
    if (controller.signal.aborted && !(externalSignal?.aborted ?? false)) {
      throw new Error("Read-aloud timed out.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

export async function readTtsEnvironmentStatus(
  target: ReadAloudTarget | null,
): Promise<{ openai: boolean }> {
  if (!isReadAloudTargetSupported(target)) {
    return { openai: false };
  }
  try {
    return await withTtsFetch(target, { method: "GET" }, null, async (response) => {
      if (!response.ok) return { openai: false };
      const payload = (await response.json().catch(() => null)) as {
        readonly openai?: unknown;
      } | null;
      return { openai: payload?.openai === true };
    });
  } catch {
    return { openai: false };
  }
}

export interface ReadAloudStream {
  readonly response: Response;
  /** True when the response was too long and only the first part was sent. */
  readonly truncated: boolean;
}

export interface PreparedSpeechText {
  /** Spoken-form prose for the response, capped at the TTS character budget. */
  readonly speech: string;
  readonly truncated: boolean;
}

/**
 * Asks the server to reformat the response for speech without synthesizing
 * audio. Warming this cache is what lets a later play skip the reformat model.
 */
export async function requestPreparedSpeechText(
  speechText: string,
  target: ReadAloudTarget | null,
  externalSignal: AbortSignal | null = null,
): Promise<PreparedSpeechText> {
  if (!isReadAloudTargetSupported(target)) {
    throw new Error("Read aloud is not available on this connection.");
  }
  const { text, truncated } = clampSpeechText(speechText);
  if (!text) {
    throw new Error("There is no response text to read yet.");
  }
  const { headers, credentials } = await resolveAuth(target);
  const response = await globalThis.fetch(ttsSpeechUrl(target.baseUrl), {
    method: "POST",
    credentials,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ text }),
    ...(externalSignal ? { signal: externalSignal } : {}),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      readonly error?: unknown;
    } | null;
    throw new Error(
      typeof payload?.error === "string" ? payload.error : "Could not prepare the response.",
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    readonly speech?: unknown;
  } | null;
  return { speech: typeof payload?.speech === "string" ? payload.speech : "", truncated };
}

/**
 * Sends the response text to the server and returns the streaming audio
 * response. Audio bytes arrive as the provider synthesizes them; the caller
 * feeds them to a player instead of waiting for the whole clip.
 */
export async function requestReadAloudStream(
  speechText: string,
  config: ReadAloudConfig,
  target: ReadAloudTarget | null,
  externalSignal: AbortSignal | null = null,
): Promise<ReadAloudStream> {
  if (!isReadAloudTargetSupported(target)) {
    throw new Error("Read aloud is not available on this connection.");
  }
  const { text, truncated } = clampSpeechText(speechText);
  if (!text) {
    throw new Error("There is no response text to read yet.");
  }
  const { headers, credentials } = await resolveAuth(target);
  const apiKey = config.apiKey.trim();
  const voice = config.voice.trim();
  const response = await globalThis.fetch(ttsUrl(target.baseUrl), {
    method: "POST",
    credentials,
    headers: {
      ...headers,
      "content-type": "application/json",
      ...(apiKey ? { "x-t3-tts-api-key": apiKey } : {}),
      ...(voice ? { "x-t3-tts-voice": voice } : {}),
    },
    body: JSON.stringify({ text }),
    ...(externalSignal ? { signal: externalSignal } : {}),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      readonly error?: unknown;
    } | null;
    throw new Error(typeof payload?.error === "string" ? payload.error : "Read-aloud failed.");
  }
  return { response, truncated };
}
