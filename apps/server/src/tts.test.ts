import { assert, describe, it } from "@effect/vitest";
import { MAX_TTS_TEXT_CHARS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import { synthesizeSpeech, TtsBadInputError } from "./tts.ts";

// Validation runs before the provider call, so the client must never be used.
const unusedHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die(new Error("HTTP client should not be called"))),
);

describe("tts.synthesizeSpeech", () => {
  it.effect("rejects empty text before calling the provider", () =>
    Effect.gen(function* () {
      const error = yield* synthesizeSpeech({
        text: "   ",
        apiKey: "test-key",
        voice: "alloy",
      }).pipe(Effect.flip);
      assert.instanceOf(error, TtsBadInputError);
    }).pipe(Effect.provide(unusedHttpClient)),
  );

  it.effect("rejects text over the cap before calling the provider", () =>
    Effect.gen(function* () {
      const error = yield* synthesizeSpeech({
        text: "a".repeat(MAX_TTS_TEXT_CHARS + 1),
        apiKey: "test-key",
        voice: "alloy",
      }).pipe(Effect.flip);
      assert.instanceOf(error, TtsBadInputError);
    }).pipe(Effect.provide(unusedHttpClient)),
  );
});
