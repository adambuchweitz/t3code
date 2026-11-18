import {
  GitButlerForcePushConfirmationError,
  GitButlerPublicationHoldError,
  gitButlerEndHoldCommand,
  type GitButlerHeldCommit,
  type GitButlerPublicationHold,
  type GitButlerBranchChangeRequestResult,
  type GitButlerCommitFile,
  type GitButlerBranchPublication,
  type GitRunStackedActionInput,
  type GitStackedAction,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { type ChangeRequestTerminology, sourceControlClients } from "../sourceControlClients.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import { gitButlerAppliedBranches, isGitButlerWorkspaceRef } from "@t3tools/shared/git";

const isGitButlerForcePushConfirmationError = Schema.is(GitButlerForcePushConfirmationError);
const isGitButlerPublicationHoldError = Schema.is(GitButlerPublicationHoldError);

/** What the linked branch's change request lookup has answered so far. */
export type GitButlerChangeRequestLookup =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | ({ readonly status: "ready" } & GitButlerBranchChangeRequestResult);

export function gitButlerChangeRequestLookup(query: {
  readonly data: GitButlerBranchChangeRequestResult | null;
  readonly error: string | null;
}): GitButlerChangeRequestLookup {
  if (query.data !== null) return { status: "ready", ...query.data };
  return query.error === null ? { status: "loading" } : { status: "failed" };
}

/** The thread's branch when it is applied in this GitButler workspace, else null. */
export function gitButlerLinkedBranch(
  status: VcsStatusResult | null,
  linkedBranch: string | null | undefined,
): string | null {
  if (!status?.refName || !isGitButlerWorkspaceRef(status.refName) || !linkedBranch) return null;
  return gitButlerAppliedBranches(status.workspace).includes(linkedBranch) ? linkedBranch : null;
}

export type GitActionStatus = VcsStatusResult & {
  readonly changeRequestPending?: boolean;
  /** Same branch name, but nothing ties its head to this branch. Never stands in for `pr`. */
  readonly changeRequestCandidate?: NonNullable<VcsStatusResult["pr"]>;
  /** The lookup failed, so a null `pr` does not mean there is no change request. */
  readonly changeRequestLookupFailed?: boolean;
};

/**
 * Status as the linked branch sees it. Upstream counts and the change request of the synthetic
 * workspace ref describe no branch, so they never reach action logic.
 */
export function gitButlerActionStatus(
  status: VcsStatusResult | null,
  linkedBranch: string | null | undefined,
  lookup?: GitButlerChangeRequestLookup,
): GitActionStatus | null {
  if (!status?.refName || !isGitButlerWorkspaceRef(status.refName)) return status;
  const branch = gitButlerLinkedBranch(status, linkedBranch);
  const found = branch !== null && lookup?.status === "ready" ? lookup : null;
  return {
    ...status,
    refName: branch,
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: found?.association === "confirmed" ? found.pr : null,
    ...(found?.association === "candidate" && found.pr !== null
      ? { changeRequestCandidate: found.pr }
      : {}),
    ...(branch !== null && lookup?.status === "loading" ? { changeRequestPending: true } : {}),
    ...(branch !== null && lookup?.status === "failed" ? { changeRequestLookupFailed: true } : {}),
  };
}

function gitButlerPublication(status: VcsStatusResult): GitButlerBranchPublication | undefined {
  const { refName, workspace } = status;
  return refName !== null && workspace?._tag === "gitbutler"
    ? workspace.publications?.[refName]
    : undefined;
}

function gitButlerPushState(
  status: VcsStatusResult,
  resolve: MFunctionType,
): {
  readonly label: string;
  readonly disabledReason: string | null;
} {
  switch (gitButlerPublication(status)) {
    case "empty":
      return {
        label: resolve(msg("Publish branch")),
        disabledReason: resolve(msg("No commits to publish.")),
      };
    case "unpublished": {
      const remote = status.workspace?.pushRemote;
      return {
        label:
          remote === undefined
            ? resolve(msg("Publish branch"))
            : resolve(msg("Publish to {remote}", { remote })),
        disabledReason: null,
      };
    }
    case "force_required":
      return {
        label: resolve(msg("Force push", { $context: "verb, git action" })),
        disabledReason: null,
      };
    case "up_to_date":
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabledReason: resolve(msg("Branch is up to date. No commits to push.")),
      };
    case "integrated":
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabledReason: resolve(msg("Branch is already integrated into the target.")),
      };
    default:
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabledReason: null,
      };
  }
}

