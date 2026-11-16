import * as Schema from "effect/Schema";

import { ServerAuthSessionMethod } from "./auth.ts";
import {
  AuthSessionId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const HookEventType = Schema.Literals(["thread.focused"]);
export type HookEventType = typeof HookEventType.Type;

export const HookEventSource = Schema.Struct({
  sessionId: AuthSessionId,
  sessionMethod: ServerAuthSessionMethod,
});
export type HookEventSource = typeof HookEventSource.Type;

/**
 * Clients report focus to their local environment, which may not host the thread, so the
 * payload carries the thread's own environment and the details a subscriber acts on.
 */
export const ThreadFocusedHookPayload = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadFocusedHookPayload = typeof ThreadFocusedHookPayload.Type;

/**
 * `<boot>:<sequence>`, the SSE event id. Sequences restart with the server, so the boot part
 * tells a resuming subscriber's cursor apart from the same number in a later run.
 */
export const HookEventCursor = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]+:\d+$/));
export type HookEventCursor = typeof HookEventCursor.Type;

export const ThreadFocusedHookEvent = Schema.Struct({
  version: Schema.Literal(1),
  cursor: HookEventCursor,
  sequence: NonNegativeInt,
  type: Schema.Literal("thread.focused"),
  occurredAt: IsoDateTime,
  source: HookEventSource,
  payload: ThreadFocusedHookPayload,
});
export type ThreadFocusedHookEvent = typeof ThreadFocusedHookEvent.Type;

export const HookEvent = Schema.Union([ThreadFocusedHookEvent]);
export type HookEvent = typeof HookEvent.Type;
