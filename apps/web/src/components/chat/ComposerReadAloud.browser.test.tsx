import "~/index.css";

import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { makeStreamingTimelineFixture, makeThreadProjectionFixture } from "~/test-fixtures";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { ChatMessage } from "~/types";

const speech = vi.hoisted(() => ({
  request: vi.fn(),
  play: vi.fn(),
  stop: vi.fn(),
  finish: () => {},
  runStatuses: {} as Record<string, string>,
  setThread: (_projection: OrchestrationV2ThreadProjection) => {},
  // Each response is created a second after the previous one, as in a real thread.
  clock: 0,
}));
// Factories run before this file's imports, so they load what they need themselves.
vi.mock("~/hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts");
  type Settings = typeof DEFAULT_CLIENT_SETTINGS;
  return {
    useClientSettings: <T,>(select: (settings: Settings) => T) =>
      select({ ...DEFAULT_CLIENT_SETTINGS, readAloudEnabled: true }),
  };
});
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("~/rpc/atomRegistry");
  const { EnvironmentId } = await import("@t3tools/contracts");
  const thread = Atom.make<{
    environmentId: EnvironmentId;
    projection: OrchestrationV2ThreadProjection;
  } | null>(null);
  speech.setThread = (projection) =>
    appAtomRegistry.set(thread, {
      environmentId: EnvironmentId.make("local"),
      projection,
    });
  return { environmentThreadDetails: { threadAtom: () => thread } };
});
// Thread detail reports the status of the run behind the latest message.
vi.mock("~/state/entities", () => ({
  useThreadRunStatus: (_ref: unknown, runId: string | null) =>
    runId === null ? null : (speech.runStatuses[runId] ?? null),
}));
// Replaced whole: the real module reaches the live connection runtime.
vi.mock("~/lib/readAloud", async () => {
  const { clampSpeechText } = await import("@t3tools/shared/speechText");
  return { requestSpeechAudio: speech.request, clampResponse: clampSpeechText };
});
vi.mock("~/lib/audioStreamPlayer", () => ({ playAudioStream: speech.play }));

import { render } from "../../../test/render";
import { setAutoReadAloud } from "~/readAloudAutoStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { ComposerReadAloud } from "./ComposerReadAloud";

const threadRef = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("thread") };

function setup() {
  setAutoReadAloud(threadRef, false);
  speech.runStatuses = {};

  speech.clock = 0;
  speech.stop.mockReset();
  speech.request.mockReset().mockResolvedValue(new ReadableStream());
  speech.play.mockReset().mockImplementation(async () => ({
    finished: new Promise<void>((resolve) => {
      speech.finish = resolve;
    }),
    stop: speech.stop,
  }));
}

