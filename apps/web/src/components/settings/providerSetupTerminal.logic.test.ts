import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findSignInUrls,
  resolveProviderSetupTerminalAction,
  takeFreshSignInUrl,
} from "./providerSetupTerminal.logic";

function provider(driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "unauthenticated" },
    setup: { canAuthenticate: false, canInstall: false },
    checkedAt: "2026-10-20T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const notInstalled = {
  installed: false,
  status: "error",
  auth: { status: "unknown" },
} as const;

describe("resolveProviderSetupTerminalAction", () => {
  it("offers the CLI sign-in for providers without in-app sign-in", () => {
    expect(resolveProviderSetupTerminalAction(provider("claudeAgent"), undefined, "linux")).toEqual(
      { kind: "signIn", command: "claude auth login" },
    );
    expect(resolveProviderSetupTerminalAction(provider("codex"), undefined, "darwin")).toEqual({
      kind: "signIn",
      command: "codex login",
    });
    expect(resolveProviderSetupTerminalAction(provider("opencode"), undefined, "linux")).toEqual({
      kind: "signIn",
      command: "opencode auth login",
    });
  });

  it("signs in with the instance's configured binary", () => {
    expect(
      resolveProviderSetupTerminalAction(
        provider("grok"),
        { binaryPath: "/opt/grok tools/grok" },
        "linux",
      ),
    ).toEqual({ kind: "signIn", command: "'/opt/grok tools/grok' login" });
    expect(
      resolveProviderSetupTerminalAction(
        provider("codex"),
        { binaryPath: "C:\\Tools\\codex.exe" },
        "windows",
      ),
    ).toEqual({ kind: "signIn", command: "C:\\Tools\\codex.exe login" });
  });

  it("uses the destination environment's platform for install commands", () => {
    const codex = provider("codex", notInstalled);
    expect(resolveProviderSetupTerminalAction(codex, undefined, "windows")).toEqual({
      kind: "install",
      command: "irm https://chatgpt.com/codex/install.ps1 | iex",
    });
    expect(resolveProviderSetupTerminalAction(codex, undefined, "linux")).toEqual({
      kind: "install",
      command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    });
    expect(
      resolveProviderSetupTerminalAction(provider("opencode", notInstalled), undefined, "windows"),
    ).toBeNull();
  });

  it("leaves in-app sign-in and install to the provider", () => {
    // Cursor without CURSOR_API_KEY and managed Codex sign in through T3 Code itself.
    expect(
      resolveProviderSetupTerminalAction(
        provider("cursor", { setup: { canAuthenticate: true, canInstall: false } }),
        undefined,
        "linux",
      ),
    ).toBeNull();
    expect(
      resolveProviderSetupTerminalAction(
        provider("codex", { setup: { canAuthenticate: true, canInstall: true } }),
        undefined,
        "linux",
      ),
    ).toBeNull();
    expect(
      resolveProviderSetupTerminalAction(
        provider("codex", { ...notInstalled, setup: { canAuthenticate: true, canInstall: true } }),
        undefined,
        "linux",
      ),
    ).toBeNull();
    // Cursor using an API key has nothing to sign in to.
    expect(resolveProviderSetupTerminalAction(provider("cursor"), undefined, "linux")).toBeNull();
  });

  it("offers nothing once the provider is ready, disabled, or still being checked", () => {
    for (const ready of [
      provider("claudeAgent", { auth: { status: "authenticated" } }),
      provider("claudeAgent", { enabled: false }),
      provider("claudeAgent", { installed: false, status: "warning", auth: { status: "unknown" } }),
    ]) {
      expect(resolveProviderSetupTerminalAction(ready, undefined, "linux")).toBeNull();
    }
    expect(resolveProviderSetupTerminalAction(undefined, undefined, "linux")).toBeNull();
  });
});

describe("findSignInUrls", () => {
  it("finds Claude's sign-in link inside its OSC 8 hyperlink", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
    expect(
      findSignInUrls(
        `Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\r\nPaste code here if prompted > `,
      ),
    ).toEqual([url, url]);
  });

  it("skips Codex's loopback callback server for the sign-in page", () => {
    const url =
      "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback";
    expect(
      findSignInUrls(
        `Starting local login server on http://localhost:1455.\r\nIf your browser did not open, navigate to this URL to authenticate:\r\n\r\n${url}\r\n`,
      ),
    ).toEqual([url]);
    expect(findSignInUrls("Callback at https://localhost:1455/auth \r\n")).toEqual([]);
  });

  it("waits for the rest of a link that is still arriving", () => {
    expect(findSignInUrls("visit: https://claude.com/cai/oauth/authorize?code=tr")).toEqual([]);
  });
});

describe("takeFreshSignInUrl", () => {
  it("never surfaces a link from earlier output on a later attempt", () => {
    const seen = new Set<string>();
    const first = "https://example.com/login?attempt=1";
    const beside = "https://example.com/help";
    const retry = "https://example.com/login?attempt=2";

    expect(takeFreshSignInUrl(`${first}\r\n${beside}\r\n`, seen)).toBe(first);
    // A reconnect replays the same history.
    expect(takeFreshSignInUrl(`${first}\r\n${beside}\r\n`, seen)).toBeNull();
    expect(takeFreshSignInUrl(`${first}\r\n${beside}\r\n${retry}\r\n`, seen)).toBe(retry);
  });
});
