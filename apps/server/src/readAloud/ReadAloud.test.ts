import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SPEECH_OPTIONS,
  type SpeechAudioRequest,
  type SpeechUnavailableError,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ReadAloud from "./ReadAloud.ts";

type Reply = (request: HttpClientRequest.HttpClientRequest) => Response;

function harness(options: {
  readonly baseDir?: string;
  readonly reply?: Reply;
  readonly client?: HttpClient.HttpClient;
  readonly rewrite?: (message: string) => Effect.Effect<string, TextGenerationError>;
}) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const rewrites: string[] = [];
  const recording = HttpClient.make((request) => {
    requests.push(request);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        (options.reply ?? (() => new Response("audio")))(request),
      ),
    );
  });
  const layer = ReadAloud.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, options.client ?? recording),
        ServerSettings.layerTest(),
        Layer.mock(TextGeneration.TextGeneration)({
          generateSpeechText: (input) => {
            rewrites.push(input.message);
            return (options.rewrite ?? (() => Effect.succeed("Spoken response.")))(
              input.message,
            ).pipe(Effect.map((speech) => ({ speech })));
          },
        }),
        ServerConfig.layerTest(
          process.cwd(),
          options.baseDir ?? { prefix: "t3code-read-aloud-test-" },
        ),
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { layer, requests, rewrites };
}

const jsonBody = (request: HttpClientRequest.HttpClientRequest) => {
  assert.equal(request.body._tag, "Uint8Array");
  return request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : undefined;
};

const audioRequest = (overrides: Partial<SpeechAudioRequest> = {}): SpeechAudioRequest => ({
  text: "**Done.** Tests pass.",
  voice: "alloy",
  options: DEFAULT_SPEECH_OPTIONS,
  verbatim: false,
  ...overrides,
});

