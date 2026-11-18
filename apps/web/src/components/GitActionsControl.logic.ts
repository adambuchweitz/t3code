import type {
  GitRunStackedActionResult,
  GitStackedAction,
  PullRequestChangeBreakdown,
  ReviewDiffPreviewSource,
  ReviewDiffPreviewResult,
  VcsStatusResult,
} from "@t3tools/contracts";
import { summarizeChangedFiles } from "@t3tools/shared/changedFileKind";
import { isGitButlerWorkspaceRef, isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { msg } from "gt-react";
import { m, type MessageResolver } from "../i18n/messages";
import { changeRequestTermKind } from "./pullRequest/changeRequestTerm";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import {
  changeRequestTerminologyFor,
  gitButlerDisabledReason,
  gitButlerLinkedBranch,
  gitButlerMenuItems,
  gitButlerQuickAction,
  type GitActionStatus,
  type DefaultBranchActionDialogCopy,
  type DefaultBranchConfirmableAction,
  type GitActionIconName,
  type GitDialogAction,
  vcsActionLabelText,
} from "@t3tools/client-runtime/state/vcs";

export {
  requiresDefaultBranchConfirmation,
  type DefaultBranchConfirmableAction,
  type GitActionIconName,
} from "@t3tools/client-runtime/state/vcs";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr" | "pr_candidate" | "held";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr" | "review_holds";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_commit" | "open_publish" | "open_pr" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface GitActionProgressPresentation {
  readonly status: string;
  readonly output: string | null;
  readonly startedAtMs: number | null;
}

export interface GitActionResultToastTiming {
  readonly timeout: 0;
  readonly dismissAfterVisibleMs: number | null;
}

export const GIT_ACTION_SUCCESS_VISIBLE_MS = 10_000;

export function resolveGitActionResultToastTiming(
  type: "error" | "success",
): GitActionResultToastTiming {
  return {
    timeout: 0,
    dismissAfterVisibleMs: type === "success" ? GIT_ACTION_SUCCESS_VISIBLE_MS : null,
  };
}

export function resolveGitActionProgressPresentation(
  input: {
    readonly isRunning: boolean;
    readonly operation: string | null;
    readonly currentLabel: string | null;
    readonly hookName?: string | null;
    readonly lastOutputLine: string | null;
    readonly phaseStartedAtMs: number | null;
    readonly hookStartedAtMs: number | null;
  },
  resolve: MessageResolver = m,
): GitActionProgressPresentation | null {
  if (
    !input.isRunning ||
    (input.operation !== "run_change_request" && input.operation !== "pull")
  ) {
    return null;
  }

  const currentLabel = input.currentLabel?.trim();
  const output = input.lastOutputLine?.trim();
  const isPull = input.operation === "pull";
  return {
    status:
      currentLabel && currentLabel !== "Running source control action"
        ? (vcsActionLabelText({ currentLabel, hookName: input.hookName ?? null }, resolve) ??
          currentLabel)
        : isPull
          ? resolve(msg("Pulling latest changes..."))
          : resolve(msg("Starting source control action...")),
    output: !isPull && output ? output : null,
    startedAtMs: isPull
      ? input.phaseStartedAtMs
      : (input.hookStartedAtMs ?? input.phaseStartedAtMs),
  };
}

export function formatGitActionElapsed(
  startedAtMs: number | null,
  nowMs: number,
  resolve: MessageResolver = m,
): string | null {
  if (startedAtMs === null) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) {
    return resolve(msg("{seconds}s", { seconds: elapsedSeconds }));
  }

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return resolve(msg("{minutes}m {seconds}s", { minutes, seconds }));
}

