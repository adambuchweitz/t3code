import {
  createEnvironmentThreadDetailAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
} from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { makeStreamingTimelineFixture, makeThreadProjectionFixture } from "~/test-fixtures";
import type { ChatMessage } from "~/types";
import {
  advanceResponseMark,
  completedResponseId,
  isNewerResponse,
  completedRunResponse,
  latestReadAloudMessage,
  createReadAloudMessagesAtom,
} from "./readAloudMessages";

const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: MessageId.make(id),
  role: "assistant",
  text: `Response ${id}`,
  runId: RunId.make("run"),
  streaming: false,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  ...overrides,
});

it("selects finished assistant text from live detail while prompt history stays quiet", () => {
  const fixture = makeStreamingTimelineFixture("Hey Adam!");
  const projection = {
    ...makeThreadProjectionFixture(),
    visibleTurnItems: fixture.visibleTurnItems,
  };
  const state = Atom.make(
    AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(projection) }),
  );
  const details = createEnvironmentThreadDetailAtoms(() => state);
  const ref = { environmentId: EnvironmentId.make("local"), threadId: fixture.threadId };
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const messages = createReadAloudMessagesAtom(details.threadAtom(ref));
  registry.mount(messages);
  const earlier = registry.get(messages);
  expect(latestReadAloudMessage(earlier)?.text).toBe("Done");

  registry.set(
    state,
    AsyncResult.success({
      ...EMPTY_ENVIRONMENT_THREAD_STATE,
      data: Option.some({
        ...projection,
        visibleTurnItems: fixture.visibleTurnItems.map((row) =>
          row.item.type === "assistant_message" && row.item.runId === fixture.runId
            ? { ...row, item: { ...row.item, text: "Still streaming" } }
            : row,
        ),
      }),
    }),
  );
  expect(registry.get(messages)).toBe(earlier);

  registry.set(
    state,
    AsyncResult.success({
      ...EMPTY_ENVIRONMENT_THREAD_STATE,
      data: Option.some({
        ...projection,
        visibleTurnItems: fixture.visibleTurnItems.map((row) =>
          row.item.type === "assistant_message" && row.item.runId === fixture.runId
            ? { ...row, item: { ...row.item, streaming: false, status: "completed" as const } }
            : row,
        ),
      }),
    }),
  );
  expect(latestReadAloudMessage(registry.get(messages))).toMatchObject({
    id: "live-assistant",
    text: "Hey Adam!",
    runId: fixture.runId,
    streaming: false,
  });
  const quiet = registry.get(details.quietThreadAtom(ref));
  expect(
    quiet?.projection.visibleTurnItems.findLast(({ item }) => item.type === "assistant_message")
      ?.item,
  ).not.toHaveProperty("text");
});

describe("latestReadAloudMessage", () => {
  it("skips user, streaming, and blank messages after the last finished response", () => {
    const finished = message("finished");
    expect(
      latestReadAloudMessage([
        finished,
        message("question", { role: "user" }),
        message("partial", { streaming: true }),
        message("blank", { text: "  " }),
      ]),
    ).toBe(finished);
  });

  it("tells identical successive responses apart by id", () => {
    const first = message("first", { text: "Done" });
    const second = message("second", { text: "Done" });
    expect(latestReadAloudMessage([first, second])?.id).toBe(second.id);
    expect(latestReadAloudMessage([message("question", { role: "user" })])).toBeNull();
  });
});

describe("completedRunResponse", () => {
  it("waits until thread detail shows the run and its response finished", () => {
    const fixture = makeStreamingTimelineFixture("Newest response");
    const run = { id: fixture.runId, status: "completed" as const };
    const streaming = { runs: [], visibleTurnItems: fixture.visibleTurnItems };
    expect(completedRunResponse(streaming, fixture.runId)).toBeNull();
    // The shell reported completion before detail settled the message.
    const runDone = { ...streaming, runs: [run] };
    expect(completedRunResponse(runDone, fixture.runId)).toBeNull();
    const settled = {
      ...runDone,
      visibleTurnItems: fixture.visibleTurnItems.map((row) =>
        row.item.type === "assistant_message" && row.item.runId === fixture.runId
          ? { ...row, item: { ...row.item, status: "completed" as const, streaming: false } }
          : row,
      ),
    };
    expect(completedRunResponse(settled, fixture.runId)).toBe("Newest response");
    expect(completedRunResponse(settled, RunId.make("other-run"))).toBeNull();
  });
});

describe("completedResponseId", () => {
  const answer = message("answer");

  it("is the latest message once its own run has completed", () => {
    expect(completedResponseId(answer, "completed")).toBe(answer.id);
  });

  it.each(["running", "waiting", "queued", "starting"] as const)(
    "ignores interim messages while their run is %s",
    (status) => {
      expect(completedResponseId(answer, status)).toBeNull();
    },
  );

  it("never treats an interrupted or failed run's message as an answer to read", () => {
    expect(completedResponseId(answer, "interrupted")).toBeNull();
    expect(completedResponseId(answer, "failed")).toBeNull();
    expect(completedResponseId(answer, null)).toBeNull();
    expect(completedResponseId(null, "completed")).toBeNull();
  });
});

describe("response marks", () => {
  const older = { id: MessageId.make("a"), createdAt: "2026-10-20T00:00:01.000Z" };
  const newer = { id: MessageId.make("b"), createdAt: "2026-10-20T00:00:02.000Z" };

  it("treats only later responses as new, so a rewind to an older answer is not", () => {
    expect(isNewerResponse(newer, older)).toBe(true);
    expect(isNewerResponse(older, newer)).toBe(false);
    expect(isNewerResponse(newer, newer)).toBe(false);
    expect(isNewerResponse(older, null)).toBe(true);
  });

  it("never moves the mark back", () => {
    expect(advanceResponseMark(newer, older)).toBe(newer);
    expect(advanceResponseMark(older, newer)).toEqual(newer);
    expect(advanceResponseMark(null, older)).toEqual(older);
  });
});
