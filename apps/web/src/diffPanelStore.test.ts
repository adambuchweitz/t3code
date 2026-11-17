import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  resolveToolCallDiffTarget,
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  });

  it("keeps a tool call selection independent of checkpoints and allows returning to Git changes", () => {
    const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
    const target = {
      threadId: ThreadId.make("child"),
      itemId: TurnItemId.make("edit"),
      revision: "1",
    };
    const store = useDiffPanelStore.getState();
    store.selectToolCall(ref, target);
    store.reconcileTurnSelection(ref, []);
    expect(useDiffPanelStore.getState().byThreadKey[scopedThreadKey(ref)]).toEqual({
      kind: "tool-call",
      ...target,
    });
    store.selectGitScope(ref, "branch");
    expect(useDiffPanelStore.getState().byThreadKey[scopedThreadKey(ref)]).toEqual({
      kind: "branch",
      baseRef: null,
    });
  });

  it("refreshes a live tool-call target when its source item completes", () => {
    const target = {
      threadId: ThreadId.make("child"),
      itemId: TurnItemId.make("edit"),
      revision: "live",
    };
    const now = DateTime.makeUnsafe("2026-10-28T00:00:00Z");
    const row = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: target.threadId,
      sourceItemId: target.itemId,
      item: {
        id: target.itemId,
        threadId: target.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running" as const,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "file_change" as const,
        fileName: "a.ts",
      },
    };
    expect(resolveToolCallDiffTarget(target, [row])).toBe(target);
    const completed = {
      ...row,
      item: { ...row.item, status: "completed" as const, completedAt: now },
    };
    expect(resolveToolCallDiffTarget(target, [completed])).toEqual({
      ...target,
      revision: DateTime.formatIso(now),
    });
    expect(
      resolveToolCallDiffTarget(target, [{ ...completed, sourceThreadId: ThreadId.make("other") }]),
    ).toBe(target);
    expect(resolveToolCallDiffTarget(target, [])).toBe(target);
  });
  it("returns from a GitButler branch to the branch comparison the thread had chosen", () => {
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    store.selectGitButlerBranch(THREAD_REF, "feature/api");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "gitbutler-branch",
      branch: "feature/api",
    });

    store.selectGitScope(THREAD_REF, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "branch",
      baseRef: "origin/release",
    });
  });

  it("defaults to an applied association while preserving explicit scopes and unavailable picks", () => {
    const defaults = { gitbutlerBranch: "feature/api", appliedBranches: ["feature/api"] };
    expect(selectThreadDiffPanelSelection({}, THREAD_REF, defaults)).toEqual({
      kind: "gitbutler-branch",
      branch: "feature/api",
    });
    expect(
      selectThreadDiffPanelSelection({}, THREAD_REF, { ...defaults, appliedBranches: [] }),
    ).toEqual({
      kind: "branch",
      baseRef: null,
    });
    for (const scope of ["branch", "unstaged"] as const) {
      useDiffPanelStore.getState().selectGitScope(THREAD_REF, scope);
      expect(
        selectThreadDiffPanelSelection(
          useDiffPanelStore.getState().byThreadKey,
          THREAD_REF,
          defaults,
        ).kind,
      ).toBe(scope);
    }
    useDiffPanelStore.getState().selectGitButlerBranch(THREAD_REF, "feature/removed");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF, {
        ...defaults,
        baseRef: "origin/release",
      }),
    ).toEqual({ kind: "branch", baseRef: "origin/release" });
    expect(
      selectThreadDiffPanelSelection(
        useDiffPanelStore.getState().byThreadKey,
        THREAD_REF,
        defaults,
      ),
    ).toEqual({ kind: "branch", baseRef: null });
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF, {
        ...defaults,
        appliedBranches: ["feature/removed"],
      }),
    ).toEqual({ kind: "gitbutler-branch", branch: "feature/removed" });
  });

  it.each(["branch", "unstaged", "turn", "gitbutler-branch", "tool-call"] as const)(
    "resets a remembered %s scope to the thread default without losing the branch base",
    (scope) => {
      const store = useDiffPanelStore.getState();
      store.selectBranchBaseRef(THREAD_REF, "origin/release");
      if (scope === "turn") store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/app.ts");
      else if (scope === "gitbutler-branch")
        store.selectGitButlerBranch(THREAD_REF, "feature/other");
      else if (scope === "tool-call")
        store.selectToolCall(THREAD_REF, {
          threadId: ThreadId.make("child"),
          itemId: TurnItemId.make("edit"),
          revision: "1",
        });
      else store.selectGitScope(THREAD_REF, scope);
      expect(
        selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF).kind,
      ).toBe(scope);

      store.resetSelection(THREAD_REF);
      const { byThreadKey, branchBaseRefByThreadKey } = useDiffPanelStore.getState();
      const baseRef = branchBaseRefByThreadKey[scopedThreadKey(THREAD_REF)] ?? null;
      const defaults = {
        gitbutlerBranch: "feature/api",
        appliedBranches: ["feature/api"],
        baseRef,
      };
      expect(selectThreadDiffPanelSelection(byThreadKey, THREAD_REF, defaults)).toEqual({
        kind: "gitbutler-branch",
        branch: "feature/api",
      });
      expect(
        selectThreadDiffPanelSelection(byThreadKey, THREAD_REF, {
          ...defaults,
          appliedBranches: [],
        }),
      ).toEqual({ kind: "branch", baseRef: "origin/release" });
      expect(
        selectThreadDiffPanelSelection(byThreadKey, THREAD_REF, {
          ...defaults,
          gitbutlerBranch: null,
        }),
      ).toEqual({ kind: "branch", baseRef: "origin/release" });
      expect(selectThreadDiffPanelSelection(byThreadKey, THREAD_REF)).toEqual({
        kind: "branch",
        baseRef: null,
      });
      store.selectGitScope(THREAD_REF, "branch");
      expect(
        selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
      ).toEqual({ kind: "branch", baseRef: "origin/release" });
    },
  );

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });

  it("keeps the repository filter across turns and drops it for a requested file", () => {
    const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
    const selection = () => useDiffPanelStore.getState().byThreadKey[scopedThreadKey(ref)];
    const store = useDiffPanelStore.getState();
    store.selectTurnRepository(ref, RunId.make("run-1"), "/work/api");
    store.selectTurn(ref, RunId.make("run-2"));
    expect(selection()).toMatchObject({ turnId: "run-2", repository: "/work/api" });
    store.selectTurn(ref, RunId.make("run-2"), "web/src/index.ts");
    expect(selection()).toEqual({
      kind: "turn",
      turnId: "run-2",
      filePath: "web/src/index.ts",
      revealRequestId: 2,
    });
    store.selectTurnRepository(ref, RunId.make("run-2"), "/work/api");
    store.selectTurnRepository(ref, RunId.make("run-2"), null);
    expect(selection()).not.toHaveProperty("repository");
  });
});