export function buildMenuItems(
  gitStatus: GitActionStatus | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
  resolve: MessageResolver = m,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (gitStatus.workspace?._tag === "gitbutler") {
    const items = gitButlerMenuItems(gitStatus, isBusy, hasPrimaryRemote, resolve);
    // A hold can stop a repository being published, so it's reviewable with no remote yet.
    return hasPrimaryRemote
      ? items
      : items.filter((item) => item.id === "commit" || item.id === "held");
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasOpenPr &&
    hasDefaultBranchDelta &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);

  const commitItem: GitActionMenuItem = {
    id: "commit",
    label: resolve(msg("Commit", { $context: "verb, git action" })),
    disabled: !canCommit,
    icon: "commit",
    kind: "open_dialog",
    dialogAction: "commit",
  };

  if (!hasPrimaryRemote) {
    return [commitItem];
  }

  const pushItem: GitActionMenuItem = {
    id: "push",
    label: resolve(msg("Push", { $context: "verb, git action" })),
    disabled: !canPush,
    icon: "push",
    kind: "open_dialog",
    dialogAction: "push",
  };

  if (hasOpenPr) {
    return [commitItem, pushItem];
  }

  return [
    commitItem,
    pushItem,
    {
      id: "pr",
      label: resolve(
        msg("Create {term, select, mr {MR} cr {change request} other {PR}}", {
          term: changeRequestTermKind(terminology),
        }),
      ),
      disabled: !canCreatePr,
      icon: "pr",
      kind: "open_dialog",
      dialogAction: "create_pr",
    },
  ];
}

export function getMenuActionDisabledReason(
  {
    item,
    gitStatus,
    isBusy,
    hasPrimaryRemote,
  }: {
    item: GitActionMenuItem;
    gitStatus: GitActionStatus | null;
    isBusy: boolean;
    hasPrimaryRemote: boolean;
  },
  resolve: MessageResolver = m,
): string | null {
  if (!item.disabled) return null;
  if (isBusy) return resolve(msg("Git action in progress."));
  if (!gitStatus) return resolve(msg("Git status is unavailable."));

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (gitStatus.workspace?._tag === "gitbutler" && item.id !== "commit") {
    return gitButlerDisabledReason(item.id, gitStatus, hasPrimaryRemote, resolve);
  }

  if (item.id === "commit") {
    if (!hasChanges) {
      return resolve(msg("Worktree is clean. Make changes before committing."));
    }
    return resolve(msg("Commit is currently unavailable."));
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return resolve(msg("Detached HEAD: check out a branch before pushing."));
    }
    if (isBehind) {
      return resolve(msg("Branch is behind upstream. Pull/rebase before pushing."));
    }
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return resolve(msg('Add an "origin" remote before pushing.'));
    }
    if (!isAhead) {
      return resolve(msg("No local commits to push."));
    }
    return resolve(msg("Push is currently unavailable."));
  }

  if (!hasBranch) {
    return resolve(
      msg(
        "Detached HEAD: check out a branch before creating a {term, select, mr {merge request} cr {change request} other {pull request}}.",
        { term: changeRequestTermKind(terminology) },
      ),
    );
  }
  if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
    return resolve(
      msg(
        'Add an "origin" remote before creating a {term, select, mr {merge request} cr {change request} other {pull request}}.',
        { term: changeRequestTermKind(terminology) },
      ),
    );
  }
  if ((gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) <= 0) {
    return resolve(
      msg(
        "No local commits to include in a {term, select, mr {merge request} cr {change request} other {pull request}}.",
        { term: changeRequestTermKind(terminology) },
      ),
    );
  }
  if (isBehind) {
    return resolve(
      msg(
        "Branch is behind upstream. Pull/rebase before creating a {term, select, mr {merge request} cr {change request} other {pull request}}.",
        { term: changeRequestTermKind(terminology) },
      ),
    );
  }
  return resolve(
    msg(
      "Create {term, select, mr {merge request} cr {change request} other {pull request}} is currently unavailable.",
      { term: changeRequestTermKind(terminology) },
    ),
  );
}

export function hasUsableGitMenuContent(input: {
  readonly menuItems: readonly GitActionMenuItem[];
  readonly canWriteSourceControl: boolean;
  readonly canPublishRepository: boolean;
  readonly hasNotice: boolean;
}): boolean {
  return (
    input.canPublishRepository ||
    input.hasNotice ||
    (input.canWriteSourceControl && input.menuItems.some((item) => !item.disabled))
  );
}

