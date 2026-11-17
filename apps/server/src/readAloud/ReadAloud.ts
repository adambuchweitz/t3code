import {
  type ModelSelection,
  MAX_SPEECH_TEXT_CHARS,
  type SpeechAudioRequest,
  SpeechInputError,
  SpeechUnavailableError,
  type SpeechVoiceProfiles,
  isDefaultSpeechVoice,
} from "@t3tools/contracts";
import { clampSpeechText, stripMarkdownForSpeech } from "@t3tools/shared/speechText";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Hex from "effect/encoding/Hex";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Persistable from "effect/persistence/Persistable";
import * as PersistedCache from "effect/persistence/PersistedCache";
import * as Persistence from "effect/persistence/Persistence";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

/**
 * Read aloud: reshapes an assistant response into spoken prose with the
 * server's text-generation model, then streams VoiceStudio audio for it.
 *
 * VoiceStudio is a self-hosted OmniVoice server on lan-party. It is only
 * reachable over the tailnet, which is its access control, so no key is sent.
 */
const VOICE_STUDIO_ORIGIN = "https://lan-party.tail928ade.ts.net:3900";
const VOICE_STUDIO_MODEL = "tts-1";
const SYNTHESIS_TIMEOUT = Duration.minutes(2);
const VOICES_TIMEOUT = Duration.seconds(15);
const ERROR_BODY_DRAIN_TIMEOUT = Duration.seconds(10);

/** Bump when the speech prompt changes so cached prose is regenerated. */
const SPEECH_PROMPT_VERSION = "v1";
const SPEECH_TEXT_TTL = Duration.days(7);

