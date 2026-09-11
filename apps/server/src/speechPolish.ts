import * as Effect from "effect/Effect";
import { MAX_TTS_TEXT_CHARS } from "@t3tools/contracts";
import { trimToSpeechCap } from "@t3tools/shared/readAloudText";

import { ServerSettingsService } from "./serverSettings.ts";
import { SpeechCache } from "./speechCache.ts";
import { TextGeneration } from "./textGeneration/TextGeneration.ts";

/**
 * Reshapes an assistant response into spoken prose using the same configured
 * model that thread titles use, caching the result so repeat reads skip the
 * model. Returns null when the model is unreachable so callers can fall back to
 * deterministic markdown stripping.
 *
 * @module server/speechPolish
 */

/** Bump when the speech prompt changes so cached prose is regenerated. */
const SPEECH_PROMPT_VERSION = "v1";

export const polishSpeechTextOrNull = Effect.fn("speechPolish.polishOrNull")(function* (
  message: string,
) {
  return yield* Effect.catch(
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const { textGenerationModelSelection } = yield* settings.getSettings;
      const textGeneration = yield* TextGeneration;
      const cache = yield* SpeechCache;
      const key = [
        SPEECH_PROMPT_VERSION,
        textGenerationModelSelection.instanceId,
        textGenerationModelSelection.model,
        message,
      ].join("\n");

      const lookup = textGeneration
        .generateSpeechText({
          message,
          modelSelection: textGenerationModelSelection,
        })
        .pipe(
          Effect.map((generated) => trimToSpeechCap(generated.speech, MAX_TTS_TEXT_CHARS).text),
          Effect.catch((cause) =>
            Effect.logWarning("Read-aloud speech reformat failed", { cause }).pipe(Effect.as(null)),
          ),
        );

      return yield* cache.polished(key, lookup);
    }),
    (cause) =>
      Effect.logWarning("Read-aloud speech cache unavailable; skipping the reformat model", {
        cause,
      }).pipe(Effect.as(null)),
  );
});
