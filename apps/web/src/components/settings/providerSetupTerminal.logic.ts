import type { ExecutionEnvironmentPlatformOs, ServerProvider } from "@t3tools/contracts";

import {
  getOnboardingProviderState,
  quoteProviderBinary,
  resolveOnboardingProviderInstallCommand,
} from "../../onboarding/providerReadiness.logic";

export interface ProviderSetupTerminalAction {
  readonly kind: "install" | "signIn";
  readonly command: string;
}

// Only CLIs whose vendors document a one-line installer. Cursor runs through its SDK and
// signs in natively; Antigravity, managed Codex, and ACP registry agents own their setup.
function installCommand(driver: string, os: ExecutionEnvironmentPlatformOs): string | null {
  if (driver === "codex" || driver === "claudeAgent") {
    return resolveOnboardingProviderInstallCommand(driver, os);
  }
  if (os === "windows" || os === "unknown") return null;
  if (driver === "opencode") return "curl -fsSL https://opencode.ai/install | bash";
  if (driver === "grok") return "curl -fsSL https://x.ai/cli/install.sh | bash";
  return null;
}

// Every CLI provider names its executable setting binaryPath; an unset or blank one means the
// default executable on PATH.
function configuredBinary(
  instanceConfig: unknown,
  fallback: string,
  os: ExecutionEnvironmentPlatformOs,
): string {
  const binaryPath =
    instanceConfig !== null &&
    typeof instanceConfig === "object" &&
    "binaryPath" in instanceConfig &&
    typeof instanceConfig.binaryPath === "string" &&
    instanceConfig.binaryPath.trim() !== ""
      ? instanceConfig.binaryPath.trim()
      : fallback;
  return quoteProviderBinary(binaryPath, fallback, os);
}

function loginCommand(
  driver: string,
  instanceConfig: unknown,
  os: ExecutionEnvironmentPlatformOs,
): string | null {
  switch (driver) {
    case "codex":
      return `${configuredBinary(instanceConfig, "codex", os)} login`;
    case "claudeAgent":
      return `${configuredBinary(instanceConfig, "claude", os)} auth login`;
    case "grok":
      return `${configuredBinary(instanceConfig, "grok", os)} login`;
    case "opencode":
      return `${configuredBinary(instanceConfig, "opencode", os)} auth login`;
    default:
      return null;
  }
}

/**
 * The terminal is a fallback for CLI-owned setup: a provider that reports in-app install or
 * sign-in keeps that flow, so the terminal never competes with it.
 */
export function resolveProviderSetupTerminalAction(
  provider: ServerProvider | undefined,
  instanceConfig: unknown,
  os: ExecutionEnvironmentPlatformOs,
): ProviderSetupTerminalAction | null {
  if (provider === undefined) return null;
  const state = getOnboardingProviderState(provider);
  if (state === "install" && provider.setup?.canInstall !== true) {
    const command = installCommand(provider.driver, os);
    return command === null ? null : { kind: "install", command };
  }
  if (state === "signIn" && provider.setup?.canAuthenticate !== true) {
    const command = loginCommand(provider.driver, instanceConfig, os);
    return command === null ? null : { kind: "signIn", command };
  }
  return null;
}

// A URL counts only once a delimiter follows it, so output split mid-URL never yields a truncated
// link. Control characters end it too: Claude prints the link as an OSC 8 target ended by BEL.
const OUTPUT_URL_PATTERN =
  /https:\/\/[^\s\u0000-\u001f\u007f"'<>`]+(?=[\s\u0000-\u001f\u007f"'<>`])/g;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Finds the pages a login CLI prints, in order. Loopback URLs are the CLI's own callback server
 * (Codex prints one first), not a page to open.
 */
export function findSignInUrls(output: string): ReadonlyArray<string> {
  const urls: string[] = [];
  for (const [candidate] of output.matchAll(OUTPUT_URL_PATTERN)) {
    if (!URL.canParse(candidate)) continue;
    if (!LOOPBACK_HOSTS.has(new URL(candidate).hostname)) urls.push(candidate);
  }
  return urls;
}

/**
 * The first link in `output` not already in `seen`. Every link is marked seen, so a link a
 * reconnect replays, or one printed beside the link that was opened, never surfaces later.
 */
export function takeFreshSignInUrl(output: string, seen: Set<string>): string | null {
  let fresh: string | null = null;
  for (const url of findSignInUrls(output)) {
    if (!seen.has(url)) fresh ??= url;
    seen.add(url);
  }
  return fresh;
}
