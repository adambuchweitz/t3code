import type { EnvironmentId, SpeechOptions, SpeechVoiceProfiles } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { clampSpeechText } from "@t3tools/shared/speechText";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";
import { environmentSpeech } from "../state/speech";

/**
 * Read-aloud requests go to the environment that owns the thread, so remote
 * and relay threads are spoken by their own server.
 *
 * @module web/readAloud
 */

function preparedConnection(environmentId: EnvironmentId) {
  const prepared = readPreparedConnection(environmentId);
  if (prepared === null) throw new Error("This environment is not connected.");
  return prepared;
}

// Callers turn failures into their own errors, so the command reports nothing itself.
const QUIET = { reportFailure: false, reportDefect: false } as const;

function settle<A>(result: AtomCommandResult<A, unknown>): A {
  if (result._tag === "Failure") {
    // A cancelled request rejects as an abort, which callers treat as no error at all.
    if (isAtomCommandInterrupted(result))
      throw new DOMException("Read aloud was cancelled.", "AbortError");
    const error = squashAtomCommandFailure(result);
    throw error instanceof Error ? error : new Error("Read aloud failed.");
  }
  return result.value;
}

/** Long responses are read up to the cap; `truncated` says the listener is missing the rest. */
export function clampResponse(text: string): ReturnType<typeof clampSpeechText> {
  const clamped = clampSpeechText(text);
  if (clamped.text.trim() === "") throw new Error("There is no response text to read yet.");
  return clamped;
}

export async function requestSpeechAudio(
  environmentId: EnvironmentId,
  request: {
    readonly text: string;
    readonly voice: string;
    readonly options: SpeechOptions;
    readonly verbatim: boolean;
  },
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  signal.throwIfAborted();
  const prepared = preparedConnection(environmentId);
  return settle(
    await runAtomCommand(
      appAtomRegistry,
      environmentSpeech.audio,
      { prepared, request, signal },
      { ...QUIET, signal },
    ),
  );
}

/** Warms the environment's rewritten-text cache so a later play skips the model. */
export async function prepareSpeechText(environmentId: EnvironmentId, text: string) {
  const prepared = preparedConnection(environmentId);
  return settle(
    await runAtomCommand(appAtomRegistry, environmentSpeech.text, { prepared, text }, QUIET),
  );
}

export async function requestVoiceProfiles(
  environmentId: EnvironmentId,
  signal: AbortSignal,
): Promise<SpeechVoiceProfiles> {
  const prepared = preparedConnection(environmentId);
  return settle(
    await runAtomCommand(
      appAtomRegistry,
      environmentSpeech.voices,
      { prepared, signal },
      { ...QUIET, signal },
    ),
  );
}
