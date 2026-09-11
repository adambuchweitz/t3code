import { MAX_TTS_TEXT_CHARS } from "@t3tools/contracts";

/**
 * Pure text helpers for read aloud. Kept separate from the network code in
 * `readAloud.ts` so they are trivial to unit test without a browser.
 *
 * @module web/readAloudText
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
 * Strips markdown and clamps to the server's character cap. When the response
 * is too long, it cuts at the nearest sentence or paragraph break so the
 * partial read ends somewhere natural instead of mid-word.
 */
export function prepareSpeechText(markdown: string): SpeechText {
  const stripped = stripMarkdownForSpeech(markdown);
  if (stripped.length <= MAX_READ_ALOUD_CHARS) {
    return { text: stripped, truncated: false };
  }

  const clipped = stripped.slice(0, MAX_READ_ALOUD_CHARS);
  const lastSentenceEnd = clipped.lastIndexOf(". ") + 1;
  const lastNewline = clipped.lastIndexOf("\n");
  const breakIndex = Math.max(lastSentenceEnd, lastNewline);
  const text = breakIndex >= MAX_READ_ALOUD_CHARS * 0.5 ? clipped.slice(0, breakIndex) : clipped;
  return { text: text.trim(), truncated: true };
}
