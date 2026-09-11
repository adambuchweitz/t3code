import type { ReadAloudTarget } from "./readAloud";
import { requestPreparedSpeechText } from "./readAloud";

/**
 * Warms the server's reformatted-text cache without synthesizing audio, so the
 * first play skips the reformat model. Audio is never cached; it streams.
 *
 * @module web/readAloudPrefetch
 */
export async function prefetchReadAloudText(
  text: string,
  target: ReadAloudTarget,
): Promise<boolean> {
  try {
    await requestPreparedSpeechText(text, target, null);
    return true;
  } catch {
    return false;
  }
}
