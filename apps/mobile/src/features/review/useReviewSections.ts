import { useAtomValue } from "@effect/atom-react";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";
import { msg, useMessages } from "gt-react-native";

import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { EnvironmentId, ReviewDiffPreviewSource, ThreadId } from "@t3tools/contracts";
import { gitButlerAppliedBranches } from "@t3tools/shared/git";

import { useCheckpointDiff } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";
import { lastReviewGitSectionsAtom, reviewEnvironment } from "../../state/review";
import { lastReviewTurnDiffsAtom, reviewTurnDiffText } from "../../state/reviewTurnDiffs";
import { environmentSession } from "../../state/session";
import { vcsEnvironment } from "../../state/vcs";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import {
  buildReviewSectionItems,
  getGitButlerBranchSectionId,
  getReadyReviewCheckpoints,
  getReviewSectionIdForCheckpoint,
  resolveReviewSelectedSectionId,
  reviewTurnDiffsBySectionId,
  type ReviewGitSectionKind,
  type ReviewSectionItem,
} from "./reviewModel";
import { setReviewSelectedSectionId, type ReviewCacheForThread } from "./reviewState";

const NO_GIT_SECTIONS_ATOM = Atom.make<ReadonlyArray<ReviewDiffPreviewSource>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:git-sections:null"),
);
const NO_TURN_DIFFS_ATOM = Atom.make<Readonly<Record<number, string>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:turn-diffs:null"),
);

