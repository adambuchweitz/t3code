import { MAX_SPEECH_TEXT_CHARS } from "@t3tools/contracts";

/**
 * Text rules for read aloud, shared so the client's pre-send clamp and the
 * server's fallback formatting cannot drift.
 *
 * @module shared/speechText
 */

/** Deterministic fallback for when no model is available to reshape a response for speech. */
export function stripMarkdownForSpeech(markdown: string): string {
  return (
    markdown
      // Fences first so their inner backticks do not leak through.
      .replace(/```[\s\S]*?```/g, " code sample. ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[*_~>|]/g, "")
      .replace(/^[-+]\s+/gm, "")
      .replace(/^\d+\.\s+/gm, "")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      // Keep one blank line so paragraphs still pause.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

interface SpeechText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Cuts to the cap at the last sentence or line break in its second half, so a
 * partial read ends somewhere natural instead of mid-word.
 */
export function clampSpeechText(text: string, maxChars = MAX_SPEECH_TEXT_CHARS): SpeechText {
  if (text.length <= maxChars) return { text, truncated: false };
  const clipped = text.slice(0, maxChars);
  const breakIndex = Math.max(clipped.lastIndexOf(". ") + 1, clipped.lastIndexOf("\n"));
  const result = breakIndex >= maxChars * 0.5 ? clipped.slice(0, breakIndex) : clipped;
  return { text: result.trim(), truncated: true };
}