function hasNothingToReview(status: VcsStatusResult): boolean {
  const publication = gitButlerPublication(status);
  return publication === "empty" || publication === "integrated";
}

function gitButlerViewLabel(status: VcsStatusResult, resolve: MFunctionType): string {
  const { shortLabel } = changeRequestTerminologyFor(status);
  const number = status.pr?.number;
  return status.pr?.isDraft
    ? resolve(msg("View draft {shortLabel} #{number}", { shortLabel, number }))
    : resolve(msg("View {shortLabel} #{number}", { shortLabel, number }));
}

function gitButlerCandidateLabel(
  status: GitActionStatus,
  candidate: NonNullable<VcsStatusResult["pr"]>,
  resolve: MFunctionType,
): string {
  const { shortLabel } = changeRequestTerminologyFor(status);
  return resolve(
    msg(
      "{state, select, closed {Possible closed {shortLabel} #{number} (unconfirmed)} merged {Possible merged {shortLabel} #{number} (unconfirmed)} other {Possible {shortLabel} #{number} (unconfirmed)}}",
      { state: candidate.state, shortLabel, number: candidate.number },
    ),
  );
}

/** The change request an `open_pr` item opens; a candidate is only offered by its own item. */
export function gitButlerChangeRequestUrl(status: GitActionStatus | null): string | null {
  if (status?.pr?.state === "open") return status.pr.url;
  return status?.changeRequestCandidate?.url ?? null;
}

export interface GitButlerPublishConfirmation {
  readonly branch: string;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  /** What the retried action sends. */
  readonly approval:
    | { readonly gitbutlerForcePushApproval: string }
    | { readonly gitbutlerHoldApproval: string };
  /** Ends what's held without publishing. Empty when that isn't what's being asked. */
  readonly resolutions: readonly string[];
}

/** Whether `error` is the server asking a person to confirm something before it publishes. */
export function gitButlerPublishConfirmation(
  error: unknown,
  resolve: MFunctionType = mFallback,
): GitButlerPublishConfirmation | null {
  if (isGitButlerForcePushConfirmationError(error)) {
    return {
      branch: error.branch,
      ...gitButlerForcePushCopy(error, resolve),
      approval: { gitbutlerForcePushApproval: error.approval },
      resolutions: [],
    };
  }
  // Only an older server sends a hold that can't be ended, and it can't tell a commit another
  // server is still making from a stuck one, so its approval isn't one to offer.
  if (
    isGitButlerPublicationHoldError(error) &&
    !error.holds.some((hold) => hold.state === "interrupted" && hold.resolution === undefined)
  ) {
    return {
      branch: error.branch,
      ...gitButlerHoldCopy(error, resolve),
      approval: { gitbutlerHoldApproval: error.approval },
      resolutions: error.holds.flatMap((hold) => hold.resolution ?? []),
    };
  }
  return null;
}

/** Any commit already landed before the guard ran, so a retry only needs to send it. */
export function gitButlerForcePushRetryAction(action: GitStackedAction): GitStackedAction {
  if (action === "commit_push") return "push";
  return action === "commit_push_pr" ? "create_pr" : action;
}

