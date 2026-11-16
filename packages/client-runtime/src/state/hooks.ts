import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createHooksEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    reportThreadFocused: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hooks:report-thread-focused",
      tag: WS_METHODS.hooksReportThreadFocused,
      // Only the newest focus matters to subscribers.
      concurrency: { mode: "latest", key: ({ environmentId }) => environmentId },
    }),
  };
}
