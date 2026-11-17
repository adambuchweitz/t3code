import { MAX_SPEECH_TEXT_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { clampSpeechText, stripMarkdownForSpeech } from "./speechText.ts";

describe("stripMarkdownForSpeech", () => {
  it("replaces fenced code with a spoken placeholder", () => {
    const result = stripMarkdownForSpeech("Before\n```ts\nconst x = 1;\n```\nAfter");
    expect(result).not.toContain("const x = 1");
    expect(result).toContain("code sample.");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  it("keeps inline code, link, and image text but drops the syntax", () => {
    expect(stripMarkdownForSpeech("Run `vp test` now.")).toBe("Run vp test now.");
    expect(stripMarkdownForSpeech("See [the docs](https://example.com/a).")).toBe("See the docs.");
    expect(stripMarkdownForSpeech("![diagram](https://example.com/a.png)")).toBe("diagram");
  });

  it("drops heading, list, quote, table, and emphasis markers", () => {
    const result = stripMarkdownForSpeech(
      "## Title\n\n- **bold** item\n1. first\n> quoted\n| alpha | 1 |",
    );
    expect(result).not.toMatch(/[#*>|]/);
    for (const word of ["Title", "bold item", "first", "quoted", "alpha"]) {
      expect(result).toContain(word);
    }
  });

  it("collapses runs of blank lines", () => {
    expect(stripMarkdownForSpeech("A\n\n\n\n\nB\n")).toBe("A\n\nB");
  });
});

describe("clampSpeechText", () => {
  it("cuts long text at a sentence boundary and flags it", () => {
    const result = clampSpeechText(`${"word ".repeat(20)}end. `.repeat(40));
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(MAX_SPEECH_TEXT_CHARS);
    expect(result.text.endsWith(".")).toBe(true);
  });

  it("cuts at the cap when there is no break to use", () => {
    const result = clampSpeechText("a".repeat(MAX_SPEECH_TEXT_CHARS + 500));
    expect(result).toEqual({ text: "a".repeat(MAX_SPEECH_TEXT_CHARS), truncated: true });
  });

  it("passes short text through", () => {
    expect(clampSpeechText("A short answer.")).toEqual({
      text: "A short answer.",
      truncated: false,
    });
  });
});
