import { ProviderDriverKind } from "@t3tools/contracts";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

function readConfigString(config: Readonly<Record<string, unknown>>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

export function buildProviderInstanceDriverConfig(input: {
  readonly driver: ProviderDriverKind;
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  readonly instanceId: string;
}): Record<string, unknown> | undefined {
  const config = input.config ? { ...input.config } : {};

  if (
    input.driver === CODEX_DRIVER_KIND &&
    readConfigString(config, "homePath").trim().length === 0 &&
    readConfigString(config, "shadowHomePath").trim().length === 0
  ) {
    config.shadowHomePath = `~/.codex-t3/${input.instanceId}`;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}
