import {
  OrchestratorMcpFailure,
  TotAskToTalkInput,
  TotProposeCharterInput,
} from "@t3tools/contracts";
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

const AskToTalkTool = Tool.make("t3_tot_ask_to_talk", {
  description:
    "Tots only. Tell the user you need a discussion to decide what's next. They see the topic on the Tots page until they next write in this thread. Put the details and your recommendation in your message. This doesn't pause you.",
  parameters: TotAskToTalkInput,
  success: Schema.Struct({ status: Schema.Literal("user_notified") }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    TotService.TotService,
  ],
})
  .annotate(Tool.Title, "Ask the user to talk")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, false);

export const TotToolkit = Toolkit.make(ProposeCharterTool, AskToTalkTool);