export function gitButlerForcePushCopy(
  error: GitButlerForcePushConfirmationError,
  resolve: MFunctionType = mFallback,
): {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
} {
  const lines = error.targets.map((target) => {
    const ref = `${target.remote}/${target.branch}`;
    const count = target.overwrittenCommits.length;
    if (count === 0) {
      return resolve(
        msg("{ref}: replaces its pushed history with your rewritten commits.", { ref }),
      );
    }
    const commits = target.overwrittenCommits
      .slice(0, 3)
      .map((commit) => `${commit.sha.slice(0, 7)} ${commit.message.split("\n", 1)[0]}`);
    const more =
      count > commits.length
        ? [
            resolve(
              msg("{count, plural, one {and {count} more} other {and {count} more}}", {
                count: count - commits.length,
              }),
            ),
          ]
        : [];
    return resolve(
      msg(
        "{count, plural, one {{ref}: permanently removes {count} commit that this branch does not have:\n{commits}} other {{ref}: permanently removes {count} commits that this branch does not have:\n{commits}}}",
        { ref, count, commits: [...commits, ...more].join("\n") },
      ),
    );
  });
  const [only] = error.targets;
  return {
    title:
      error.targets.length === 1 && only
        ? resolve(msg("Overwrite {ref}?", { ref: `${only.remote}/${only.branch}` }))
        : resolve(
            msg(
              "{count, plural, one {Overwrite {count} remote branches?} other {Overwrite {count} remote branches?}}",
              { count: error.targets.length },
            ),
          ),
    description: [
      ...(error.staleApproval ? [resolve(msg("The remote changed after you confirmed."))] : []),
      ...lines,
      resolve(
        msg(
          "T3 Code just checked the remote, but a push made after this check can still be overwritten.",
        ),
      ),
    ].join("\n\n"),
    confirmLabel: resolve(msg("Force push", { $context: "verb, git action" })),
  };
}

function gitButlerHoldLine(hold: GitButlerPublicationHold, resolve: MFunctionType): string {
  if (hold.commitSha === null) {
    return resolve(
      msg(
        "{branch}: T3 Code stopped before checking a commit here, or could not tell whether one landed. It can't tell where that commit is now, so its changes could be on any branch. Review with `git log {branch}`.",
        { branch: hold.branch },
      ),
    );
  }
  const short = hold.commitSha.slice(0, 12);
  return hold.found
    ? resolve(
        msg(
          "{sha} on {branch}: it may hold changes you didn't choose, possibly someone else's. Review it with `git show {sha}`.",
          { sha: short, branch: hold.branch },
        ),
      )
    : resolve(
        msg(
          "{sha}, committed to {branch}: it may hold changes you didn't choose, and T3 Code can't find it on an applied branch. An uncommit, squash, or deleted branch does this, so its changes could be anywhere. Review it with `git show {sha}`.",
          { sha: short, branch: hold.branch },
        ),
      );
}

const END_HOLD_EFFECT = msg(
  "Ending a hold publishes nothing and leaves the commit where it is, but T3 Code won't ask about it again.",
);

export function gitButlerHoldCopy(
  error: GitButlerPublicationHoldError,
  resolve: MFunctionType = mFallback,
): {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
} {
  return {
    title: resolve(
      msg(
        "{count, plural, =1 {Publish a commit T3 Code couldn't confirm?} other {Publish {count} commits T3 Code couldn't confirm?}}",
        { count: error.holds.length },
      ),
    ),
    description: [
      ...(error.staleApproval ? [resolve(msg("What you reviewed has changed."))] : []),
      ...error.holds.map((hold) => gitButlerHoldLine(hold, resolve)),
      resolve(
        msg("Nothing has been pushed. {endHoldEffect}", {
          endHoldEffect: resolve(END_HOLD_EFFECT),
        }),
      ),
    ].join("\n\n"),
    confirmLabel: resolve(msg("Reviewed, publish")),
  };
}

export const GIT_BUTLER_END_HOLD_LABEL = msg("End hold, don't publish");

/** What to show someone reviewing every hold, apart from any push. */
export function gitButlerHoldReview(
  holds: readonly GitButlerHeldCommit[],
  resolve: MFunctionType = mFallback,
): {
  readonly title: string;
  readonly description: string;
  readonly resolutions: readonly string[];
} {
  if (holds.length === 0) {
    return {
      title: resolve(msg("Nothing is held")),
      description: resolve(msg("No commits are held from publishing.")),
      resolutions: [],
    };
  }
  const resolutions = holds.flatMap((hold) => hold.resolution ?? []);
  return {
    title: resolve(
      msg("{count, plural, =1 {A commit is held from publishing} other {{count} holds}}", {
        count: holds.length,
      }),
    ),
    description: [
      ...holds.map((hold) =>
        hold.possiblyRunningRef === undefined
          ? gitButlerHoldLine(hold, resolve)
          : resolve(
              msg(
                "{branch}: T3 Code can't tell whether a commit here is still being made. If a T3 Code server is making it, this clears when it finishes. If that server stopped, this won't clear by itself: make sure no `but commit` is still running in this checkout, review the branch, since a commit may have landed unchecked, then end the hold in a terminal (Git Bash on Windows) with `{command}`.",
                { branch: hold.branch, command: gitButlerEndHoldCommand(hold.possiblyRunningRef) },
              ),
            ),
      ),
      ...(resolutions.length > 0 ? [resolve(END_HOLD_EFFECT)] : []),
    ].join("\n\n"),
    resolutions,
  };
}

