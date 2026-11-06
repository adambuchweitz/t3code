import { OrchestratorMcpFailure, type RuntimeRequestId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TotService from "../../../tots/TotService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertFullAccess, assertLiveCaller, readCaller } from "../../threadAccess.ts";
import { TotToolkit } from "./tools.ts";

const invalid = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/** The calling Tot, with a check that it started `threadId`. Watching a thread isn't enough. */
const readCrewCaller = Effect.fnUntraced(function* (threadId: ThreadId) {
  const context = yield* readCaller();
  const tots = yield* TotService.TotService;
  const started =
    context.caller !== undefined &&
    (yield* tots.startedBy(context.caller.id, threadId).pipe(Effect.mapError(invalid)));
  if (!started) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "A Tot can only answer approvals in threads it started.",
    });
  }
  return { context, tots };
});

const requireRequestId = (requestId: string | undefined) =>
  requestId === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({ code: "invalid_request", message: "Pass requestId." }),
      )
    : Effect.succeed(requestId);

export const layer = McpToolAccess.toLayer(TotToolkit, {
  t3_tot_watch: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { caller, threads } = yield* readCaller();
      const denied = new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Only a Tot can watch threads.",
      });
      if (caller === undefined) return yield* denied;
      if (input.threadId === caller.id) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "A Tot can't watch its own thread.",
        });
      }
      if (input.action === "watch") {
        const target = yield* threads.getThreadShell(input.threadId).pipe(Effect.mapError(invalid));
        if (target === null || target.deletedAt !== null) {
          return yield* new OrchestratorMcpFailure({
            code: "thread_not_found",
            message: "The thread was not found.",
          });
        }
      }
      const tots = yield* TotService.TotService;
      const target = { totThreadId: caller.id, threadId: input.threadId };
      const changed = yield* (
        input.action === "watch"
          ? tots.watchThread({ ...target, reason: "requested" })
          : tots.unwatchThread(target)
      ).pipe(Effect.mapError(invalid));
      if (!changed) return yield* denied;
      return { watches: yield* tots.listWatches(caller.id).pipe(Effect.mapError(invalid)) };
    }),
  ),
  t3_tot_crew_approval: McpToolAccess.either(
    (input) => input.action !== "respond",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { tots } = yield* readCrewCaller(input.threadId);
        if (input.action === "list") {
          return {
            requestIds: yield* tots
              .listCrewApprovals(input.threadId)
              .pipe(Effect.mapError(invalid)),
          };
        }
        const requestId = yield* requireRequestId(input.requestId);
        return {
          request: yield* tots
            .readCrewApproval({ threadId: input.threadId, requestId })
            .pipe(Effect.mapError(invalid)),
        };
      }),
    ),
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const { context, tots } = yield* readCrewCaller(input.threadId);
          yield* assertLiveCaller(context);
          yield* assertFullAccess(context, "A Tot answers approvals only in full-access mode.");
          const requestId = yield* requireRequestId(input.requestId);
          if (input.decision === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Pass decision.",
            });
          }
          yield* tots
            .answerCrewApproval({
              threadId: input.threadId,
              requestId: requestId as RuntimeRequestId,
              decision: input.decision,
            })
            .pipe(Effect.mapError(invalid));
          return { answered: true };
        }),
    ),
  ),
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
  t3_tot_ask_user: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      if (caller === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only a Tot's own thread can ask the user.",
        });
      }
      const tots = yield* TotService.TotService;
      const requestId = yield* tots.askUser(caller.id, input).pipe(Effect.mapError(invalid));
      return { requestId };
    }),
  ),
  t3_tot_close_request: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      if (caller === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only a Tot's own thread can close its requests.",
        });
      }
      const tots = yield* TotService.TotService;
      const closed = yield* tots
        .closeRequest(caller.id, input.requestId)
        .pipe(Effect.mapError(invalid));
      return { status: closed ? ("closed" as const) : ("already_closed" as const) };
    }),
  ),
});
