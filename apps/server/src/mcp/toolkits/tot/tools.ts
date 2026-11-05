import { OrchestratorMcpFailure, TotProposeCharterInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as TotService from "../../../tots/TotService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ProposeCharterTool = Tool.make("t3_tot_propose_charter", {
  description:
    "Tots only. Propose a new charter for this Tot, for the user to approve or dismiss. Replaces any unanswered proposal.",
  parameters: TotProposeCharterInput,
  success: Schema.Struct({ status: Schema.Literal("awaiting_approval") }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    TotService.TotService,
  ],
})
  .annotate(Tool.Title, "Propose a Tot charter")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, false);

export const TotToolkit = Toolkit.make(ProposeCharterTool);