function gitButlerCheckingHint(status: VcsStatusResult, resolve: MFunctionType): string {
  return resolve(
    msg("Checking for an existing {shortLabel}...", {
      shortLabel: changeRequestTerminologyFor(status).shortLabel,
    }),
  );
}

/** Menu shared by clients; a change request kept in another remote still offers its own push. */
export function gitButlerMenuItems(
  status: GitActionStatus,
  isBusy: boolean,
  hasRemote: boolean,
  resolve: MFunctionType = mFallback,
): GitActionMenuItem[] {
  const { shortLabel } = changeRequestTerminologyFor(status);
  const canAct = !isBusy && status.refName !== null && hasRemote;
  const push = gitButlerPushState(status, resolve);
  return [
    {
      id: "commit",
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: isBusy || !status.hasWorkingTreeChanges,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
    {
      id: "push",
      label: push.label,
      disabled: !canAct || push.disabledReason !== null,
      icon: "push",
      kind: "open_dialog",
      dialogAction: "push",
    },
    status.pr?.state === "open"
      ? {
          id: "pr",
          label: gitButlerViewLabel(status, resolve),
          disabled: isBusy,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: resolve(msg("Create {shortLabel}", { shortLabel })),
          disabled: !canAct || status.changeRequestPending === true || hasNothingToReview(status),
          icon: "pr",
          kind: "open_dialog",
          dialogAction: "create_pr",
        },
    ...(status.changeRequestCandidate
      ? [
          {
            id: "pr_candidate" as const,
            label: gitButlerCandidateLabel(status, status.changeRequestCandidate, resolve),
            disabled: isBusy,
            icon: "pr" as const,
            kind: "open_pr" as const,
          },
        ]
      : []),
    ...(status.changeRequestLookupFailed
      ? [
          {
            id: "pr_candidate" as const,
            label: resolve(msg("Could not check for a {shortLabel}", { shortLabel })),
            disabled: true,
            icon: "pr" as const,
            kind: "open_pr" as const,
          },
        ]
      : []),
    ...(status.workspace?.heldCommitCount
      ? [
          {
            id: "held" as const,
            label: resolve(
              msg(
                "{count, plural, one {Review {count} commit held from publishing} other {Review {count} commits held from publishing}}",
                { count: status.workspace.heldCommitCount },
              ),
            ),
            disabled: false,
            icon: "push" as const,
            kind: "review_holds" as const,
          },
        ]
      : []),
  ];
}

export function gitButlerQuickAction(
  status: GitActionStatus,
  hasRemote: boolean,
  resolve: MFunctionType = mFallback,
): GitButlerQuickAction {
  // Uncommitted changes in a shared checkout may be anyone's, so a commit always starts by choosing.
  if (status.hasWorkingTreeChanges) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: false,
      kind: "open_commit",
    };
  }
  const hint = (message: string): GitButlerQuickAction => ({
    label: resolve(msg("Commit", { $context: "verb, git action" })),
    disabled: true,
    kind: "show_hint",
    hint: message,
  });
  if (status.refName === null) {
    return hint(
      resolve(
        msg("Select an applied GitButler branch to push or create a {shortLabel}.", {
          shortLabel: changeRequestTerminologyFor(status).shortLabel,
        }),
      ),
    );
  }
  if (!hasRemote) return hint(resolve(msg("Add a remote before pushing.")));

  const push = gitButlerPushState(status, resolve);
  const publication = gitButlerPublication(status);
  // These have commits only this push can deliver, whatever their change request says.
  if (publication === "ahead" || publication === "force_required") {
    return { label: push.label, disabled: false, kind: "run_action", action: "push" };
  }
  if (status.pr?.state === "open") {
    return { label: gitButlerViewLabel(status, resolve), disabled: false, kind: "open_pr" };
  }
  if (status.changeRequestPending && !hasNothingToReview(status)) {
    return hint(gitButlerCheckingHint(status, resolve));
  }
  if (push.disabledReason === null) {
    return { label: push.label, disabled: false, kind: "run_action", action: "push" };
  }
  const { shortLabel } = changeRequestTerminologyFor(status);
  const reason = push.disabledReason;
  return hint(
    status.pr
      ? resolve(
          msg(
            "{state, select, closed {{shortLabel} #{number} was closed. {reason}} merged {{shortLabel} #{number} was merged. {reason}} other {{shortLabel} #{number} was open. {reason}}}",
            { state: status.pr.state, shortLabel, number: status.pr.number, reason },
          ),
        )
      : status.changeRequestCandidate
        ? resolve(
            msg(
              "{shortLabel} #{number} may belong to this branch, but that is unconfirmed. {reason}",
              { shortLabel, number: status.changeRequestCandidate.number, reason },
            ),
          )
        : status.changeRequestLookupFailed
          ? resolve(msg("Could not check for a {shortLabel}. {reason}", { shortLabel, reason }))
          : reason,
  );
}