const collectText = (stream: Stream.Stream<Uint8Array, SpeechUnavailableError>) =>
  Stream.runCollect(stream).pipe(
    Effect.map((chunks) => chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")),
  );

describe("ReadAloud.audio", () => {
  it.effect("speaks the rewritten response with the selected profile and controls", () => {
    const test = harness({});
    return Effect.gen(function* () {
      const readAloud = yield* ReadAloud.ReadAloud;
      const stream = yield* readAloud.audio(
        audioRequest({
          voice: "demo0001",
          options: {
            ...DEFAULT_SPEECH_OPTIONS,
            speed: 1.25,
            steps: 32,
            guidance: 3,
            seed: 42,
            language: "en",
            gender: "female",
            accent: "british accent",
            whisper: true,
          },
        }),
      );
      assert.equal(yield* collectText(stream), "audio");
      assert.deepEqual(test.rewrites, ["**Done.** Tests pass."]);
      const [request] = test.requests;
      assert.equal(request?.url, "https://lan-party.tail928ade.ts.net:3900/v1/audio/speech");
      // The tailnet is VoiceStudio's access control; no credential ever leaves this server.
      assert.equal(request?.headers.authorization, undefined);
      assert.deepEqual(jsonBody(request!), {
        model: "tts-1",
        voice: "demo0001",
        speed: 1.25,
        num_step: 32,
        guidance_scale: 3,
        language: "en",
        instructions: "female, british accent, whisper",
        seed: 42,
        input: "Spoken response.",
        response_format: "mp3",
        stream_format: "audio",
      });
    }).pipe(Effect.provide(test.layer));
  });

  it.effect(
    "speaks verbatim text without the rewrite model, mapping aliases to the default",
    () => {
      const test = harness({});
      return Effect.gen(function* () {
        const readAloud = yield* ReadAloud.ReadAloud;
        yield* readAloud
          .audio(audioRequest({ text: "Preview this voice.", voice: "nova", verbatim: true }))
          .pipe(Effect.flatMap(Stream.runDrain));
        assert.deepEqual(test.rewrites, []);
        const body = jsonBody(test.requests[0]!);
        assert.equal(body.voice, "alloy");
        assert.equal(body.input, "Preview this voice.");
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("rejects empty text before calling VoiceStudio", () => {
    const test = harness({});
    return Effect.gen(function* () {
      const readAloud = yield* ReadAloud.ReadAloud;
      const error = yield* readAloud.audio(audioRequest({ text: "   " })).pipe(Effect.flip);
      assert.equal(error._tag, "SpeechInputError");
      assert.equal(test.requests.length, 0);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("reports VoiceStudio's status when it rejects the request", () => {
    const test = harness({ reply: () => new Response("unavailable", { status: 503 }) });
    return Effect.gen(function* () {
      const readAloud = yield* ReadAloud.ReadAloud;
      const error = yield* readAloud.audio(audioRequest({ verbatim: true })).pipe(Effect.flip);
      assert.equal(error._tag, "SpeechUnavailableError");
      assert.equal(error._tag === "SpeechUnavailableError" ? error.providerStatus : 0, 503);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("fails and releases a stream that stalls after headers", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const stalled = Stream.fromEffect(
        Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Stream.ensuring(Deferred.succeed(released, undefined)));
      const client = HttpClient.make((request) =>
        Effect.succeed({ ...HttpClientResponse.fromWeb(request, new Response()), stream: stalled }),
      );
      const readAloud = yield* ReadAloud.ReadAloud.pipe(Effect.provide(harness({ client }).layer));
      const stream = yield* readAloud.audio(audioRequest({ verbatim: true }));
      const pending = yield* Stream.runDrain(stream).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(reading);
      yield* TestClock.adjust("2 minutes");
      assert.equal((yield* Fiber.join(pending))._tag, "SpeechUnavailableError");
      yield* Deferred.await(released);
    }),
  );
});

describe("ReadAloud.speechText", () => {
  it.effect("reuses rewritten text, including after a restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-read-aloud-cache-test-",
      });
      const speak = (test: ReturnType<typeof harness>) =>
        ReadAloud.ReadAloud.pipe(
          Effect.flatMap((readAloud) => readAloud.speechText("## Result\n\nIt works.")),
          Effect.provide(test.layer),
        );

      const first = harness({ baseDir });
      assert.equal(yield* speak(first), "Spoken response.");
      assert.equal(yield* speak(first), "Spoken response.");
      assert.equal(first.rewrites.length, 1);

      const restarted = harness({ baseDir });
      assert.equal(yield* speak(restarted), "Spoken response.");
      assert.equal(restarted.rewrites.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("drops rewrites older than a week from disk when the server starts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-read-aloud-sweep-test-",
      });
      const cacheDir = `${baseDir}/caches/read-aloud-speech-text`;
      yield* fileSystem.makeDirectory(cacheDir, { recursive: true });
      const day = 24 * 60 * 60 * 1000;
      const now = Date.UTC(2026, 9, 20);
      yield* fileSystem.writeFileString(`${cacheDir}/expired`, "[]");
      // Node reads numeric times as seconds.
      const eightDaysAgo = (now - 8 * day) / 1000;
      yield* fileSystem.utimes(`${cacheDir}/expired`, eightDaysAgo, eightDaysAgo);
      yield* fileSystem.writeFileString(`${cacheDir}/fresh`, "[]");
      const twoDaysAgo = (now - 2 * day) / 1000;
      yield* fileSystem.utimes(`${cacheDir}/fresh`, twoDaysAgo, twoDaysAgo);
      yield* TestClock.setTime(now);

      yield* ReadAloud.ReadAloud.pipe(Effect.provide(harness({ baseDir }).layer));
      assert.deepEqual((yield* fileSystem.readDirectory(cacheDir)).toSorted(), ["fresh"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns and keeps a rewrite when the disk cache cannot be written", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-read-aloud-unwritable-test-",
      });
      const test = harness({ baseDir });
      yield* Effect.gen(function* () {
        const readAloud = yield* ReadAloud.ReadAloud;
        // A file where the cache folder was makes every write fail, like a removed or locked folder.
        const cacheDir = `${baseDir}/caches/read-aloud-speech-text`;
        yield* fileSystem.remove(cacheDir, { recursive: true });
        yield* fileSystem.writeFileString(cacheDir, "");

        assert.equal(yield* readAloud.speechText("## Result\n\nIt works."), "Spoken response.");
        assert.equal(yield* readAloud.speechText("## Result\n\nIt works."), "Spoken response.");
        assert.equal(test.rewrites.length, 1);
      }).pipe(Effect.provide(test.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to stripped markdown without pinning the failure", () => {
    const test = harness({
      rewrite: () =>
        Effect.fail(new TextGenerationError({ operation: "generateSpeechText", detail: "down" })),
    });
    return Effect.gen(function* () {
      const readAloud = yield* ReadAloud.ReadAloud;
      const markdown = "## Result\n\n- **Tests** pass\n\n```ts\nconst x = 1;\n```";
      assert.equal(yield* readAloud.speechText(markdown), "Result\n\nTests pass\n\ncode sample.");
      yield* readAloud.speechText(markdown);
      assert.equal(test.rewrites.length, 2);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("caps rewritten text at the read-aloud limit", () => {
    const test = harness({ rewrite: () => Effect.succeed("Spoken words. ".repeat(1_000)) });
    return Effect.gen(function* () {
      const readAloud = yield* ReadAloud.ReadAloud;
      const speech = yield* readAloud.speechText("Long response");
      assert.isAtMost(speech.length, 4_000);
      assert.isTrue(speech.endsWith("."));
    }).pipe(Effect.provide(test.layer));
  });
});

it.effect("lists saved VoiceStudio profiles without the OpenAI aliases", () => {
  const test = harness({
    reply: () =>
      Response.json({
        voices: [
          { voice_id: "alloy", name: "Alloy", type: "openai_alias" },
          { voice_id: "demo0001", name: "Demo", type: "profile", language: "English" },
        ],
      }),
  });
  return Effect.gen(function* () {
    const readAloud = yield* ReadAloud.ReadAloud;
    assert.deepEqual(yield* readAloud.voices, [{ id: "demo0001", name: "Demo" }]);
    assert.equal(test.requests[0]?.url, "https://lan-party.tail928ade.ts.net:3900/v1/audio/voices");
  }).pipe(Effect.provide(test.layer));
});

describe("ReadAloud cancellation", () => {
  it.effect("interrupting a read stops the model rewrite it is waiting on", () => {
    const rewriting = Deferred.makeUnsafe<void>();
    const stopped = Deferred.makeUnsafe<void>();
    const test = harness({
      rewrite: () =>
        Deferred.succeed(rewriting, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
        ),
    });
    return Effect.gen(function* () {
      const readAloud = yield* ReadAloud.ReadAloud;
      // The HTTP server interrupts the handler like this when the client disconnects.
      const reading = yield* readAloud.audio(audioRequest()).pipe(Effect.forkChild);
      yield* Deferred.await(rewriting);
      yield* Fiber.interrupt(reading);
      yield* Deferred.await(stopped);
      assert.equal(test.requests.length, 0);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("keeps a shared rewrite running for a reader that is still waiting", () => {
    const rewriting = Deferred.makeUnsafe<void>();
    const answer = Deferred.makeUnsafe<string>();
    const test = harness({
      rewrite: () =>
        Deferred.succeed(rewriting, undefined).pipe(Effect.andThen(Deferred.await(answer))),
    });
    return Effect.gen(function* () {
      const readAloud = yield* ReadAloud.ReadAloud;
      const cancelled = yield* readAloud.speechText("Same response").pipe(Effect.forkChild);
      const waiting = yield* readAloud.speechText("Same response").pipe(Effect.forkChild);
      yield* Deferred.await(rewriting);
      yield* Fiber.interrupt(cancelled);

      yield* Deferred.succeed(answer, "Shared speech.");
      assert.equal(yield* Fiber.join(waiting), "Shared speech.");
      // The finished rewrite is cached even though one of its readers left.
      assert.equal(yield* readAloud.speechText("Same response"), "Shared speech.");
      assert.equal(test.rewrites.length, 1);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("interrupting synthesis aborts the VoiceStudio request", () => {
    const requested = Deferred.makeUnsafe<void>();
    const aborted = Deferred.makeUnsafe<void>();
    const client = HttpClient.make(() =>
      Deferred.succeed(requested, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(aborted, undefined)),
      ),
    );
    return Effect.gen(function* () {
      const readAloud = yield* ReadAloud.ReadAloud;
      const reading = yield* readAloud
        .audio(audioRequest({ verbatim: true }))
        .pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      yield* Fiber.interrupt(reading);
      yield* Deferred.await(aborted);
    }).pipe(Effect.provide(harness({ client }).layer));
  });
});
