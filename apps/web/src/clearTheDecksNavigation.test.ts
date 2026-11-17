import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, RunId, ProviderInstanceId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { makeThreadFixture, type ThreadFixtureOverrides } from "./test-fixtures";
import { nextClearTheDecksThread } from "./clearTheDecksNavigation";

const now = "2026-10-25T12:00:00.000Z";
const environmentId = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

function thread(id: string, overrides: ThreadFixtureOverrides = {}) {
  return makeThreadFixture({ id: ThreadId.make(id), environmentId, ...overrides });
}

function findNext(current: ReturnType<typeof thread>, threads: ReturnType<typeof thread>[]) {
  const key = (item: ReturnType<typeof thread>) =>
    scopedThreadKey(scopeThreadRef(item.environmentId, item.id));
  return nextClearTheDecksThread(
    key(current),
    threads.map(key),
    new Map(threads.map((item) => [key(item), item])),
    now,
  );
}

describe("Clear the decks navigation", () => {
  it("follows sidebar order, wraps, and keeps environment identity", () => {
    const first = thread("same");
    const last = thread("same", { environmentId: remote });
    expect(findNext(first, [first, last])).toEqual(scopeThreadRef(remote, last.id));
    expect(findNext(last, [first, last])).toEqual(scopeThreadRef(environmentId, first.id));
  });

  it("skips working, snoozed, settled, and archived threads", () => {
    const current = thread("current");
    const next = thread("next");
    expect(
      findNext(current, [
        current,
        thread("working", {
          runtime: {
            status: "running",
            activeRunId: RunId.make("run"),
            updatedAt: now,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: "codex",
            lastError: null,
          },
        }),
        thread("snoozed", { snoozedUntil: "2026-10-25T13:00:00.000Z", snoozedAt: now }),
        thread("settled", { settledOverride: "settled" }),
        thread("archived", { archivedAt: now }),
        next,
      ]),
    ).toEqual(scopeThreadRef(environmentId, next.id));
  });

  it("includes a working snoozed thread when it asks for an answer", () => {
    const current = thread("current");
    const asking = thread("asking", {
      runtime: {
        status: "running",
        activeRunId: RunId.make("run"),
        updatedAt: now,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "codex",
        lastError: null,
      },
      snoozedUntil: "2026-10-25T13:00:00.000Z",
      snoozedAt: now,
      hasPendingUserInput: true,
    });
    expect(findNext(current, [current, asking])).toEqual(scopeThreadRef(environmentId, asking.id));
  });

  it("returns no target when the current thread is the only attention thread", () => {
    const current = thread("current");
    expect(
      findNext(current, [current, thread("settled", { settledOverride: "settled" })]),
    ).toBeNull();
  });

  it("never searches outside the sidebar's ordered scope", () => {
    const current = thread("current");
    const outside = thread("outside");
    const currentKey = scopedThreadKey(scopeThreadRef(environmentId, current.id));
    expect(
      nextClearTheDecksThread(
        currentKey,
        [currentKey],
        new Map([
          [currentKey, current],
          ["outside", outside],
        ]),
        now,
      ),
    ).toBeNull();
  });
});
