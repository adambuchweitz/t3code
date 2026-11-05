import {
  OrchestratorMcpFailure,
  ThreadId,
  TotAskToTalkInput,
  TotCrewApprovalInput,
  TotProposeCharterInput,
  TotWatchInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as TotService from "../../../tots/TotService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  TotService.TotService,
];

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

const WatchTool = Tool.make("t3_tot_watch", {
  description:
    "Tots only. Wake when another thread on this machine finishes, fails, asks a question or needs approval, or stop. Threads you start are already watched. Returns everything you watch.",
  parameters: TotWatchInput,
  success: Schema.Struct({
    watches: Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        reason: Schema.Literals(["launched", "requested"]),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Watch a thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, false);

const CrewApprovalTool = Tool.make("t3_tot_crew_approval", {
  description:
    "Tots only, for threads you started. list: pending approval ids. read: what one asks, by `requestId`. respond: answer it with `decision`, only when the user or your charter allows it.",
  parameters: TotCrewApprovalInput,
  success: Schema.Struct({
    requestIds: Schema.optional(Schema.Array(Schema.String)),
    request: Schema.optional(
      Schema.Struct({
        requestKind: Schema.String,
        prompt: Schema.NullOr(Schema.String),
        appName: Schema.NullOr(Schema.String),
      }),
    ),
    answered: Schema.optional(Schema.Boolean),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Answer a crew approval")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true);

export const TotToolkit = Toolkit.make(
  ProposeCharterTool,
  AskToTalkTool,
  WatchTool,
  CrewApprovalTool,
);
