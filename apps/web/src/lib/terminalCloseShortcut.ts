import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import {
  isDiffToggleShortcut,
  isTerminalCloseShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalSplitVerticalShortcut,
  isTerminalToggleShortcut,
  isThreadNavigationShortcut,
  type ShortcutEventLike,
} from "../keybindings";

type ThreadShortcutContext = NonNullable<
  NonNullable<Parameters<typeof isThreadNavigationShortcut>[2]>["context"]
>;

export interface TerminalCloseShortcutEvent extends ShortcutEventLike {
  readonly repeat?: boolean;
  readonly preventDefault: () => void;
}

function terminalCloseShortcutOptions(platform?: string) {
  return {
    ...(platform === undefined ? {} : { platform }),
    context: { terminalFocus: true, terminalOpen: true },
  };
}

export function preventTerminalCloseShortcut(
  event: TerminalCloseShortcutEvent,
  keybindings: ResolvedKeybindingsConfig,
  platform?: string,
): boolean {
  if (!isTerminalCloseShortcut(event, keybindings, terminalCloseShortcutOptions(platform))) {
    return false;
  }
  event.preventDefault();
  return true;
}

export function preventRepeatedTerminalCloseShortcut(
  event: TerminalCloseShortcutEvent,
  keybindings: ResolvedKeybindingsConfig,
  platform?: string,
): boolean {
  if (!event.repeat) return false;
  return preventTerminalCloseShortcut(event, keybindings, platform);
}

/**
 * Who handles a key pressed in a terminal: "close" (its default is already prevented, so the
 * desktop window never closes), "app" for shortcuts a thread hands back to the app, or the
 * terminal itself. An exclusive terminal sits outside a thread, so it keeps app shortcuts as input.
 */
export function routeTerminalShortcut(
  event: TerminalCloseShortcutEvent,
  keybindings: ResolvedKeybindingsConfig,
  options: {
    readonly exclusive: boolean;
    readonly platform?: string;
    /** The thread's shortcut context, so a key Sidebar would reject stays with the shell. */
    readonly threadContext?: ThreadShortcutContext;
  },
): "close" | "app" | "terminal" {
  if (preventTerminalCloseShortcut(event, keybindings, options.platform)) return "close";
  if (options.exclusive) return "terminal";
  const matchOptions = terminalCloseShortcutOptions(options.platform);
  return isTerminalToggleShortcut(event, keybindings, matchOptions) ||
    isTerminalSplitShortcut(event, keybindings, matchOptions) ||
    isTerminalSplitVerticalShortcut(event, keybindings, matchOptions) ||
    isTerminalNewShortcut(event, keybindings, matchOptions) ||
    isDiffToggleShortcut(event, keybindings, matchOptions) ||
    (options.threadContext !== undefined &&
      isThreadNavigationShortcut(event, keybindings, {
        ...(options.platform === undefined ? {} : { platform: options.platform }),
        context: { ...options.threadContext, terminalFocus: true },
      }))
    ? "app"
    : "terminal";
}
