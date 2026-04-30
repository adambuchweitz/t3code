import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { buildProviderInstanceDriverConfig } from "./AddProviderInstanceDialog.logic";

const codexDriver = ProviderDriverKind.make("codex");
const claudeDriver = ProviderDriverKind.make("claudeAgent");

describe("buildProviderInstanceDriverConfig", () => {
  it("defaults additional Codex instances to an isolated shadow home", () => {
    expect(
      buildProviderInstanceDriverConfig({
        driver: codexDriver,
        config: undefined,
        instanceId: "codex_work",
      }),
    ).toEqual({
      shadowHomePath: "~/.codex-t3/codex_work",
    });
  });

  it("preserves an explicit Codex home configuration", () => {
    expect(
      buildProviderInstanceDriverConfig({
        driver: codexDriver,
        config: {
          homePath: "~/.codex-work",
        },
        instanceId: "codex_work",
      }),
    ).toEqual({
      homePath: "~/.codex-work",
    });
  });

  it("does not add a shadow home for non-Codex drivers", () => {
    expect(
      buildProviderInstanceDriverConfig({
        driver: claudeDriver,
        config: undefined,
        instanceId: "claude_work",
      }),
    ).toBeUndefined();
  });
});
