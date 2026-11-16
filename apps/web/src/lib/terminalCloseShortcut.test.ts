import { describe, expect, it } from "vite-plus/test";

import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
  routeTerminalShortcut,
  type TerminalCloseShortcutEvent,
} from "./terminalCloseShortcut";

const keybindings = [
  {
    command: "terminal.close",
    shortcut: {
      key: "w",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
    whenAst: { type: "identifier", name: "terminalFocus" },
  },
] satisfies ResolvedKeybindingsConfig;

type KeyboardEventOverrides = Partial<
  Pick<
    TerminalCloseShortcutEvent,
    "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat"
  >
>;

function keyboardEvent(
  overrides: KeyboardEventOverrides = {},
): TerminalCloseShortcutEvent & { readonly defaultPrevented: boolean } {
  let defaultPrevented = false;
  return {
    key: "w",
    code: "KeyW",
    metaKey: false,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    repeat: false,
    ...overrides,
    preventDefault: () => {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  };
}

describe("terminal close shortcut guards", () => {
  it("keeps held close repeats from closing the browser after the last terminal unmounts", () => {
    const firstPress = keyboardEvent();
    expect(preventTerminalCloseShortcut(firstPress, keybindings, "Linux x86_64")).toBe(true);

    let browserCloseCount = 0;
    for (const repeat of [true, true, true]) {
      const event = keyboardEvent({ repeat });
      preventRepeatedTerminalCloseShortcut(event, keybindings, "Linux x86_64");
      if (!event.defaultPrevented) browserCloseCount += 1;
    }

    expect(browserCloseCount).toBe(0);
    expect(preventRepeatedTerminalCloseShortcut(keyboardEvent(), keybindings, "Linux x86_64")).toBe(
      false,
    );
  });

  it("leaves a non-repeated window close and unrelated repeats alone", () => {
    const deliberateWindowClose = keyboardEvent({ repeat: false });
    const unrelatedRepeat = keyboardEvent({ key: "q", code: "KeyQ", repeat: true });

    expect(
      preventRepeatedTerminalCloseShortcut(deliberateWindowClose, keybindings, "Linux x86_64"),
    ).toBe(false);
    expect(deliberateWindowClose.defaultPrevented).toBe(false);
    expect(preventRepeatedTerminalCloseShortcut(unrelatedRepeat, keybindings, "Linux x86_64")).toBe(
      false,
    );
    expect(unrelatedRepeat.defaultPrevented).toBe(false);
  });
});

describe("routeTerminalShortcut", () => {
  const withToggle = [
    ...keybindings,
    {
      command: "terminal.toggle",
      shortcut: { ...keybindings[0]!.shortcut, key: "j" },
      whenAst: { type: "identifier", name: "terminalFocus" },
    },
  ] satisfies ResolvedKeybindingsConfig;
  const platform = "Linux x86_64";

  it("hands app shortcuts back to a thread terminal", () => {
    const toggle = keyboardEvent({ key: "j", code: "KeyJ" });
    expect(routeTerminalShortcut(toggle, withToggle, { exclusive: false, platform })).toBe("app");
    expect(
      routeTerminalShortcut(keyboardEvent({ key: "a", code: "KeyA" }), withToggle, {
        exclusive: false,
        platform,
      }),
    ).toBe("terminal");
  });

  it("keeps app shortcuts as input in an exclusive terminal", () => {
    const toggle = keyboardEvent({ key: "j", code: "KeyJ" });
    expect(routeTerminalShortcut(toggle, withToggle, { exclusive: true, platform })).toBe(
      "terminal",
    );
    expect(toggle.defaultPrevented).toBe(false);
  });

  it("still guards the window close in both kinds of terminal", () => {
    for (const exclusive of [false, true]) {
      const close = keyboardEvent();
      expect(routeTerminalShortcut(close, withToggle, { exclusive, platform })).toBe("close");
      expect(close.defaultPrevented).toBe(true);
    }
  });
});
