import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import {
  AuthFilesystemReadScope,
  CheckpointRef,
  EnvironmentId,
  MessageId,
  ThreadId,
  RunId,
  type AuthSessionState,
  type ReviewDiffPreviewSource,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  sessionError: null as string | null,
  gitbutlerBranch: null as string | null,
  sessionAtom: {},
  gitSectionsAtom: {},
  turnDiffsAtom: {},
  gitSections: [] as ReadonlyArray<ReviewDiffPreviewSource>,
  checkpoints: [] as ReadonlyArray<ThreadCheckpointSummary>,
  statusAtom: {},
  status: null as { readonly workspace?: unknown } | null,
  // Status is a live subscription: it stays pending even after emitting.
  statusPending: true,
  statusError: null as string | null,
  cwd: "/repo" as string | null,
  branchPreview: null as {
    readonly sources: ReadonlyArray<unknown>;
    readonly generatedAt: unknown;
  } | null,
  branchError: null as string | null,
}));

vi.mock("gt-react-native", async (importOriginal) => {
  const gt = await importOriginal<typeof import("gt-react-native")>();
  return { ...gt, useGT: () => gt.mFallback, useMessages: () => gt.mFallback };
});
vi.mock("@t3tools/client-runtime/state/thread-checkpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/thread-checkpoints")>()),
  deriveThreadCheckpointSummaries: () => state.checkpoints,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === state.gitSectionsAtom
      ? state.gitSections
      : atom === state.turnDiffsAtom
        ? { 1: "diff --git a/checkpoint.ts b/checkpoint.ts" }
        : [],
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => state.sessionAtom },
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected", error: null } },
  }),
}));
vi.mock("../../state/use-thread-detail", () => ({
  useSelectedThreadProjection: () => ({
    projection: { thread: { gitbutlerBranch: state.gitbutlerBranch } },
  }),
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: state.cwd }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    if (atom === state.statusAtom) {
      return {
        data: state.status,
        error: state.statusError,
        isPending: state.statusPending,
        refresh: vi.fn(),
      };
    }
    const isBranchPreview = typeof atom === "object" && atom !== null && "gitbutlerBranch" in atom;
    if (isBranchPreview) {
      return {
        data: state.branchPreview,
        error: state.branchError,
        isPending: state.branchPreview === null && state.branchError === null,
        refresh: vi.fn(),
      };
    }
    return {
      data: atom === state.sessionAtom ? state.session : null,
      error: atom === state.sessionAtom ? state.sessionError : null,
      isPending: atom === state.sessionAtom && state.session === null,
      refresh: vi.fn(),
    };
  },
}));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { status: () => state.statusAtom },
}));
vi.mock("../../state/queries", () => ({
  useCheckpointDiff: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));
vi.mock("../../state/review", () => ({
  lastReviewGitSectionsAtom: () => state.gitSectionsAtom,
  reviewEnvironment: {
    // A branch request comes back as a marker the query mock answers from state.
    diffPreview: vi.fn((target: { input: { gitbutlerBranch?: string } }) =>
      target.input.gitbutlerBranch === undefined
        ? undefined
        : { gitbutlerBranch: target.input.gitbutlerBranch },
    ),
  },
}));
vi.mock("../../state/reviewTurnDiffs", () => ({
  lastReviewTurnDiffsAtom: () => state.turnDiffsAtom,
  reviewTurnDiffText: (diff: { readonly diff: string }) => diff.diff,
}));
// The hook is called as a plain function here, so memoization just computes its value.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: <T>(compute: () => T) => compute(),
}));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThreadProject: null }),
}));
vi.mock("./reviewState", () => ({
  setReviewSelectedSectionId: vi.fn(),
}));

import { reviewEnvironment } from "../../state/review";
import { setReviewSelectedSectionId, type ReviewCacheForThread } from "./reviewState";
import { useReviewSections } from "./useReviewSections";