export function gitButlerDisabledReason(
  id: "push" | "pr" | "pr_candidate" | "held",
  status: GitActionStatus,
  hasRemote: boolean,
  resolve: MFunctionType = mFallback,
): string {
  if (id === "held") {
    return resolve(msg("Push or create a PR to review them, which also lets you continue."));
  }
  if (id === "pr_candidate") {
    return resolve(
      msg("The {shortLabel} lookup failed. It retries on the next refresh.", {
        shortLabel: changeRequestTerminologyFor(status).shortLabel,
      }),
    );
  }
  if (status.refName === null) {
    return resolve(msg("Select an applied GitButler branch for this thread."));
  }
  if (!hasRemote) return resolve(msg("Add a remote before publishing."));
  const push = gitButlerPushState(status, resolve);
  if (id === "push" || hasNothingToReview(status)) {
    return push.disabledReason ?? resolve(msg("Pushing is unavailable."));
  }
  return status.changeRequestPending
    ? gitButlerCheckingHint(status, resolve)
    : resolve(
        msg("{shortLabel} is unavailable.", {
          shortLabel: changeRequestTerminologyFor(status).shortLabel,
        }),
      );
}

export type GitActionIconName = "commit" | "push" | "pr";

export type GitDialogAction = "commit" | "push" | "create_pr";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr" | "pr_candidate" | "held";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr" | "review_holds";
  dialogAction?: GitDialogAction;
}

export interface GitButlerQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "open_commit" | "open_pr" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_commit" | "open_pr" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

export type GitActionRequestInput = Pick<
  GitRunStackedActionInput,
  | "action"
  | "commitMessage"
  | "featureBranch"
  | "filePaths"
  | "gitbutlerChangeIds"
  | "gitbutlerForcePushApproval"
  | "gitbutlerHoldApproval"
>;

export interface GitButlerCommitSelectionView {
  readonly assigned: ReadonlyArray<GitButlerCommitFile>;
  readonly shared: ReadonlyArray<GitButlerCommitFile>;
  readonly locked: ReadonlyArray<GitButlerCommitFile>;
  readonly selectedFileCount: number;
  readonly insertions: number;
  readonly deletions: number;
  /** A chosen change was edited, committed, or locked, so the choice must be made again. */
  readonly needsReview: boolean;
  readonly canCommit: boolean;
  /** A new branch has no stack, so it cannot take changes assigned to this one. */
  readonly canCommitOnNewBranch: boolean;
}

const isFileSelected = (file: GitButlerCommitFile, selected: ReadonlySet<string>) =>
  file.scope !== "locked" && file.changeIds.every((id) => selected.has(id));

