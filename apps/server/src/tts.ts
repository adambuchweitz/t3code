import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  DEFAULT_TTS_VOICE,
  MAX_TTS_TEXT_CHARS,
  TTS_VOICES,
  type TtsVoice,
} from "@t3tools/contracts";

/**
 * One-way read-aloud via OpenAI TTS. No duplex, no mic.
 * The key comes from the client's settings, with `OPENAI_API_KEY` in the
 * server env as fallback.
 *
 * @module server/tts
 */

const TTS_ENDPOINT = "https://api.openai.com/v1/audio/speech";

export class TtsApiKeyMissingError extends Schema.TaggedError<TtsApiKeyMissingError>()(
  "TtsApiKeyMissingError",
  {},
) {
  override get message(): string {
    return "Set OPENAI_API_KEY in the server environment to enable read-aloud.";
  }
}

export class TtsBadInputError extends Schema.TaggedError<TtsBadInputError>()("TtsBadInputError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export class TtsProviderError extends Schema.TaggedError<TtsProviderError>()("TtsProviderError", {
  providerStatus: Schema.Int,
}) {
  override get message(): string {
    return `The TTS provider rejected the request (status ${this.providerStatus}).`;
  }
}

export class TtsRequestError extends Schema.TaggedError<TtsRequestError>()("TtsRequestError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Could not reach the TTS provider.";
  }
}

const resolveTtsApiKey = Effect.fn("tts.resolveApiKey")(function* (inputKey: string) {
  const apiKey =
    inputKey.trim() || (yield* Config.string("OPENAI_API_KEY").pipe(Config.withDefault(""))).trim();
  if (!apiKey) {
    return yield* new TtsApiKeyMissingError();
  }
  return apiKey;
});

export const ttsEnvironmentApiKeyStatus = Effect.fn("tts.environmentApiKeyStatus")(function* () {
  const value = yield* Config.string("OPENAI_API_KEY").pipe(Config.withDefault(""));
  return value.trim().length > 0;
});

function resolveTtsVoice(inputVoice: string): TtsVoice {
  const voice = inputVoice.trim().toLowerCase();
  return (TTS_VOICES as ReadonlyArray<string>).includes(voice)
    ? (voice as TtsVoice)
    : DEFAULT_TTS_VOICE;
}

export interface SynthesizeSpeechInput {
  readonly text: string;
  readonly apiKey: string;
  readonly voice: string;
}

export const synthesizeSpeech = Effect.fn("tts.synthesize")(function* (
  input: SynthesizeSpeechInput,
) {
  const text = input.text.trim();
  if (!text) {
    return yield* new TtsBadInputError({ reason: "There is no response text to read yet." });
  }
  if (text.length > MAX_TTS_TEXT_CHARS) {
    return yield* new TtsBadInputError({
      reason: `Response is too long to read aloud (${text.length} chars, max ${MAX_TTS_TEXT_CHARS}).`,
    });
  }
  const apiKey = yield* resolveTtsApiKey(input.apiKey);
  const voice = resolveTtsVoice(input.voice);

  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post(TTS_ENDPOINT).pipe(
    HttpClientRequest.bearerToken(apiKey),
    HttpClientRequest.bodyJsonUnsafe({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      response_format: "mp3",
    }),
    httpClient.execute,
    Effect.mapError((cause) => new TtsRequestError({ cause })),
    Effect.timeout("2 minutes"),
    Effect.catchTags({
      TimeoutError: (cause) => Effect.fail(new TtsRequestError({ cause })),
    }),
  );
  if (response.status < 200 || response.status >= 300) {
    // Drain the body so the connection is released before we fail. Bounded so a
    // provider that sends headers then stalls cannot hold the request open.
    yield* HttpClientResponse.stream(Effect.succeed(response)).pipe(
      Stream.runDrain,
      Effect.timeout("10 seconds"),
      Effect.ignore,
    );
    return yield* new TtsProviderError({ providerStatus: response.status });
  }
  const chunks = yield* HttpClientResponse.stream(Effect.succeed(response)).pipe(
    Stream.runCollect,
    Effect.mapError((cause) => new TtsRequestError({ cause })),
    Effect.timeout("2 minutes"),
    Effect.catchTags({
      TimeoutError: (cause) => Effect.fail(new TtsRequestError({ cause })),
    }),
  );
  let size = 0;
  for (const chunk of chunks) {
    size += chunk.byteLength;
  }
  const audio = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return audio;
});