export function useReviewSections(input: {
  readonly enabled?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly reviewCache: ReviewCacheForThread;
}) {
  const { environmentId, reviewCache, threadId } = input;
  const messages = useMessages();
  const enabled = input.enabled ?? true;
  const fileAccessSession = useEnvironmentQuery(
    environmentId === undefined ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess(
    {
      isCatalogReady: fileEnvironment.isReady,
      connection: fileEnvironment.presentation?.connection ?? null,
      session: fileAccessSession.data,
      sessionError: fileAccessSession.error,
    },
    messages,
  );
  const { canReadFiles } = fileAccess;
  const selectedThread = useSelectedThreadProjection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const { selectedThreadProject } = useThreadSelection();
  const diffPreviewQuery = (sourceKind: ReviewGitSectionKind) =>
    canReadFiles && enabled && environmentId !== undefined && selectedThreadCwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: { cwd: selectedThreadCwd, sourceKind },
        })
      : null;
  const workingTreePreview = useEnvironmentQuery(diffPreviewQuery("working-tree"));
  const branchPreview = useEnvironmentQuery(diffPreviewQuery("branch-range"));
  const gitStatus = useEnvironmentQuery(
    canReadFiles && enabled && environmentId !== undefined && selectedThreadCwd !== null
      ? vcsEnvironment.status({ environmentId, input: { cwd: selectedThreadCwd } })
      : null,
  );
  const gitButlerBranches = gitButlerAppliedBranches(gitStatus.data?.workspace);
  const associatedBranch = selectedThread?.projection.thread.gitbutlerBranch ?? null;
  const requestedSectionId =
    reviewCache.selectedSectionId ??
    (associatedBranch ? getGitButlerBranchSectionId(associatedBranch) : null);
  // Only the selected branch is diffed, so the review never runs `but diff` per branch.
  const selectedGitButlerBranch =
    gitButlerBranches.find(
      (branch) => getGitButlerBranchSectionId(branch) === requestedSectionId,
    ) ?? null;
  const gitButlerPreview = useEnvironmentQuery(
    selectedGitButlerBranch !== null &&
      canReadFiles &&
      enabled &&
      environmentId !== undefined &&
      selectedThreadCwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: { cwd: selectedThreadCwd, gitbutlerBranch: selectedGitButlerBranch },
        })
      : null,
  );
  // A chosen branch only ends on loaded status or a loaded session without read access.
  // Reconnects, grant reloads, a missing cwd, and failed status reads say nothing about
  // whether it is still applied, so it stays selected as a loading section until then.
  const gitButlerSectionPrefix = getGitButlerBranchSectionId("");
  const isFileAccessDenied =
    fileAccessSession.data !== null && fileAccessSession.error === null && !canReadFiles;
  const awaitedGitButlerBranch =
    gitStatus.data === null &&
    !isFileAccessDenied &&
    reviewCache.selectedSectionId?.startsWith(gitButlerSectionPrefix) === true
      ? reviewCache.selectedSectionId.slice(gitButlerSectionPrefix.length)
      : null;
  const lastGitSections = useAtomValue(
    environmentId !== undefined && selectedThreadCwd !== null
      ? lastReviewGitSectionsAtom(environmentId, selectedThreadCwd)
      : NO_GIT_SECTIONS_ATOM,
  );

  const gitSections = (
    [
      ["working-tree", workingTreePreview],
      ["branch-range", branchPreview],
    ] as const
  ).flatMap(([kind, preview]) =>
    (preview.data?.incomplete
      ? lastGitSections
      : (preview.data?.sources ?? lastGitSections)
    ).filter((source) => source.kind === kind),
  );

  const lastTurnDiffs = useAtomValue(
    environmentId !== undefined && threadId !== undefined
      ? lastReviewTurnDiffsAtom(environmentId, threadId)
      : NO_TURN_DIFFS_ATOM,
  );

  const readyCheckpoints = getReadyReviewCheckpoints(
    selectedThread === null ? [] : deriveThreadCheckpointSummaries(selectedThread.projection),
  );
  const checkpointBySectionId = new Map(
    readyCheckpoints.map((checkpoint) => [getReviewSectionIdForCheckpoint(checkpoint), checkpoint]),
  );
  // Turns show their last answered diff; the active turn's live query below overrides it.
  // Section ids and the selection do not depend on the live query, so they are resolved first.
  const cachedSections = buildReviewSectionItems({
    checkpoints: readyCheckpoints,
    gitSections:
      canReadFiles || fileAccess.isPending
        ? [...gitSections, ...(gitButlerPreview.data?.sources ?? [])]
        : [],
    gitButlerBranches:
      awaitedGitButlerBranch !== null
        ? [awaitedGitButlerBranch]
        : canReadFiles
          ? gitButlerBranches
          : [],
    loadingGitButlerBranch:
      awaitedGitButlerBranch !== null
        ? gitStatus.error === null && fileAccessSession.error === null
          ? awaitedGitButlerBranch
          : null
        : gitButlerPreview.isPending
          ? selectedGitButlerBranch
          : null,
    turnDiffById: reviewTurnDiffsBySectionId(readyCheckpoints, lastTurnDiffs),
    gitSectionStates: {
      "working-tree": gitSectionState(fileAccess.isPending, workingTreePreview),
      "branch-range": gitSectionState(fileAccess.isPending, branchPreview),
    },
    ...(selectedThreadProject ? { rootName: selectedThreadProject.title } : {}),
    resolve: messages,
  });
  const selectedSectionId = resolveReviewSelectedSectionId(
    cachedSections,
    reviewCache.selectedSectionId,
    associatedBranch,
  );

  const selectedCheckpoint =
    selectedSectionId === null ? undefined : checkpointBySectionId.get(selectedSectionId);
  const activeCheckpoint = selectedCheckpoint ?? readyCheckpoints[0] ?? null;
  const activeSectionId = activeCheckpoint
    ? getReviewSectionIdForCheckpoint(activeCheckpoint)
    : null;
  const activeTurnDiff = useCheckpointDiff({
    environmentId: enabled ? (environmentId ?? null) : null,
    threadId: enabled ? (threadId ?? null) : null,
    fromTurnCount:
      enabled && activeCheckpoint ? Math.max(0, activeCheckpoint.checkpointTurnCount - 1) : null,
    toTurnCount: enabled ? (activeCheckpoint?.checkpointTurnCount ?? null) : null,
    ignoreWhitespace: false,
  });
  const activeTurnDiffData = activeTurnDiff.data;
  const activeTurnDiffText = useMemo(
    () => (activeTurnDiffData == null ? null : reviewTurnDiffText(activeTurnDiffData)),
    [activeTurnDiffData],
  );

  const reviewSections = cachedSections.map((section): ReviewSectionItem => {
    if (section.kind === "turn") {
      return section.id === activeSectionId
        ? {
            ...section,
            diff: activeTurnDiffText ?? section.diff,
            isLoading: activeTurnDiff.isPending,
          }
        : section;
    }
    // Keep the selected section while its grant loads, without displaying cached host files.
    return fileAccess.isPending ? { ...section, diff: null, isLoading: true } : section;
  });
  const selectedSection =
    reviewSections.find((section) => section.id === selectedSectionId) ?? null;

  const selectedGitPreview =
    selectedSection?.kind === "working-tree"
      ? workingTreePreview
      : selectedSection?.kind === "branch-range"
        ? branchPreview
        : null;

  const refreshSelectedSection = async () => {
    if (!enabled) {
      return;
    }
    if (selectedSection?.kind === "turn") {
      activeTurnDiff.refresh();
      return;
    }
    if (selectedSection?.kind === "gitbutler-branch") {
      gitButlerPreview.refresh();
      return;
    }
    if (selectedGitPreview) {
      selectedGitPreview.refresh();
    } else {
      workingTreePreview.refresh();
      branchPreview.refresh();
    }
  };

  const selectSection = (sectionId: string) => {
    if (reviewCache.threadKey) {
      setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
    }
  };

  return {
    error:
      (awaitedGitButlerBranch === null ? null : (gitStatus.error ?? fileAccessSession.error)) ??
      (selectedGitButlerBranch === null ? null : gitButlerPreview.error) ??
      (selectedSection?.kind === "turn"
        ? activeTurnDiff.error
        : (selectedGitPreview?.error ?? null)) ??
      (selectedSection === null && !fileAccess.isPending && !canReadFiles
        ? (fileAccess.error ?? messages(msg("This connection cannot read local diffs.")))
        : null),
    isSelectedSectionPending:
      selectedSection?.kind === "turn"
        ? activeTurnDiff.isPending
        : selectedSection?.kind === "gitbutler-branch"
          ? gitButlerPreview.isPending
          : (selectedGitPreview?.isPending ?? false),
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
  };
}

function gitSectionState(
  isFileAccessPending: boolean,
  preview: { readonly isPending: boolean; readonly error: string | null },
) {
  if (isFileAccessPending || preview.isPending) return "loading";
  return preview.error === null ? null : "failed";
}