beforeEach(() => {
  vi.clearAllMocks();
  state.gitSections = [];
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  state.sessionError = null;
  state.status = null;
  state.statusPending = true;
  state.statusError = null;
  state.cwd = "/repo";
  state.gitbutlerBranch = null;
  state.branchPreview = null;
  state.branchError = null;
  state.checkpoints = [
    {
      runId: RunId.make("turn-1"),
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread/1"),
      status: "ready",
      files: [],
      assistantMessageId: MessageId.make("message-1"),
      completedAt: "2026-04-01T00:00:00.000Z",
    },
  ];
});

const localDiff = "diff --git a/local.ts b/local.ts";
function makeReviewCache(
  kind: "working-tree" | "branch-range" = "working-tree",
): ReviewCacheForThread {
  state.gitSections = [
    {
      id: kind,
      kind,
      title: "Dirty worktree",
      baseRef: "HEAD",
      headRef: null,
      diff: localDiff,
      diffHash: "cached-local",
      truncated: false,
    },
  ];
  return {
    threadKey: "environment:thread",
    selectedSectionId: `git:${kind}`,
    expandedFileIdsBySection: {},
    revealedLargeFileIdsBySection: {},
    viewedFileIdsBySection: {},
  };
}

function makeInput(reviewCache = makeReviewCache()) {
  return {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    reviewCache,
  };
}

function renderSections(input: ReturnType<typeof makeInput>) {
  return useReviewSections(input);
}

const gitButlerStatus = (branches: ReadonlyArray<string>) => ({
  workspace: {
    _tag: "gitbutler",
    stacks: branches.map((branch) => ({ branches: [branch], assignedChangeCount: 0 })),
    unassignedChangeCount: 0,
  },
});
const branchDiff = "diff --git a/ui.ts b/ui.ts";

function selectingBranch(branch: string) {
  return makeInput({ ...makeReviewCache(), selectedSectionId: `git:gitbutler-branch:${branch}` });
}

it("lists applied GitButler branches from status and diffs only the selected one", () => {
  state.status = gitButlerStatus(["api", "ui"]);
  state.branchPreview = {
    generatedAt: DateTime.makeUnsafe("2026-04-01T00:00:00.000Z"),
    sources: [
      {
        id: "gitbutler-branch:ui",
        kind: "gitbutler-branch",
        title: "ui",
        baseRef: null,
        headRef: "ui",
        diff: branchDiff,
        diffHash: "ui-hash",
        truncated: false,
      },
    ],
  };
  const result = renderSections(selectingBranch("ui"));

  expect(result.reviewSections.map((section) => section.id)).toEqual([
    "turn:1",
    "git:working-tree",
    "git:gitbutler-branch:api",
    "git:gitbutler-branch:ui",
  ]);
  expect(result.selectedSection).toEqual(
    expect.objectContaining({ id: "git:gitbutler-branch:ui", diff: branchDiff }),
  );
  const branchRequests = vi
    .mocked(reviewEnvironment.diffPreview)
    .mock.calls.map(([target]) => target.input.gitbutlerBranch)
    .filter((branch) => branch !== undefined);
  expect(new Set(branchRequests)).toEqual(new Set(["ui"]));
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();
});

it("diffs the associated applied branch by default without persisting it as a user pick", () => {
  state.gitbutlerBranch = "ui";
  state.status = gitButlerStatus(["api", "ui"]);
  const input = makeInput({ ...makeReviewCache(), selectedSectionId: null });
  expect(renderSections(input).selectedSection?.id).toBe("git:gitbutler-branch:ui");
  const branches = vi
    .mocked(reviewEnvironment.diffPreview)
    .mock.calls.map(([target]) => target.input.gitbutlerBranch)
    .filter((branch) => branch !== undefined);
  expect(new Set(branches)).toEqual(new Set(["ui"]));
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();
  expect(renderSections(makeInput(makeReviewCache())).selectedSection?.id).toBe("git:working-tree");
  state.status = gitButlerStatus(["api"]);
  expect(renderSections(input).selectedSection?.id).toBe("turn:1");
});

it("shows why a selected GitButler branch could not be diffed", () => {
  state.status = gitButlerStatus(["ui"]);
  state.branchError = "GitButler could not diff ui.";
  const result = renderSections(selectingBranch("ui"));

  expect(result.error).toBe("GitButler could not diff ui.");
  expect(result.selectedSection).toEqual(
    expect.objectContaining({ id: "git:gitbutler-branch:ui", diff: null }),
  );
});