// Two messages can hash alike only by a SHA-256 collision, so the hash is the identity.
class SpeechTextRequest extends Persistable.Class<{
  payload: {
    readonly key: string;
    readonly message: string;
    readonly modelSelection: ModelSelection;
  };
}>()("ReadAloudSpeechText", {
  primaryKey: ({ key }) => key,
  success: Schema.Struct({ speech: Schema.NullOr(Schema.String) }),
}) {
  [Equal.symbol](that: unknown): boolean {
    return that instanceof SpeechTextRequest && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

/** A null result means the model failed; caching it would pin the fallback for a week. */
const speechTextTtl = (exit: Exit.Exit<{ readonly speech: string | null }>) =>
  Exit.isSuccess(exit) && exit.value.speech !== null ? SPEECH_TEXT_TTL : Duration.zero;

const VoiceStudioVoices = Schema.Struct({
  voices: Schema.Array(
    Schema.Struct({ voice_id: Schema.String, name: Schema.String, type: Schema.String }),
  ),
});

export class ReadAloud extends Context.Service<
  ReadAloud,
  {
    /** Streams mp3 audio as VoiceStudio produces it, so playback can start early. */
    readonly audio: (
      input: SpeechAudioRequest,
    ) => Effect.Effect<
      Stream.Stream<Uint8Array, SpeechUnavailableError>,
      SpeechInputError | SpeechUnavailableError
    >;
    /**
     * The prose `audio` would speak. Clients call it ahead of playback to warm
     * the cache. Falls back to stripped markdown when no model answers.
     */
    readonly speechText: (text: string) => Effect.Effect<string, SpeechInputError>;
    /** Saved VoiceStudio profiles; its OpenAI aliases all mean the default voice. */
    readonly voices: Effect.Effect<SpeechVoiceProfiles, SpeechUnavailableError>;
  }
>()("t3/readAloud/ReadAloud") {}

const isSpeechUnavailableError = Schema.is(SpeechUnavailableError);

const validateText = (text: string) => {
  const trimmed = text.trim();
  if (trimmed === "") return Effect.fail(new SpeechInputError({ reason: "empty_text" }));
  if (trimmed.length > MAX_SPEECH_TEXT_CHARS) {
    return Effect.fail(new SpeechInputError({ reason: "text_too_long" }));
  }
  return Effect.succeed(trimmed);
};

/** Drains an error body so the connection is released, bounded so a stalled body cannot hold it. */
const drainAndReject = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.runDrain,
    Effect.timeout(ERROR_BODY_DRAIN_TIMEOUT),
    Effect.ignore,
    Effect.andThen(Effect.fail(new SpeechUnavailableError({ providerStatus: response.status }))),
  );

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Digest.Digest;

  const generateSpeech = Effect.fn("ReadAloud.generateSpeech")(function* (
    request: SpeechTextRequest,
  ) {
    // An empty directory keeps a checkout's agent configuration out of the rewrite.
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-read-aloud-" });
    const generated = yield* textGeneration.generateSpeechText({
      cwd,
      message: request.message,
      modelSelection: request.modelSelection,
    });
    return { speech: generated.speech.trim() || null };
  }, Effect.scoped);

  const speechTextCache = yield* PersistedCache.make(
    (request: SpeechTextRequest) =>
      generateSpeech(request).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Read-aloud speech rewrite failed; using stripped markdown", {
            cause,
          }).pipe(Effect.as({ speech: null })),
        ),
      ),
    {
      storeId: "read-aloud-speech-text-v1",
      timeToLive: speechTextTtl,
      inMemoryTTL: (exit) => (Duration.isZero(speechTextTtl(exit)) ? Duration.zero : "5 minutes"),
      inMemoryCapacity: 128,
    },
  );

  const rewrite = Effect.fn("ReadAloud.rewrite")(function* (message: string) {
    const { textGenerationModelSelection: modelSelection } = yield* serverSettings.getSettings;
    const key = yield* crypto
      .digest(
        Digest.sha256,
        new TextEncoder().encode(
          [SPEECH_PROMPT_VERSION, modelSelection.instanceId, modelSelection.model, message].join(
            "\n",
          ),
        ),
      )
      .pipe(Effect.map(Hex.encode));
    const { speech } = yield* speechTextCache.get(
      new SpeechTextRequest({ key, message, modelSelection }),
    );
    return speech;
  });

  const speechText: ReadAloud["Service"]["speechText"] = Effect.fn("ReadAloud.speechText")(
    function* (text) {
      const message = yield* validateText(text);
      const rewritten = yield* rewrite(message).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Read-aloud speech cache unavailable; using stripped markdown", {
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      return clampSpeechText(rewritten ?? stripMarkdownForSpeech(message)).text;
    },
  );

  const audio: ReadAloud["Service"]["audio"] = Effect.fn("ReadAloud.audio")(function* (input) {
    const validated = yield* validateText(input.text);
    const text = input.verbatim ? validated : yield* speechText(validated);
    const { options } = input;
    const instructions = [
      options.gender,
      options.age,
      options.pitch,
      options.accent,
      options.whisper ? "whisper" : "",
    ]
      .filter(Boolean)
      .join(", ");
    const response = yield* HttpClientRequest.post(`${VOICE_STUDIO_ORIGIN}/v1/audio/speech`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        model: VOICE_STUDIO_MODEL,
        voice: isDefaultSpeechVoice(input.voice) ? "alloy" : input.voice.trim(),
        speed: options.speed,
        num_step: options.steps,
        guidance_scale: options.guidance,
        ...(options.language ? { language: options.language } : {}),
        ...(instructions ? { instructions } : {}),
        ...(options.seed === null ? {} : { seed: options.seed }),
        input: text,
        response_format: "mp3",
        stream_format: "audio",
      }),
      httpClient.execute,
      Effect.timeout(SYNTHESIS_TIMEOUT),
      Effect.mapError((cause) => new SpeechUnavailableError({ cause })),
    );
    if (response.status < 200 || response.status >= 300) return yield* drainAndReject(response);
    // A stall timeout, reset by each chunk: VoiceStudio can send headers and then stall,
    // while a long read that keeps streaming must not be cut off.
    return response.stream.pipe(
      Stream.timeoutOrElse({
        duration: SYNTHESIS_TIMEOUT,
        orElse: () => Stream.fail(new SpeechUnavailableError({})),
      }),
      Stream.mapError((cause) =>
        isSpeechUnavailableError(cause) ? cause : new SpeechUnavailableError({ cause }),
      ),
    );
  });

  const voices: ReadAloud["Service"]["voices"] = Effect.gen(function* () {
    const response = yield* httpClient.get(`${VOICE_STUDIO_ORIGIN}/v1/audio/voices`).pipe(
      Effect.timeout(VOICES_TIMEOUT),
      Effect.mapError((cause) => new SpeechUnavailableError({ cause })),
    );
    if (response.status < 200 || response.status >= 300) return yield* drainAndReject(response);
    const body = yield* HttpClientResponse.schemaBodyJson(VoiceStudioVoices)(response).pipe(
      Effect.timeout(VOICES_TIMEOUT),
      Effect.mapError((cause) => new SpeechUnavailableError({ cause })),
    );
    return body.voices
      .filter((voice) => voice.type === "profile")
      .map((voice) => ({ id: voice.voice_id, name: voice.name }));
  }).pipe(Effect.withSpan("ReadAloud.voices"));

  return ReadAloud.of({ audio, speechText, voices });
});

