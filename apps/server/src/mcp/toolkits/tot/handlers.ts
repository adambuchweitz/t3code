import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TotService from "../../../tots/TotService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { TotToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(TotToolkit, {
  t3_tot_propose_charter: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      if (caller === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only a Tot's own thread can propose a charter.",
        });
      }
      const tots = yield* TotService.TotService;
      yield* tots
        .proposeCharter(caller.id, input)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
      return { status: "awaiting_approval" as const };
    }),
  ),
  t3_tot_ask_to_talk: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      if (caller === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only a Tot's own thread can ask to talk.",
        });
      }
      const tots = yield* TotService.TotService;
      yield* tots
        .askToTalk(caller.id, input)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
      return { status: "user_notified" as const };
    }),
  ),
});
