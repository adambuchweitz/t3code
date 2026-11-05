import { assert, describe, it } from "@effect/vitest";
import {
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatTotBriefing } from "./totHeartbeat.ts";

const selfId = ThreadId.make("tot");
const at = (minute: number) =>
  DateTime.makeUnsafe(`2026-11-05T10:${String(minute).padStart(2, "0")}:00Z`);

const thread = (
  id: string,
  updatedMinute: number,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
) =>
  ({
    id: ThreadId.make(id),
    title: id,
    status: "completed",
    activeRunId: null,
    pendingRuntimeRequest: null,
    updatedAt: at(updatedMinute),
    archivedAt: null,
    settledAt: null,
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const waiting = {
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make("request"),
    kind: "approval",
    createdAt: at(0),
  },
} as unknown as Partial<OrchestrationV2ThreadShell>;

describe("formatTotBriefing", () => {
  it("lists what changed and always what's waiting or working, but not its own thread", () => {
    const briefing = formatTotBriefing({
      selfId,
      since: at(30),
      threads: [
        thread("tot", 59),
        thread("changed", 45),
        thread("quiet", 10),
        thread("old-but-waiting", 10, waiting),
        thread("old-but-working", 10, { activeRunId: RunId.make("run") }),
        thread("archived", 45, { archivedAt: at(45) }),
      ],
    });
    assert.include(briefing, '"changed" (threadId changed): completed');
    assert.include(
      briefing,
      '"old-but-waiting" (threadId old-but-waiting): needs an answer (approval)',
    );
    assert.include(briefing, '"old-but-working" (threadId old-but-working): working');
    assert.include(briefing, "1 other threads haven't changed.");
    assert.notInclude(briefing, '"tot"');
    assert.notInclude(briefing, '"quiet"');
    assert.notInclude(briefing, '"archived"');
  });

  it("shows every open thread the first time, and leaves out settled ones", () => {
    const briefing = formatTotBriefing({
      selfId,
      since: null,
      threads: [thread("open", 1), thread("settled", 1, { settledAt: at(1) })],
    });
    assert.include(briefing, "all open ones");
    assert.include(briefing, '"open"');
    assert.notInclude(briefing, '"settled"');
  });

  it("says so when nothing changed", () => {
    assert.include(
      formatTotBriefing({ selfId, since: at(30), threads: [thread("quiet", 1)] }),
      "No thread has changed.",
    );
  });

  it("drops quiet changes first when the list is too long", () => {
    const briefing = formatTotBriefing({
      selfId,
      since: at(0),
      threads: [
        ...Array.from({ length: 35 }, (_, index) => thread(`change-${index}`, 30)),
        thread("needs-someone", 1, waiting),
      ],
    });
    assert.include(briefing, '"needs-someone"');
    assert.include(briefing, "6 more not shown");
  });
});