const logStoreFailure = (cause: KeyValueStore.KeyValueStoreError) =>
  Effect.logWarning("Read-aloud cache storage failed; keeping rewritten text in memory", {
    cause,
  });

/**
 * The disk copy only spares a model call after a restart, so a store that
 * cannot read counts as a miss and one that cannot write (removed folder, full
 * disk, permissions) keeps the rewrite in memory. Only typed store failures are
 * absorbed; interruptions still stop the read.
 */
const bestEffortStore = (store: KeyValueStore.KeyValueStore) =>
  KeyValueStore.make({
    get: (key) =>
      store
        .get(key)
        .pipe(Effect.catch((cause) => logStoreFailure(cause).pipe(Effect.as(undefined)))),
    getUint8Array: (key) =>
      store
        .getUint8Array(key)
        .pipe(Effect.catch((cause) => logStoreFailure(cause).pipe(Effect.as(undefined)))),
    set: (key, value) => store.set(key, value).pipe(Effect.catch(logStoreFailure)),
    remove: (key) => store.remove(key).pipe(Effect.catch(logStoreFailure)),
    clear: store.clear.pipe(Effect.catch(logStoreFailure)),
    keys: store.keys.pipe(Effect.catch((cause) => logStoreFailure(cause).pipe(Effect.as([])))),
    size: store.size.pipe(Effect.catch((cause) => logStoreFailure(cause).pipe(Effect.as(0)))),
  });

/**
 * The store only drops an expired entry when that key is read again, so files
 * for responses never replayed would pile up. Every entry is written once with
 * the same TTL, so a file older than the TTL is expired; this deletes those in
 * the feature's own directory when the server starts.
 */
const sweepExpiredSpeechText = Effect.fn("ReadAloud.sweepExpiredSpeechText")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fileSystem.exists(directory))) return;
  const now = yield* Clock.currentTimeMillis;
  const names = yield* fileSystem.readDirectory(directory);
  yield* Effect.forEach(
    names,
    (name) => {
      const file = path.join(directory, name);
      return fileSystem.stat(file).pipe(
        Effect.flatMap((info) =>
          info.type === "File" &&
          Option.isSome(info.mtime) &&
          now - info.mtime.value.getTime() > Duration.toMillis(SPEECH_TEXT_TTL)
            ? fileSystem.remove(file)
            : Effect.void,
        ),
        // A file that vanished or cannot be removed waits for the next start.
        Effect.ignore,
      );
    },
    { concurrency: 8, discard: true },
  );
});

/** Rewritten text persists across restarts; it is small and costs a model call to rebuild. */
const layerSpeechTextFiles = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const directory = path.join(config.providerStatusCacheDir, "read-aloud-speech-text");
    yield* sweepExpiredSpeechText(directory).pipe(
      Effect.catch((cause) => Effect.logWarning("Could not sweep the read-aloud cache", { cause })),
    );
    return KeyValueStore.layerFileSystem(directory).pipe(
      Layer.catch((cause) =>
        Layer.effectDiscard(
          Effect.logWarning("Read-aloud cache directory unavailable; using memory", { cause }),
        ).pipe(Layer.provideMerge(KeyValueStore.layerMemory)),
      ),
    );
  }),
);

const layerSpeechTextStore = Layer.effect(
  KeyValueStore.KeyValueStore,
  Effect.map(KeyValueStore.KeyValueStore, bestEffortStore),
).pipe(Layer.provide(layerSpeechTextFiles));

export const layer = Layer.effect(ReadAloud, make).pipe(
  Layer.provide(Persistence.layerKvs.pipe(Layer.provide(layerSpeechTextStore))),
);
