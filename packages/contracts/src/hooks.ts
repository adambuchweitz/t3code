import * as Schema from "effect/Schema";

import { AuthSessionRole, ServerAuthSessionMethod } from "./auth.ts";
import {
  AuthSessionId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const HOOK_EVENT_TYPES = ["thread.focused"] as const;
export const HookEventType = Schema.Literal("thread.focused");
export type HookEventType = typeof HookEventType.Type;

export const HookEventSource = Schema.Struct({
  sessionId: AuthSessionId,
  role: AuthSessionRole,
  sessionMethod: ServerAuthSessionMethod,
});
export type HookEventSource = typeof HookEventSource.Type;

export const ThreadFocusedHookPayload = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadFocusedHookPayload = typeof ThreadFocusedHookPayload.Type;

export const ThreadFocusedHookClientEvent = Schema.Struct({
  type: Schema.Literal("thread.focused"),
  payload: ThreadFocusedHookPayload,
});
export type ThreadFocusedHookClientEvent = typeof ThreadFocusedHookClientEvent.Type;

export const HookClientEvent = Schema.Union([ThreadFocusedHookClientEvent]);
export type HookClientEvent = typeof HookClientEvent.Type;

export const ThreadFocusedHookEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("thread.focused"),
  occurredAt: IsoDateTime,
  source: HookEventSource,
  payload: ThreadFocusedHookPayload,
});
export type ThreadFocusedHookEvent = typeof ThreadFocusedHookEvent.Type;

export const HookEvent = Schema.Union([ThreadFocusedHookEvent]);
export type HookEvent = typeof HookEvent.Type;
