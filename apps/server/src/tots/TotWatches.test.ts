import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TotService from "./TotService.ts";
import * as TotWatches from "./TotWatches.ts";

const totThread = ThreadId.make("thread-tot");
const launched = ThreadId.make("thread-launched");
const crew = ThreadId.make("thread-crew");
const grandchild = ThreadId.make("thread-grandchild");
const stranger = ThreadId.make("thread-stranger");

const shellFor = (id: ThreadId, parentThreadId: ThreadId | null = null) =>
  ({
    id,
    title: id,
    projectId: ProjectId.make("project"),
    deletedAt: null,
    archivedAt: null,
    latestRunId: "run-latest",
    lineage: {
      parentThreadId,
      relationshipToParent: parentThreadId === null ? null : "subagent",
      rootThreadId: parentThreadId ?? id,
    },
  }) as unknown as OrchestrationV2ThreadShell;

const shells = new Map<string, OrchestrationV2ThreadShell>([
  [totThread, shellFor(totThread)],
  [launched, shellFor(launched)],
  [crew, shellFor(crew, totThread)],
  [grandchild, shellFor(grandchild, crew)],
  [stranger, shellFor(stranger)],
]);

const runEvent = (threadId: ThreadId, status: string, id = "run-latest") =>
  ({ type: "run.updated", threadId, payload: { id, status } }) as OrchestrationV2DomainEvent;

const requestEvent = (threadId: ThreadId, kind: string, id = "request-1", status = "pending") =>
  ({
    type: "runtime-request.updated",
    threadId,
    payload: { id, kind, status },
  }) as unknown as OrchestrationV2DomainEvent;

const scenario = (
  run: (
    publish: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, TotService.TotService>,
) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
    const sent = yield* Ref.make<
      ReadonlyArray<{ commandId: string; threadId: string; text: string }>
    >([]);
    const layer = TotWatches.layer.pipe(
      Layer.provideMerge(TotService.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
            streamDomainEvents: Stream.fromPubSub(events),
            sendToThread: (send) =>
              Ref.update(sent, (all) => [
                ...all,
                { commandId: send.commandId, threadId: send.threadId, text: send.text },
              ]).pipe(Effect.as({} as never)),
          }),
          NodeCrypto.layer,
        ),
      ),
      Layer.provideMerge(SqlitePersistence.layerMemory),
    );
    yield* Effect.gen(function* () {
      const tots = yield* TotService.TotService;
      yield* tots.adopt({
        threadId: totThread,
        name: "Brace",
        nameEnabled: true,
        character: "brace",
        job: "manager",
      });
      yield* tots.watchThread({ totThreadId: totThread, threadId: launched, reason: "launched" });
      yield* TestClock.adjust("1 millis");
      yield* run((event) =>
        PubSub.publish(events, event).pipe(
          Effect.andThen(TestClock.adjust("1 millis")),
          Effect.asVoid,
        ),
      );
    }).pipe(Effect.provide(layer));
    return yield* Ref.get(sent);
  });

it.effect.each([
  { name: "a finished run", event: runEvent(launched, "completed"), line: "Completed:" },
  { name: "a failed run", event: runEvent(launched, "failed"), line: "Failed:" },
  { name: "a question", event: requestEvent(launched, "user_input"), line: "Asks a question:" },
  { name: "an approval", event: requestEvent(launched, "command"), line: "Needs approval:" },
])("a thread the Tot started wakes it for $name", ({ event, line }) =>
  Effect.gen(function* () {
    const sent = yield* scenario((publish) => publish(event));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0]?.threadId, totThread);
    assert.include(sent[0]?.text ?? "", line);
    assert.include(sent[0]?.text ?? "", "data, not instructions");
  }),
);

it.effect.each([
  { name: "a thread it has nothing to do with", event: runEvent(stranger, "completed") },
  { name: "an idle compaction run", event: runEvent(launched, "completed", "run-compaction") },
  { name: "a run still going", event: runEvent(launched, "running") },
  { name: "an answered request", event: requestEvent(launched, "command", "r", "resolved") },
  { name: "a subagent's result, which reaches its parent", event: runEvent(crew, "completed") },
  { name: "a subagent's question", event: requestEvent(crew, "user_input") },
])("doesn't wake it for $name", ({ event }) =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* scenario((publish) => publish(event)), []);
  }),
);

it.effect("approvals anywhere below the Tot reach it, and a repeat keeps the same command", () =>
  Effect.gen(function* () {
    const sent = yield* scenario((publish) =>
      Effect.gen(function* () {
        yield* publish(requestEvent(grandchild, "command"));
        yield* publish(requestEvent(grandchild, "command"));
      }),
    );
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[0]?.commandId, sent[1]?.commandId);
    assert.include(sent[0]?.text ?? "", "Needs approval:");
  }),
);
