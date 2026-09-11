import * as Effect from "effect/Effect";
import { prepareSpeechText } from "@t3tools/shared/readAloudText";

import { polishSpeechTextOrNull } from "./speechPolish.ts";
import { synthesizeSpeechStream } from "./tts.ts";

/**
 * Read-aloud pipeline: reformat the response for speech (cached), then stream
 * synthesized audio. Audio is never cached; it streams.
 *
 * @module server/readAloudSpeech
 */

/** Returns spoken prose for a response, falling back to deterministic stripping. */
export const resolveSpeechText = Effect.fn("readAloudSpeech.resolveText")(function* (text: string) {
  const polished = text.trim() ? yield* polishSpeechTextOrNull(text) : null;
  return polished?.trim() ? polished : prepareSpeechText(text).text;
});

export const streamReadAloudSpeech = Effect.fn("readAloudSpeech.stream")(function* (input: {
  readonly text: string;
  readonly apiKey: string;
  readonly voice: string;
}) {
  const speechText = yield* resolveSpeechText(input.text);
  return yield* synthesizeSpeechStream({
    text: speechText,
    apiKey: input.apiKey,
    voice: input.voice,
  });
});