export function resolveQuickAction(
  gitStatus: GitActionStatus | null,
  isBusy: boolean,
  isDefaultRef = false,
  hasPrimaryRemote = true,
  resolve: MessageResolver = m,
): GitQuickAction {
  if (isBusy) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Git action in progress.")),
    };
  }

  if (!gitStatus) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Git status is unavailable.")),
    };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (gitStatus.workspace?._tag === "gitbutler") {
    return gitButlerQuickAction(gitStatus, hasPrimaryRemote, resolve);
  }

  if (!hasBranch) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(
        msg(
          "Create and checkout a ref before pushing or opening a {term, select, mr {merge request} cr {change request} other {pull request}}.",
          { term: changeRequestTermKind(terminology) },
        ),
      ),
    };
  }

  if (hasChanges) {
    if (isBehind || (!gitStatus.hasUpstream && !hasPrimaryRemote)) {
      return {
        label: resolve(msg("Commit", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_action",
        action: "commit",
      };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: resolve(msg("Commit & push")),
        disabled: false,
        kind: "run_action",
        action: "commit_push",
      };
    }
    return {
      label: resolve(
        msg("Commit, push & {term, select, mr {MR} cr {change request} other {PR}}", {
          term: changeRequestTermKind(terminology),
        }),
      ),
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      return {
        label: resolve(msg("Publish repository")),
        disabled: false,
        kind: "open_publish",
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return {
          label: resolve(msg("Commit", { $context: "verb, git action" })),
          disabled: true,
          kind: "show_hint",
          hint: resolve(msg("Branch is up to date. No action needed.")),
        };
      }
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: true,
        kind: "show_hint",
        hint: resolve(msg("No local commits to push.")),
      };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: resolve(
        msg("Push & create {term, select, mr {MR} cr {change request} other {PR}}", {
          term: changeRequestTermKind(terminology),
        }),
      ),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: resolve(msg("Sync ref")),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Branch has diverged from upstream. Rebase/merge first.")),
    };
  }

  if (isBehind) {
    return {
      label: resolve(msg("Pull")),
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: resolve(
        msg("Push & create {term, select, mr {MR} cr {change request} other {PR}}", {
          term: changeRequestTermKind(terminology),
        }),
      ),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Branch is up to date. No action needed.")),
    };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
    return {
      label: resolve(
        msg("Create {term, select, mr {MR} cr {change request} other {PR}}", {
          term: changeRequestTermKind(terminology),
        }),
      ),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  return {
    label: resolve(msg("Commit", { $context: "verb, git action" })),
    disabled: true,
    kind: "show_hint",
    hint: resolve(msg("Branch is up to date. No action needed.")),
  };
}

export function resolveDefaultBranchActionDialogCopy(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
    terminology: ChangeRequestTerminology;
  },
  resolve: MessageResolver = m,
): DefaultBranchActionDialogCopy {
  const branch = input.branchName;
  const term = changeRequestTermKind(input.terminology);

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: resolve(msg("Commit & push to default ref?")),
        description: resolve(
          msg(
            'This action will commit and push changes on "{branch}". You can continue on this ref or create a feature ref and run the same action there.',
            { branch },
          ),
        ),
        continueLabel: resolve(msg("Commit & push to {branch}", { branch })),
      };
    }
    return {
      title: resolve(msg("Push to default ref?")),
      description: resolve(
        msg(
          'This action will push local commits on "{branch}". You can continue on this ref or create a feature ref and run the same action there.',
          { branch },
        ),
      ),
      continueLabel: resolve(msg("Push to {branch}", { branch })),
    };
  }

  if (input.includesCommit) {
    return {
      title: resolve(
        msg(
          "Commit, push & create {term, select, mr {MR} cr {change request} other {PR}} from default ref?",
          { term },
        ),
      ),
      description: resolve(
        msg(
          'This action will commit, push, and create a {term, select, mr {merge request} cr {change request} other {pull request}} on "{branch}". You can continue on this ref or create a feature ref and run the same action there.',
          { term, branch },
        ),
      ),
      continueLabel: resolve(
        msg("Commit, push & create {term, select, mr {MR} cr {change request} other {PR}}", {
          term,
        }),
      ),
    };
  }
  return {
    title: resolve(
      msg(
        "Push & create {term, select, mr {MR} cr {change request} other {PR}} from default ref?",
        { term },
      ),
    ),
    description: resolve(
      msg(
        'This action will push local commits and create a {term, select, mr {merge request} cr {change request} other {pull request}} on "{branch}". You can continue on this ref or create a feature ref and run the same action there.',
        { term, branch },
      ),
    ),
    continueLabel: resolve(
      msg("Push & create {term, select, mr {MR} cr {change request} other {PR}}", { term }),
    ),
  };
}

