import { MAX_TTS_TEXT_CHARS } from "@t3tools/contracts";

/**
 * Pure text helpers for read aloud. Shared between the web client (pre-send
 * clamping) and the server (fallback formatting), so the rules cannot drift.
 *
 * @module shared/readAloudText
 */

/** Matches the server cap; sourced from contracts so the two cannot drift. */
export const MAX_READ_ALOUD_CHARS = MAX_TTS_TEXT_CHARS;

export function stripMarkdownForSpeech(markdown: string): string {
  return (
    markdown
      // code fences first so inner backticks do not leak through
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
      // collapse runs of blank lines, but keep one so paragraphs pause
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export interface SpeechText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Cuts to the character cap at the nearest sentence or paragraph break so the
 * partial read ends somewhere natural instead of mid-word.
 */
export function trimToSpeechCap(
  text: string,
  maxChars: number = MAX_READ_ALOUD_CHARS,
): SpeechText {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const clipped = text.slice(0, maxChars);
  const lastSentenceEnd = clipped.lastIndexOf(". ") + 1;
  const lastNewline = clipped.lastIndexOf("\n");
  const breakIndex = Math.max(lastSentenceEnd, lastNewline);
  const result = breakIndex >= maxChars * 0.5 ? clipped.slice(0, breakIndex) : clipped;
  return { text: result.trim(), truncated: true };
}

/**
 * Strips markdown and clamps to the character cap. The deterministic fallback
 * used when no model reshapes the response.
 */
export function prepareSpeechText(markdown: string, maxChars?: number): SpeechText {
  return trimToSpeechCap(stripMarkdownForSpeech(markdown), maxChars);
}

/**
 * Clamps raw text to the character cap without stripping markdown. Used by the
 * client before sending a response to the server, where the model sees the
 * original markdown and does the speech formatting.
 */
export function clampSpeechText(markdown: string, maxChars?: number): SpeechText {
  return trimToSpeechCap(markdown, maxChars);
}
