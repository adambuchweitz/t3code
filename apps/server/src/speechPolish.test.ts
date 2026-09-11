import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { MAX_TTS_TEXT_CHARS, TextGenerationError } from "@t3tools/contracts";

import { ServerSettingsService, layerTest } from "./serverSettings.ts";
import { SpeechCache } from "./speechCache.ts";
import { polishSpeechTextOrNull } from "./speechPolish.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";

const failingTextGeneration = Layer.succeed(
  TextGeneration.TextGeneration,
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () => Effect.die("not used"),
    generatePrContent: () => Effect.die("not used"),
    generateBranchName: () => Effect.die("not used"),
    generateThreadTitle: () => Effect.die("not used"),
    generateSpeechText: () =>
      Effect.fail(new TextGenerationError({ operation: "generateSpeechText", detail: "no model" })),
  }),
);

const stubSpeechGeneration = (speech: string) =>
  Layer.succeed(
    TextGeneration.TextGeneration,
    TextGeneration.TextGeneration.of({
      generateCommitMessage: () => Effect.die("not used"),
      generatePrContent: () => Effect.die("not used"),
      generateBranchName: () => Effect.die("not used"),
      generateThreadTitle: () => Effect.die("not used"),
      generateSpeechText: (input) => {
        expect(input.message).toBe("fenced response");
        return Effect.succeed({ speech });
      },
    }),
  );

// Pass-through cache so these tests exercise the polish path, not persistence.
const passThroughCache = Layer.succeed(
  SpeechCache,
  SpeechCache.of({
    polished: (_key, lookup) => lookup,
  }),
);

const settingsLayer = layerTest();

describe("polishSpeechTextOrNull", () => {
  it.effect("returns polished prose capped at the TTS budget", () =>
    Effect.gen(function* () {
      const longSpeech = "spoken words. ".repeat(MAX_TTS_TEXT_CHARS);
      const result = yield* polishSpeechTextOrNull("fenced response").pipe(
        Effect.provide(
          Layer.mergeAll(settingsLayer, stubSpeechGeneration(longSpeech), passThroughCache),
        ),
      );
      expect(result).not.toBeNull();
      expect(result!.length).toBeLessThanOrEqual(MAX_TTS_TEXT_CHARS);
    }));

  it.effect("falls back to null when no model is reachable", () =>
    Effect.gen(function* () {
      const result = yield* polishSpeechTextOrNull("fenced response").pipe(
        Effect.provide(Layer.mergeAll(settingsLayer, failingTextGeneration, passThroughCache)),
      );
      expect(result).toBeNull();
    }));

  it.effect("keeps the settings-provided model selection", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.flatMap(ServerSettingsService, (service) =>
        service.getSettings,
      );
      expect(settings.textGenerationModelSelection).toMatchObject({
        instanceId: expect.anything(),
        model: expect.anything(),
      });
    }).pipe(Effect.provide(settingsLayer)));
});