export function gitButlerCommitSelectionView(
  files: ReadonlyArray<GitButlerCommitFile>,
  selected: ReadonlySet<string>,
): GitButlerCommitSelectionView {
  const selectedFiles = files.filter((file) => isFileSelected(file, selected));
  const accountedFor = selectedFiles.reduce((sum, file) => sum + file.changeIds.length, 0);
  const needsReview = accountedFor !== selected.size;
  const canCommit = selectedFiles.length > 0 && !needsReview;
  return {
    assigned: files.filter((file) => file.scope === "target"),
    shared: files.filter((file) => file.scope === "shared" || file.scope === "mixed"),
    locked: files.filter((file) => file.scope === "locked"),
    selectedFileCount: selectedFiles.length,
    insertions: selectedFiles.reduce((sum, file) => sum + file.insertions, 0),
    deletions: selectedFiles.reduce((sum, file) => sum + file.deletions, 0),
    needsReview,
    canCommit,
    canCommitOnNewBranch: canCommit && selectedFiles.every((file) => file.scope === "shared"),
  };
}

export const isGitButlerCommitFileSelected = isFileSelected;

/** Selects the files unless all of them already are. Locked files are never added. */
export function toggleGitButlerCommitFiles(
  files: ReadonlyArray<GitButlerCommitFile>,
  selected: ReadonlySet<string>,
): ReadonlySet<string> {
  const allSelected = files.every((file) => isFileSelected(file, selected));
  const next = new Set(selected);
  for (const id of files.flatMap((file) => file.changeIds)) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** Keeps only whole files that are still as they were chosen, dropping what changed. */
export function reviewedGitButlerCommitSelection(
  files: ReadonlyArray<GitButlerCommitFile>,
  selected: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    files.filter((file) => isFileSelected(file, selected)).flatMap((file) => file.changeIds),
  );
}

export function changeRequestTerminologyFor(
  gitStatus: VcsStatusResult | null,
): ChangeRequestTerminology {
  return sourceControlClients.get(gitStatus?.sourceControlProvider?.kind).changeRequest;
}

