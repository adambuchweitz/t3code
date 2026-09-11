import { describe, expect, it } from "vite-plus/test";

import { MAX_READ_ALOUD_CHARS, prepareSpeechText, stripMarkdownForSpeech } from "./readAloudText";

describe("stripMarkdownForSpeech", () => {
  it("replaces fenced code blocks with a spoken placeholder", () => {
    const result = stripMarkdownForSpeech("Before\n```ts\nconst x = 1;\n```\nAfter");
    expect(result).not.toContain("const x = 1");
    expect(result).toContain("code sample.");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  it("keeps inline code text but drops the backticks", () => {
    expect(stripMarkdownForSpeech("Run `vp test` now.")).toBe("Run vp test now.");
  });

  it("keeps link and image labels and drops the targets", () => {
    expect(stripMarkdownForSpeech("See [the docs](https://example.com/a).")).toBe("See the docs.");
    expect(stripMarkdownForSpeech("![diagram](https://example.com/a.png)")).toBe("diagram");
  });

  it("drops heading markers, list markers, and emphasis characters", () => {
    const result = stripMarkdownForSpeech("## Title\n\n- **bold** item\n1. first\n> quoted");
    expect(result).not.toContain("#");
    expect(result).not.toContain("*");
    expect(result).not.toContain(">");
    expect(result).toContain("Title");
    expect(result).toContain("bold item");
    expect(result).toContain("first");
    expect(result).toContain("quoted");
  });

  it("collapses runs of blank lines and trims", () => {
    expect(stripMarkdownForSpeech("A\n\n\n\n\nB\n")).toBe("A\n\nB");
  });
});

describe("prepareSpeechText", () => {
  it("passes short text through untouched", () => {
    const result = prepareSpeechText("A short answer.");
    expect(result).toEqual({ text: "A short answer.", truncated: false });
  });

  it("clamps long text at a sentence boundary and flags truncation", () => {
    const sentence = `${"word ".repeat(20)}end. `;
    const long = sentence.repeat(40);
    const result = prepareSpeechText(long);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(MAX_READ_ALOUD_CHARS);
    expect(result.text.endsWith(".")).toBe(true);
  });

  it("still clamps when there is no sentence or paragraph break to use", () => {
    const long = "a".repeat(MAX_READ_ALOUD_CHARS + 500);
    const result = prepareSpeechText(long);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(MAX_READ_ALOUD_CHARS);
  });
});