it("keeps a chosen GitButler branch until status arrives, then follows it", () => {
  const input = selectingBranch("ui");
  renderSections(input);
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();

  // Live status without the branch: the review returns to its default section.
  state.status = gitButlerStatus([]);
  const unapplied = renderSections(input);
  expect(unapplied.reviewSections.map((section) => section.id)).not.toContain(
    "git:gitbutler-branch:ui",
  );
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();

  expect(unapplied.selectedSection?.id).toBe("turn:1");

  // The stored pick returns when its branch is applied again.
  vi.mocked(setReviewSelectedSectionId).mockClear();
  state.status = gitButlerStatus(["ui"]);
  const reapplied = renderSections(input);
  expect(reapplied.selectedSection?.id).toBe("git:gitbutler-branch:ui");
  expect(reapplied.reviewSections.map((section) => section.id)).toContain(
    "git:gitbutler-branch:ui",
  );
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();
});

it("returns to the default section when the checkout stops using GitButler", () => {
  state.status = {};
  const result = renderSections(selectingBranch("ui"));
  expect(result.selectedSection?.id).toBe("turn:1");
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();
});

function loadUiBranch() {
  state.status = gitButlerStatus(["ui"]);
  state.branchPreview = {
    generatedAt: DateTime.makeUnsafe("2026-04-01T00:00:00.000Z"),
    sources: [
      {
        id: "gitbutler-branch:ui",
        kind: "gitbutler-branch",
        title: "ui",
        baseRef: null,
        headRef: "ui",
        diff: branchDiff,
        diffHash: "ui-hash",
        truncated: false,
      },
    ],
  };
}

it.each([
  ["a reconnect disables the review", false, () => ({ enabled: false })],
  ["the file grant reloads", true, () => ((state.session = null), {})],
  ["the session check fails for a moment", true, () => ((state.sessionError = "Timed out."), {})],
  ["the thread has no cwd for a moment", false, () => ((state.cwd = null), {})],
] as const)("keeps a chosen GitButler branch while %s", (_, hidesLocalFiles, interrupt) => {
  loadUiBranch();
  const input = selectingBranch("ui");
  expect(renderSections(input).selectedSection?.diff).toBe(branchDiff);

  // Status is unknown while its query is off; it is not evidence the branch is gone.
  const saved = { session: state.session };
  const overrides = interrupt();
  const interrupted = renderSections({ ...input, ...overrides });
  expect(interrupted.selectedSection).toEqual(
    expect.objectContaining({ id: "git:gitbutler-branch:ui", diff: null }),
  );
  // A failed session check is shown as that error; the other cases are still loading.
  const sessionFailed = state.sessionError !== null;
  expect(interrupted.selectedSection?.isLoading).toBe(!sessionFailed);
  expect(interrupted.error).toBe(sessionFailed ? "Timed out." : null);
  if (hidesLocalFiles) {
    expect(interrupted.reviewSections.map((section) => section.diff)).not.toContain(localDiff);
  }
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();

  state.session = saved.session ?? { authenticated: true, scopes: [AuthFilesystemReadScope] };
  state.sessionError = null;
  state.cwd = "/repo";
  state.gitbutlerBranch = null;
  const restored = renderSections(input);
  expect(restored.selectedSection).toEqual(
    expect.objectContaining({ id: "git:gitbutler-branch:ui", diff: branchDiff }),
  );
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();
});

it("keeps a chosen GitButler branch when its status read fails, and says why", () => {
  state.statusError = "Status stream failed.";
  const failed = renderSections(selectingBranch("ui"));

  expect(failed.selectedSection).toEqual(
    expect.objectContaining({ id: "git:gitbutler-branch:ui", diff: null, isLoading: false }),
  );
  expect(failed.error).toBe("Status stream failed.");
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();
});

it("drops a chosen GitButler branch once file access is denied", () => {
  loadUiBranch();
  const input = selectingBranch("ui");
  renderSections(input);

  state.session = { authenticated: true, scopes: [] };
  const denied = renderSections(input);
  expect(denied.reviewSections.map((section) => section.id)).toEqual(["turn:1"]);
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();
});