const response = (id: string, text: string, run = `run-${id}`): ChatMessage => {
  speech.clock += 1;
  const at = new Date(Date.UTC(2026, 9, 20, 0, 0, speech.clock)).toISOString();
  return {
    id: MessageId.make(id),
    role: "assistant",
    text,
    runId: RunId.make(run),
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
};

const view = (messages: ReadonlyArray<ChatMessage>, { detailLoaded = true } = {}) => {
  const fixture = makeStreamingTimelineFixture();
  const row = fixture.visibleTurnItems.find(({ item }) => item.type === "assistant_message");
  if (row?.item.type !== "assistant_message") throw new Error("Missing assistant fixture");
  const base = row.item;
  speech.setThread({
    ...makeThreadProjectionFixture(),
    visibleTurnItems: messages.map((message, position) => ({
      ...row,
      position,
      item: {
        ...base,
        messageId: message.id,
        text: message.text,
        runId: message.runId,
        streaming: message.streaming,
        startedAt: DateTime.makeUnsafe(message.createdAt),
        updatedAt: DateTime.makeUnsafe(message.updatedAt),
      },
    })),
  });
  return (
    <AppAtomRegistryProvider>
      <ComposerReadAloud threadRef={threadRef} detailLoaded={detailLoaded} />
    </AppAtomRegistryProvider>
  );
};

it("reads the latest response on request and stops it on the second press", async () => {
  setup();
  await using _screen = await render(view([response("first", "**Done.**")]));

  await userEvent.click(page.getByRole("button", { name: "Read response aloud" }));
  await expect.element(page.getByRole("button", { name: "Stop reading" })).toBeVisible();
  expect(speech.request).toHaveBeenCalledWith(
    threadRef.environmentId,
    expect.objectContaining({ text: "**Done.**", verbatim: false }),
    expect.any(AbortSignal),
  );

  await userEvent.click(page.getByRole("button", { name: "Stop reading" }));
  expect(speech.stop).toHaveBeenCalledTimes(1);
  await expect.element(page.getByRole("button", { name: "Read response aloud" })).toBeVisible();
});

it("automatically reads only responses that finish after auto read is on", async () => {
  setup();
  const earlier = response("earlier", "Already on screen.");
  speech.runStatuses = { ...speech.runStatuses, "run-earlier": "completed" };
  await using screen = await render(view([earlier]));

  await userEvent.click(
    page.getByRole("button", { name: "Read new responses aloud automatically" }),
  );
  await expect
    .element(page.getByRole("button", { name: "Stop reading new responses aloud" }))
    .toHaveAttribute("aria-pressed", "true");
  expect(speech.request).not.toHaveBeenCalled();

  speech.runStatuses = { ...speech.runStatuses, "run-newer": "completed" };
  await screen.rerender(view([earlier, response("newer", "Just finished.")]));
  await expect.element(page.getByRole("button", { name: "Stop reading" })).toBeVisible();
  expect(speech.request).toHaveBeenCalledTimes(1);
  expect(speech.request.mock.calls[0]?.[1]).toMatchObject({ text: "Just finished." });
});

it("waits for the run to complete before replacing a read or reading automatically", async () => {
  setup();
  const earlier = response("earlier", "Earlier answer.");
  speech.runStatuses = { ...speech.runStatuses, "run-earlier": "completed" };
  await using screen = await render(view([earlier]));
  await userEvent.click(
    page.getByRole("button", { name: "Read new responses aloud automatically" }),
  );
  await userEvent.click(page.getByRole("button", { name: "Read response aloud" }));
  await expect.element(page.getByRole("button", { name: "Stop reading" })).toBeVisible();
  expect(speech.request).toHaveBeenCalledTimes(1);

  // The next turn posts an interim message between tool calls and keeps working.
  speech.runStatuses = { ...speech.runStatuses, "run-next": "running" };
  const interim = response("interim", "I'll inspect the config.", "run-next");
  await screen.rerender(view([earlier, interim]));
  await expect.element(page.getByRole("button", { name: "Stop reading" })).toBeVisible();
  expect(speech.stop).not.toHaveBeenCalled();
  expect(speech.request).toHaveBeenCalledTimes(1);

  // The final answer's audio stays pending, so the control shows it is being prepared.
  speech.request.mockImplementationOnce(
    (_environmentId: unknown, _request: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  );
  speech.runStatuses = { ...speech.runStatuses, "run-next": "completed" };
  const final = response("final", "The config was missing a key.", "run-next");
  await screen.rerender(view([earlier, interim, final]));
  await expect
    .element(page.getByRole("button", { name: "Preparing speech. Select to cancel" }))
    .toBeVisible();
  expect(speech.stop).toHaveBeenCalledTimes(1);
  expect(speech.request).toHaveBeenCalledTimes(2);
  expect(speech.request.mock.calls[1]?.[1]).toMatchObject({
    text: "The config was missing a key.",
  });
});

it.each(["queued", "starting", "running"])(
  "reads an answer when its run completes while a follow-up is already %s",
  async (followUpStatus) => {
    setup();
    const earlier = response("earlier", "Earlier answer.");
    speech.runStatuses = { "run-earlier": "completed" };
    await using screen = await render(view([earlier]));
    await userEvent.click(
      page.getByRole("button", { name: "Read new responses aloud automatically" }),
    );

    // The user queued a follow-up while this turn worked, so it is the thread's newest run.
    speech.runStatuses = {
      ...speech.runStatuses,
      "run-answer": "waiting",
      "run-follow-up": followUpStatus,
    };
    const answer = response("answer", "Here is the answer.", "run-answer");
    await screen.rerender(view([earlier, answer]));
    expect(speech.request).not.toHaveBeenCalled();

    speech.runStatuses = { ...speech.runStatuses, "run-answer": "completed" };
    await screen.rerender(view([earlier, answer]));
    await expect.element(page.getByRole("button", { name: "Stop reading" })).toBeVisible();
    expect(speech.request).toHaveBeenCalledTimes(1);
    expect(speech.request.mock.calls[0]?.[1]).toMatchObject({ text: "Here is the answer." });
  },
);

it.each([false, true])(
  "keeps a manual read going when its run completes (auto read on: %s)",
  async (autoRead) => {
    setup();
    const earlier = response("earlier", "Earlier answer.");
    speech.runStatuses = { "run-earlier": "completed" };
    await using screen = await render(view([earlier]));
    if (autoRead) {
      await userEvent.click(
        page.getByRole("button", { name: "Read new responses aloud automatically" }),
      );
    }

    // The provider turn ended but the run is still checkpointing.
    speech.runStatuses = { ...speech.runStatuses, "run-answer": "waiting" };
    const answer = response("answer", "Here is the answer.", "run-answer");
    await screen.rerender(view([earlier, answer]));
    await userEvent.click(page.getByRole("button", { name: "Read response aloud" }));
    await expect.element(page.getByRole("button", { name: "Stop reading" })).toBeVisible();

    speech.runStatuses = { ...speech.runStatuses, "run-answer": "completed" };
    await screen.rerender(view([earlier, answer]));
    await expect.element(page.getByRole("button", { name: "Stop reading" })).toBeVisible();
    expect(speech.stop).not.toHaveBeenCalled();
    expect(speech.request).toHaveBeenCalledTimes(1);
  },
);

it.each([
  { name: "loads after the controls would mount", loadedAtMount: false, statusAtMount: true },
  { name: "is cached at mount", loadedAtMount: true, statusAtMount: true },
  { name: "confirms its run only after mount", loadedAtMount: true, statusAtMount: false },
])(
  "does not read a reopened thread's last answer when its history $name",
  async ({ loadedAtMount, statusAtMount }) => {
    setup();
    // Auto read stayed on while the user was away from the thread.
    setAutoReadAloud(threadRef, true);
    const heard = response("heard", "Already heard.");
    if (statusAtMount) speech.runStatuses = { "run-heard": "completed" };
    // Until detail loads, ChatView shows an empty timeline.
    await using screen = await render(
      view(loadedAtMount ? [heard] : [], { detailLoaded: loadedAtMount }),
    );

    speech.runStatuses = { "run-heard": "completed" };
    await screen.rerender(view([heard]));
    await expect
      .element(page.getByRole("button", { name: "Stop reading new responses aloud" }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Read response aloud" })).toBeVisible();
    expect(speech.request).not.toHaveBeenCalled();
  },
);

it("reads the first answer of a brand-new thread", async () => {
  setup();
  setAutoReadAloud(threadRef, true);
  await using screen = await render(view([]));

  speech.runStatuses = { "run-first": "completed" };
  await screen.rerender(view([response("first", "First answer.")]));
  await expect.element(page.getByRole("button", { name: "Stop reading" })).toBeVisible();
  expect(speech.request).toHaveBeenCalledTimes(1);
});

it("does not reread an older answer after a rewind, but reads a newer one", async () => {
  setup();
  const first = response("a", "Answer A.");
  speech.runStatuses = { "run-a": "completed" };
  await using screen = await render(view([first]));
  await userEvent.click(
    page.getByRole("button", { name: "Read new responses aloud automatically" }),
  );

  speech.runStatuses = { ...speech.runStatuses, "run-b": "completed" };
  const second = response("b", "Answer B.");
  await screen.rerender(view([first, second]));
  await expect.element(page.getByRole("button", { name: "Stop reading" })).toBeVisible();
  speech.finish();
  await expect.element(page.getByRole("button", { name: "Read response aloud" })).toBeVisible();
  expect(speech.request).toHaveBeenCalledTimes(1);

  // "Edit from here" hides B, so A is the latest response again.
  await screen.rerender(view([first]));
  await expect.element(page.getByRole("button", { name: "Read response aloud" })).toBeVisible();
  expect(speech.request).toHaveBeenCalledTimes(1);
  expect(speech.stop).not.toHaveBeenCalled();

  speech.runStatuses = { ...speech.runStatuses, "run-c": "completed" };
  await screen.rerender(view([first, response("c", "Answer C.")]));
  await expect.element(page.getByRole("button", { name: "Stop reading" })).toBeVisible();
  expect(speech.request).toHaveBeenCalledTimes(2);
  expect(speech.request.mock.calls[1]?.[1]).toMatchObject({ text: "Answer C." });
});
