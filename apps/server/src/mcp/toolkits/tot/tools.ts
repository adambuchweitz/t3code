import {
  OrchestratorMcpFailure,
  ThreadId,
  TotAskUserInput,
  TotCloseRequestInput,
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

const AskUserTool = Tool.make("t3_tot_ask_user", {
  description:
    "Tots only. Put something in front of the user: a decision, research they need to weigh in on, or a discussion you need. It stays pinned in this thread and on the Tots page until they answer it or you close it, and their answer wakes you. Several can be open at once. This doesn't pause you.",
  parameters: TotAskUserInput,
  success: Schema.Struct({ requestId: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    TotService.TotService,
  ],
})
  .annotate(Tool.Title, "Ask the user")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, false);

const CloseRequestTool = Tool.make("t3_tot_close_request", {
  description:
    "Tots only. Close one of your open requests because it was settled in conversation or no longer matters.",
  parameters: TotCloseRequestInput,
  success: Schema.Struct({ status: Schema.Literals(["closed", "already_closed"]) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Close a request to the user")
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
  AskUserTool,
  CloseRequestTool,
  WatchTool,
  CrewApprovalTool,
);
