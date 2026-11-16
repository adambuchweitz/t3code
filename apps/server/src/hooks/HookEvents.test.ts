import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type HookEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as HookEvents from "./HookEvents.ts";

const source = {
  sessionId: AuthSessionId.make("session-1"),
  sessionMethod: "browser-session-cookie" as const,
};

const focus = (threadId: string) => ({
  source,
  payload: {
    environmentId: EnvironmentId.make("environment-local"),
    threadId: ThreadId.make(threadId),
    projectId: ProjectId.make("project-1"),
    title: `Thread ${threadId}`,
    branch: "feature/hooks",
    worktreePath: "/tmp/project/.worktrees/hooks",
  },
});

const take = (events: Stream.Stream<HookEvent>, count: number) =>
  events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((collected) => collected.map((event) => event.payload.threadId)),
  );

/** Each call is a separate server run with its own boot. */
const startRun = Effect.gen(function* () {
  const services = yield* Layer.build(
    HookEvents.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
  return Context.get(services, HookEvents.HookEvents);
});

const cursorOf = (event: HookEvent) => HookEvents.parseHookCursor(event.cursor);

describe("HookEvents", () => {
  it.effect("resumes after a cursor from the same run without repeating events", () =>
    Effect.gen(function* () {
      const hooks = yield* startRun;
      yield* hooks.publishThreadFocused(focus("a"));
      const seen = yield* hooks.publishThreadFocused(focus("b"));
      yield* hooks.publishThreadFocused(focus("c"));

      const events = yield* hooks.subscribe({ after: cursorOf(seen), types: null });
      yield* hooks.publishThreadFocused(focus("d"));

      expect(yield* take(events, 2)).toEqual(["c", "d"]);
    }).pipe(Effect.scoped),
  );

  it.effect("delivers an event published between subscribing and reading exactly once", () =>
    Effect.gen(function* () {
      const hooks = yield* startRun;
      yield* hooks.publishThreadFocused(focus("before"));
      const events = yield* hooks.subscribe({ after: null, types: null });
      yield* hooks.publishThreadFocused(focus("between"));
      yield* hooks.publishThreadFocused(focus("after"));

      expect(yield* take(events, 3)).toEqual(["before", "between", "after"]);
    }).pipe(Effect.scoped),
  );

  it.effect("replays everything for a cursor from an earlier run, even one it has passed", () =>
    Effect.gen(function* () {
      const earlier = yield* startRun;
      yield* earlier.publishThreadFocused(focus("old-1"));
      yield* earlier.publishThreadFocused(focus("old-2"));
      const lastSeen = yield* earlier.publishThreadFocused(focus("old-3"));
      expect(lastSeen.sequence).toBe(3);

      const restarted = yield* startRun;
      for (const threadId of ["new-1", "new-2", "new-3", "new-4"]) {
        yield* restarted.publishThreadFocused(focus(threadId));
      }
      const events = yield* restarted.subscribe({ after: cursorOf(lastSeen), types: null });

      expect(yield* take(events, 4)).toEqual(["new-1", "new-2", "new-3", "new-4"]);
    }).pipe(Effect.scoped),
  );

  it.effect("ends a subscriber that falls a full buffer behind so it can resume", () =>
    Effect.gen(function* () {
      const hooks = yield* startRun;
      const events = yield* hooks.subscribe({ after: null, types: null });
      for (let index = 0; index <= HookEvents.HOOK_SUBSCRIBER_BUFFER_SIZE; index += 1) {
        yield* hooks.publishThreadFocused(focus(`thread-${index}`));
      }

      // The stream completes with what it buffered instead of skipping the overflow.
      const delivered = yield* Stream.runCollect(events);
      expect(delivered.map((event) => event.sequence)).toEqual(
        Array.from({ length: HookEvents.HOOK_SUBSCRIBER_BUFFER_SIZE }, (_, index) => index + 1),
      );

      const lastDelivered = delivered.at(-1);
      if (lastDelivered === undefined) return yield* Effect.die("nothing delivered");
      const resumed = yield* hooks.subscribe({ after: cursorOf(lastDelivered), types: null });
      expect(yield* take(resumed, 1)).toEqual([`thread-${HookEvents.HOOK_SUBSCRIBER_BUFFER_SIZE}`]);
    }).pipe(Effect.scoped),
  );

  it("accepts only cursors in the form it issues", () => {
    expect(HookEvents.parseHookCursor("a1b2c3d4:42")).toEqual({ boot: "a1b2c3d4", sequence: 42 });
    for (const raw of ["42", "a1b2c3d4:", ":42", "a1b2c3d4:-1", "a1b2c3d4:4.2", "a b:1"]) {
      expect(HookEvents.parseHookCursor(raw)).toBeNull();
    }
  });
});