/** The server names a feature branch from the commit it makes, so the action must commit changes. */
export function resolveFeatureBranchUnavailableReason(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    hasWorkingTreeChanges: boolean;
  },
  resolve: MessageResolver = m,
): string | null {
  if (!input.hasWorkingTreeChanges) {
    return resolve(
      msg(
        "There are no changes to commit, so a feature branch can't be named. Create a branch yourself or continue on {branch}.",
        { branch: input.branchName },
      ),
    );
  }
  if (input.action === "push" || input.action === "create_pr") {
    return resolve(
      msg(
        "This action doesn't commit your changes, so a feature branch can't be named. Create a branch yourself or continue on {branch}.",
        { branch: input.branchName },
      ),
    );
  }
  return null;
}

export function resolveThreadBranchUpdate(
  result: GitRunStackedActionResult,
): { branch: string } | null {
  if (result.branch.gitbutler || result.branch.status !== "created" || !result.branch.name) {
    return null;
  }

  return {
    branch: result.branch.name,
  };
}

export function resolveThreadBranchMetadataPatch(
  branch: string | null,
  expectedBranch: string | null,
): {
  branch: string | null;
  expectedBranch: string | null;
} {
  return { branch, expectedBranch };
}

export function resolveLiveThreadBranchUpdate(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
}): { branch: string | null } | null {
  if (!input.gitStatus) {
    return null;
  }

  if (input.gitStatus.refName === null && input.threadBranch !== null) {
    return null;
  }

  if (input.threadBranch === input.gitStatus.refName) {
    return null;
  }

  if (
    input.threadBranch !== null &&
    input.gitStatus.refName !== null &&
    !isTemporaryWorktreeBranch(input.threadBranch) &&
    isTemporaryWorktreeBranch(input.gitStatus.refName)
  ) {
    return null;
  }

  return {
    branch: input.gitStatus.refName,
  };
}

export type ChangesLineTotals = {
  readonly insertions: number;
  readonly deletions: number;
  /** Ref the counts compare against; `null` means they are uncommitted changes against HEAD. */
  readonly baseRef: string | null;
  /** `null` when the selected totals carry no per-file stats. */
  readonly breakdown: PullRequestChangeBreakdown;
};

// `branchChanges ?? workingTree` treats `{0,0}` as present, so a zero branch total hid a dirty
// working tree and the Changes row read +0 while Diff still showed the work.
// The Diff panel's branch comparison wins when it has file stats, so a remembered base or
// hidden whitespace reads the same in the row as in the panel.
export function resolveChangesTotals(
  status: VcsStatusResult | null | undefined,
  branchPreview?: ReviewDiffPreviewSource | null,
): ChangesLineTotals | null {
  if (branchPreview?.files) {
    let insertions = 0;
    let deletions = 0;
    for (const file of branchPreview.files) {
      insertions += file.additions;
      deletions += file.deletions;
    }
    return {
      insertions,
      deletions,
      baseRef: branchPreview.baseRef,
      breakdown: summarizeChangedFiles(branchPreview.files),
    };
  }
  if (!status) return null;
  const branch = status.branchChanges;
  const tree = { ...status.workingTree, baseRef: null };
  const selected =
    branch && (branch.insertions > 0 || branch.deletions > 0)
      ? branch
      : tree.insertions > 0 || tree.deletions > 0
        ? tree
        : (branch ?? tree);
  return {
    insertions: selected.insertions,
    deletions: selected.deletions,
    baseRef: selected.baseRef,
    breakdown:
      selected === tree
        ? summarizeChangedFiles(
            tree.files.map((file) => ({
              path: file.path,
              additions: file.insertions,
              deletions: file.deletions,
            })),
          )
        : null,
  };
}

