import type { FleetInvokeInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class FleetService extends Context.Service<
  FleetService,
  {
    /** Runs one operation and returns its result, typed by `FleetResults[op]`. */
    readonly execute: (input: FleetInvokeInput) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  }
>()("t3/home/FleetServiceDefinition/FleetService") {}