export function buildMenuItems(
  gitStatus: GitActionStatus | null,
  isBusy: boolean,
  hasOriginRemote = true,
  resolve: MFunctionType = mFallback,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (gitStatus.workspace?._tag === "gitbutler") {
    return gitButlerMenuItems(gitStatus, isBusy, hasOriginRemote, resolve);
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const canPushWithoutUpstream = hasOriginRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasOpenPr &&
    (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0 &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canOpenPr = !isBusy && hasOpenPr;

  return [
    {
      id: "commit",
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: !canCommit,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
    {
      id: "push",
      label: resolve(msg("Push", { $context: "verb, git action" })),
      disabled: !canPush,
      icon: "push",
      kind: "open_dialog",
      dialogAction: "push",
    },
    hasOpenPr
      ? {
          id: "pr",
          label: resolve(msg("View {shortLabel}", { shortLabel: terminology.shortLabel })),
          disabled: !canOpenPr,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: resolve(msg("Create {shortLabel}", { shortLabel: terminology.shortLabel })),
          disabled: !canCreatePr,
          icon: "pr",
          kind: "open_dialog",
          dialogAction: "create_pr",
        },
  ];
}

export function resolveQuickAction(
  gitStatus: GitActionStatus | null,
  isBusy: boolean,
  isDefaultBranch = false,
  hasOriginRemote = true,
  resolve: MFunctionType = mFallback,
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
    return gitButlerQuickAction(gitStatus, hasOriginRemote, resolve);
  }

  if (!hasBranch) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(
        msg(
          "{kind, select, pr {Create and checkout a branch before pushing or opening a PR.} mr {Create and checkout a branch before pushing or opening an MR.} generic {Create and checkout a branch before pushing or opening a change request.} other {Create and checkout a branch before pushing or opening {changeRequest}.}}",
          {
            kind: changeRequestKind(terminology),
            changeRequest: terminology.shortLabelWithArticle,
          },
        ),
      ),
    };
  }

  if (hasChanges) {
    if (isBehind || (!gitStatus.hasUpstream && !hasOriginRemote)) {
      return {
        label: resolve(msg("Commit", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_action",
        action: "commit",
      };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: resolve(msg("Commit & push")),
        disabled: false,
        kind: "run_action",
        action: "commit_push",
      };
    }
    return {
      label: resolve(msg("Commit, push & {shortLabel}", { shortLabel: terminology.shortLabel })),
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasOriginRemote) {
      if (hasOpenPr && !isAhead) {
        return {
          label: resolve(msg("View {shortLabel}", { shortLabel: terminology.shortLabel })),
          disabled: false,
          kind: "open_pr",
        };
      }
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: true,
        kind: "show_hint",
        hint: resolve(
          msg(
            '{kind, select, pr {Add an "origin" remote before pushing or creating a PR.} mr {Add an "origin" remote before pushing or creating an MR.} generic {Add an "origin" remote before pushing or creating a change request.} other {Add an "origin" remote before pushing or creating {changeRequest}.}}',
            {
              kind: changeRequestKind(terminology),
              changeRequest: terminology.shortLabelWithArticle,
            },
          ),
        ),
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return {
          label: resolve(msg("View {shortLabel}", { shortLabel: terminology.shortLabel })),
          disabled: false,
          kind: "open_pr",
        };
      }
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: true,
        kind: "show_hint",
        hint: resolve(msg("No local commits to push.")),
      };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_action",
        action: "push",
      };
    }
    return {
      label: resolve(msg("Push & create {shortLabel}", { shortLabel: terminology.shortLabel })),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: resolve(msg("Sync branch")),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Branch has diverged from upstream. Rebase/merge first.")),
    };
  }

  if (isBehind) {
    return {
      label: resolve(msg("Pull", { $context: "verb, git action" })),
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_action",
        action: "push",
      };
    }
    return {
      label: resolve(msg("Push & create {shortLabel}", { shortLabel: terminology.shortLabel })),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return {
      label: resolve(msg("View {shortLabel}", { shortLabel: terminology.shortLabel })),
      disabled: false,
      kind: "open_pr",
    };
  }

  if (hasDefaultBranchDelta && !isDefaultBranch) {
    return {
      label: resolve(msg("Create {shortLabel}", { shortLabel: terminology.shortLabel })),
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

export function getGitActionDisabledReason(
  input: {
    item: GitActionMenuItem;
    gitStatus: GitActionStatus | null;
    isBusy: boolean;
    hasOriginRemote: boolean;
  },
  resolve: MFunctionType = mFallback,
): string | null {
  const { item, gitStatus, isBusy, hasOriginRemote } = input;
  if (!item.disabled) return null;
  if (isBusy) return resolve(msg("Git action in progress."));
  if (!gitStatus) return resolve(msg("Git status is unavailable."));

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (gitStatus.workspace?._tag === "gitbutler" && item.id !== "commit") {
    return gitButlerDisabledReason(item.id, gitStatus, hasOriginRemote, resolve);
  }

  if (item.id === "commit") {
    if (!hasChanges) {
      return resolve(msg("Worktree is clean. Make changes before committing."));
    }
    return resolve(msg("Commit is currently unavailable."));
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return resolve(msg("Detached HEAD: checkout a branch before pushing."));
    }
    if (hasChanges) {
      return resolve(msg("Commit or stash local changes before pushing."));
    }
    if (isBehind) {
      return resolve(msg("Branch is behind upstream. Pull/rebase before pushing."));
    }
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return resolve(msg('Add an "origin" remote before pushing.'));
    }
    if (!isAhead) {
      return resolve(msg("No local commits to push."));
    }
    return resolve(msg("Push is currently unavailable."));
  }

  if (hasOpenPr) {
    return resolve(
      msg("View {shortLabel} is currently unavailable.", { shortLabel: terminology.shortLabel }),
    );
  }
  if (!hasBranch) {
    return resolve(
      msg(
        "{kind, select, pr {Detached HEAD: checkout a branch before creating a PR.} mr {Detached HEAD: checkout a branch before creating an MR.} generic {Detached HEAD: checkout a branch before creating a change request.} other {Detached HEAD: checkout a branch before creating {changeRequest}.}}",
        { kind: changeRequestKind(terminology), changeRequest: terminology.shortLabelWithArticle },
      ),
    );
  }
  if (!gitStatus.hasUpstream && !hasOriginRemote) {
    return resolve(
      msg(
        '{kind, select, pr {Add an "origin" remote before creating a PR.} mr {Add an "origin" remote before creating an MR.} generic {Add an "origin" remote before creating a change request.} other {Add an "origin" remote before creating {changeRequest}.}}',
        { kind: changeRequestKind(terminology), changeRequest: terminology.shortLabelWithArticle },
      ),
    );
  }
  if ((gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) <= 0) {
    return resolve(
      msg(
        "{kind, select, pr {No local commits to include in a PR.} mr {No local commits to include in an MR.} generic {No local commits to include in a change request.} other {No local commits to include in {changeRequest}.}}",
        { kind: changeRequestKind(terminology), changeRequest: terminology.shortLabelWithArticle },
      ),
    );
  }
  if (isBehind) {
    return resolve(
      msg(
        "{kind, select, pr {Branch is behind upstream. Pull/rebase before creating a PR.} mr {Branch is behind upstream. Pull/rebase before creating an MR.} generic {Branch is behind upstream. Pull/rebase before creating a change request.} other {Branch is behind upstream. Pull/rebase before creating {changeRequest}.}}",
        { kind: changeRequestKind(terminology), changeRequest: terminology.shortLabelWithArticle },
      ),
    );
  }
  return resolve(
    msg("Create {shortLabel} is currently unavailable.", { shortLabel: terminology.shortLabel }),
  );
}