/**
 * Changes when the workspace does. Status carries no per-branch data and cannot see a commit moved
 * between branches on a clean tree, so a run ending also counts; focus revalidation covers the rest.
 */
export function gitButlerChangesRevision(
  status: VcsStatusResult,
  latestRun: { readonly runId: string; readonly status: string } | null | undefined,
): string {
  const workspace = status.workspace?._tag === "gitbutler" ? status.workspace : null;
  return JSON.stringify([
    latestRun?.runId,
    latestRun?.status,
    status.workingTree.files.map((file) => [file.path, file.insertions, file.deletions]),
    status.branchChanges?.insertions,
    status.branchChanges?.deletions,
    workspace?.unassignedChangeCount,
    workspace?.stacks.map((stack) => [stack.branches, stack.assignedChangeCount]),
  ]);
}

export interface ChangesSummary {
  readonly label: string;
  readonly totals:
    | (Omit<ChangesLineTotals, "baseRef"> & { readonly baseRef?: string | null })
    | null;
  /** Shown instead of totals while a branch's totals load or after reading them failed. */
  readonly placeholder: string | null;
  readonly title: string | undefined;
}

export function resolveChangesSummary(
  input: {
    readonly status: VcsStatusResult | null;
    readonly linkedBranch: string | null | undefined;
    readonly branchPreview: {
      readonly data: ReviewDiffPreviewResult | null;
      readonly error: string | null;
    };
    /** The Diff panel's branch-range comparison, so the row matches the panel outside GitButler. */
    readonly combinedPreview?: ReviewDiffPreviewSource | null | undefined;
  },
  resolve: MessageResolver = m,
): ChangesSummary {
  const { status, linkedBranch, branchPreview } = input;
  const combined = resolveChangesTotals(status, input.combinedPreview);
  const changes = resolve(msg("Changes", { $context: "noun, version control changes" }));
  if (!status?.refName || !isGitButlerWorkspaceRef(status.refName)) {
    return { label: changes, totals: combined, placeholder: null, title: undefined };
  }
  const branch = gitButlerLinkedBranch(status, linkedBranch);
  if (branch === null) {
    return {
      label: resolve(
        msg("Workspace changes", { $context: "noun, changes on every applied branch" }),
      ),
      totals: combined,
      placeholder: null,
      title: linkedBranch
        ? resolve(
            msg("{branch} is not applied. These totals combine every applied branch.", {
              branch: linkedBranch,
            }),
          )
        : resolve(msg("These totals combine every applied branch.")),
    };
  }
  if (branchPreview.error !== null) {
    return {
      label: changes,
      totals: null,
      placeholder: resolve(msg("Unavailable", { $context: "change totals could not be read" })),
      title: resolve(
        msg("Could not read the changes on {branch}: {error}", {
          branch,
          error: branchPreview.error,
        }),
      ),
    };
  }
  const files = branchPreview.data?.sources[0]?.files;
  if (files === undefined) {
    return {
      label: changes,
      totals: null,
      placeholder: "…",
      title: resolve(msg("Reading the changes on {branch}…", { branch })),
    };
  }
  const unassigned =
    status.workspace?._tag === "gitbutler" ? status.workspace.unassignedChangeCount : 0;
  return {
    label: changes,
    totals: {
      insertions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      breakdown: summarizeChangedFiles(files),
    },
    placeholder: null,
    title:
      unassigned > 0
        ? resolve(
            msg(
              "{count, plural, one {Commits and assigned changes on {branch}. {count} unassigned change is not included.} other {Commits and assigned changes on {branch}. {count} unassigned changes are not included.}}",
              { branch, count: unassigned },
            ),
          )
        : resolve(msg("Commits and assigned changes on {branch}.", { branch })),
  };
}
