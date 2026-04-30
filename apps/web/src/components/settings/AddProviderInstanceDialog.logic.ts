import { ProviderDriverKind } from "@t3tools/contracts";
import type { DriverOption } from "./providerDriverMeta";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

export function buildProviderInstanceDriverConfig(input: {
  readonly driver: ProviderDriverKind;
  readonly driverOption: DriverOption;
  readonly fieldValues: Readonly<Record<string, string>>;
  readonly instanceId: string;
}): Record<string, string> {
  const config: Record<string, string> = {};
  for (const field of input.driverOption.fields) {
    const value = (input.fieldValues[`${input.driver}:${field.key}`] ?? "").trim();
    if (value.length > 0) config[field.key] = value;
  }

  if (
    input.driver === CODEX_DRIVER_KIND &&
    config.homePath === undefined &&
    config.shadowHomePath === undefined
  ) {
    config.shadowHomePath = `~/.codex-t3/${input.instanceId}`;
  }

  return config;
}