/** Picks the whole sentence for the provider's term; English keeps `shortLabelWithArticle`. */
function changeRequestKind(
  terminology: ChangeRequestTerminology,
): "pr" | "mr" | "generic" | "other" {
  switch (terminology.shortLabelWithArticle) {
    case "a PR":
      return "pr";
    case "an MR":
      return "mr";
    case "a change request":
      return "generic";
    default:
      return "other";
  }
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultBranch: boolean,
): boolean {
  if (!isDefaultBranch) return false;
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export function resolveDefaultBranchActionDialogCopy(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
    terminology: ChangeRequestTerminology;
  },
  resolve: MFunctionType = mFallback,
): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const { shortLabel, shortLabelWithArticle } = input.terminology;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: resolve(msg("Commit & push to default branch?")),
        description: resolve(
          msg(
            'This action will commit and push changes on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
            { branch: branchLabel },
          ),
        ),
        continueLabel: resolve(msg("Commit & push to {branch}", { branch: branchLabel })),
      };
    }
    return {
      title: resolve(msg("Push to default branch?")),
      description: resolve(
        msg(
          'This action will push local commits on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
          { branch: branchLabel },
        ),
      ),
      continueLabel: resolve(msg("Push to {branch}", { branch: branchLabel })),
    };
  }

  if (input.includesCommit) {
    return {
      title: resolve(
        msg("Commit, push & create {shortLabel} from default branch?", { shortLabel }),
      ),
      description: resolve(
        msg(
          '{kind, select, pr {This action will commit, push, and create a PR on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} mr {This action will commit, push, and create an MR on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} generic {This action will commit, push, and create a change request on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} other {This action will commit, push, and create {changeRequest} on "{branch}". You can continue on this branch or create a feature branch and run the same action there.}}',
          {
            kind: changeRequestKind(input.terminology),
            changeRequest: shortLabelWithArticle,
            branch: branchLabel,
          },
        ),
      ),
      continueLabel: resolve(msg("Commit, push & create {shortLabel}", { shortLabel })),
    };
  }
  return {
    title: resolve(msg("Push & create {shortLabel} from default branch?", { shortLabel })),
    description: resolve(
      msg(
        '{kind, select, pr {This action will push local commits and create a PR on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} mr {This action will push local commits and create an MR on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} generic {This action will push local commits and create a change request on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} other {This action will push local commits and create {changeRequest} on "{branch}". You can continue on this branch or create a feature branch and run the same action there.}}',
        {
          kind: changeRequestKind(input.terminology),
          changeRequest: shortLabelWithArticle,
          branch: branchLabel,
        },
      ),
    ),
    continueLabel: resolve(msg("Push & create {shortLabel}", { shortLabel })),
  };
}
