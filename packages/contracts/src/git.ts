import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  GitRefName,
  ForwardCompatibleOptional,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderError, SourceControlProviderInfo } from "./sourceControl.ts";
import { VcsDriverKind } from "./vcs.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const GitFilePath = Schema.String.check(Schema.isNonEmpty());
const GIT_LIST_BRANCHES_MAX_LIMIT = 200;

export const GitStackedAction = Schema.Literals([
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
export type GitStackedAction = typeof GitStackedAction.Type;
export const GitActionProgressPhase = Schema.Literals(["branch", "commit", "push", "pr"]);
export type GitActionProgressPhase = typeof GitActionProgressPhase.Type;
export const GitActionProgressKind = Schema.Literals([
  "action_started",
  "phase_started",
  "hook_started",
  "hook_output",
  "hook_finished",
  "action_finished",
  "action_failed",
]);
export type GitActionProgressKind = typeof GitActionProgressKind.Type;
export const GitActionProgressStream = Schema.Literals(["stdout", "stderr"]);
export type GitActionProgressStream = typeof GitActionProgressStream.Type;
const GitCommitStepStatus = Schema.Literals([
  "created",
  "skipped_no_changes",
  "skipped_not_requested",
]);
const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
const GitBranchStepStatus = Schema.Literals(["created", "skipped_not_requested"]);
const GitPrStepStatus = Schema.Literals(["created", "opened_existing", "skipped_not_requested"]);
const VcsStatusChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPullRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPreparePullRequestThreadMode = Schema.Literals(["local", "worktree"]);
export const GitRunStackedActionToastRunAction = Schema.Struct({
  kind: GitStackedAction,
});
export type GitRunStackedActionToastRunAction = typeof GitRunStackedActionToastRunAction.Type;
const GitRunStackedActionToastCta = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("open_pr"),
    label: TrimmedNonEmptyStringSchema,
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("run_action"),
    label: TrimmedNonEmptyStringSchema,
    action: GitRunStackedActionToastRunAction,
  }),
]);
export type GitRunStackedActionToastCta = typeof GitRunStackedActionToastCta.Type;
const GitRunStackedActionToast = Schema.Struct({
  title: TrimmedNonEmptyStringSchema,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  cta: GitRunStackedActionToastCta,
});
export type GitRunStackedActionToast = typeof GitRunStackedActionToast.Type;

export const VcsRef = Schema.Struct({
  name: GitRefName,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(GitRefName),
  // Full Git ref, for example refs/remotes/origin/feature.
  upstreamRef: Schema.optional(GitRefName),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsRef = typeof VcsRef.Type;

const VcsWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  refName: GitRefName,
});
const GitResolvedPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: GitRefName,
  headBranch: GitRefName,
  state: GitPullRequestState,
});
export type GitResolvedPullRequest = typeof GitResolvedPullRequest.Type;

export const VcsStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsStatusInput = typeof VcsStatusInput.Type;

export const VcsBranchStatus = Schema.Struct({
  refName: Schema.NullOr(Schema.String),
  /** Absent from older servers, where a removed checkout looks like a detached HEAD. */
  isRepo: Schema.optional(Schema.Boolean),
});
export type VcsBranchStatus = typeof VcsBranchStatus.Type;

export const VcsStatusSubscriptionInput = Schema.Struct({
  ...VcsStatusInput.fields,
  /** Passive observers receive cached remote status without retaining its refresh loop. */
  includeRemote: Schema.optional(Schema.Boolean),
});
export type VcsStatusSubscriptionInput = typeof VcsStatusSubscriptionInput.Type;

export const VcsPullInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsPullInput = typeof VcsPullInput.Type;

export const GitRunStackedActionInput = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(Schema.Array(GitFilePath).check(Schema.isMinLength(1))),
  /**
   * GitButler hunk IDs a person chose from `vcs.gitButlerCommitChanges`. Commits in a GitButler
   * workspace require them: an ID names exact content, so later edits are refused, not swept in.
   */
  gitbutlerChangeIds: Schema.optional(
    Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
  ),
  threadId: Schema.optional(ThreadId),
  /**
   * Draft threads have no threadId; persisted thread metadata takes precedence. Sent with an
   * approval, it's the branch a person confirmed, and publishing any other branch is refused.
   */
  gitbutlerBranch: Schema.optional(GitRefName),
  /** The `approval` of a GitButlerForcePushConfirmationError, sent once a person has confirmed it. */
  gitbutlerForcePushApproval: Schema.optional(
    TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(65_536)),
  ),
  /**
   * The `approval` of a GitButlerPublicationHoldError, for a client to send once its user has
   * reviewed the hold. Anything with source-control write access can send it, so it isn't proof
   * that a person looked.
   */
  gitbutlerHoldApproval: Schema.optional(
    TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(65_536)),
  ),
  projectId: Schema.optional(ProjectId),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const VcsListRefsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  query: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(NonNegativeInt),
  includeMatchingRemoteRefs: Schema.optional(Schema.Boolean),
  refKind: Schema.optional(Schema.Literals(["all", "local", "remote"])),
  refresh: Schema.optional(Schema.Boolean),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_LIST_BRANCHES_MAX_LIMIT)),
  ),
});
export type VcsListRefsInput = typeof VcsListRefsInput.Type;

export const VcsCreateWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: GitRefName,
  newRefName: Schema.optional(GitRefName),
  baseRefName: Schema.optional(GitRefName),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsCreateWorktreeInput = typeof VcsCreateWorktreeInput.Type;

export const GitPullRequestRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
});
export type GitPullRequestRefInput = typeof GitPullRequestRefInput.Type;

export const GitPreparePullRequestThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  mode: GitPreparePullRequestThreadMode,
  threadId: Schema.optional(ThreadId),
});
export type GitPreparePullRequestThreadInput = typeof GitPreparePullRequestThreadInput.Type;

export const VcsRemoveWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type VcsRemoveWorktreeInput = typeof VcsRemoveWorktreeInput.Type;

export const VcsCreateRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: GitRefName,
  switchRef: Schema.optional(Schema.Boolean),
});
export type VcsCreateRefInput = typeof VcsCreateRefInput.Type;

export const VcsCreateRefResult = Schema.Struct({
  refName: GitRefName,
});
export type VcsCreateRefResult = typeof VcsCreateRefResult.Type;

export const VcsSwitchRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: GitRefName,
});
export type VcsSwitchRefInput = typeof VcsSwitchRefInput.Type;

export const GitButlerBranchInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
});
export type GitButlerBranchInput = typeof GitButlerBranchInput.Type;

export const GitButlerBranchResult = Schema.Struct({ branch: TrimmedNonEmptyStringSchema });
export type GitButlerBranchResult = typeof GitButlerBranchResult.Type;

export const VcsInitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  kind: Schema.optional(VcsDriverKind),
});
export type VcsInitInput = typeof VcsInitInput.Type;

const VcsStatusChangeRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseRef: GitRefName,
  headRef: GitRefName,
  state: VcsStatusChangeRequestState,
  isDraft: Schema.optional(Schema.Boolean),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

// Lookups match by branch name, which another author's branch can share. "confirmed" means the
// change request's head is one of this branch's commits or its upstream tip.
export const GitButlerChangeRequestAssociation = Schema.Literals(["confirmed", "candidate"]);
export type GitButlerChangeRequestAssociation = typeof GitButlerChangeRequestAssociation.Type;

export const GitButlerBranchChangeRequestResult = Schema.Struct({
  pr: Schema.NullOr(VcsStatusChangeRequest),
  association: Schema.NullOr(GitButlerChangeRequestAssociation),
});
export type GitButlerBranchChangeRequestResult = typeof GitButlerBranchChangeRequestResult.Type;

export const GitButlerCommitChangesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  /** The thread's applied branch. Without one, every assigned change belongs to another stack. */
  branch: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type GitButlerCommitChangesInput = typeof GitButlerCommitChangesInput.Type;

// "shared" has no assigned branch, so it may be anyone's. "mixed" holds both this branch's changes
// and unassigned ones, which `but status` cannot tell apart by hunk. "locked" cannot be committed.
export const GitButlerCommitFileScope = Schema.Literals(["target", "shared", "mixed", "locked"]);
export type GitButlerCommitFileScope = typeof GitButlerCommitFileScope.Type;

export const GitButlerCommitFile = Schema.Struct({
  path: GitFilePath,
  scope: GitButlerCommitFileScope,
  /** Set when `locked` because another stack holds part of the file. */
  assignedBranch: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Set when `locked` because the branch holds another version, so a commit couldn't be checked. */
  changedElsewhere: Schema.optional(Schema.Literal(true)),
  changeIds: Schema.Array(TrimmedNonEmptyStringSchema),
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type GitButlerCommitFile = typeof GitButlerCommitFile.Type;

export const GitButlerCommitChangesResult = Schema.Struct({
  files: Schema.Array(GitButlerCommitFile),
});
export type GitButlerCommitChangesResult = typeof GitButlerCommitChangesResult.Type;

// What pushing a branch would do, per `but status`. A branch with no entry is unknown.
export const GitButlerBranchPublication = Schema.Literals([
  "empty",
  "unpublished",
  "ahead",
  "force_required",
  "up_to_date",
  "integrated",
]);
export type GitButlerBranchPublication = typeof GitButlerBranchPublication.Type;

// GitButler checks out a synthetic `gitbutler/workspace` ref that merges every
// applied branch, so the git ref alone hides which branches are in play.
export const GitButlerWorkspaceStatus = Schema.TaggedStruct("gitbutler", {
  targetRefs: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  /** Where an unpublished branch would go; a published branch keeps its own upstream. */
  pushRemote: Schema.optional(TrimmedNonEmptyStringSchema),
  publications: Schema.optional(Schema.Record(Schema.String, GitButlerBranchPublication)),
  /** Commits T3 Code couldn't confirm, which it asks about before publishing. Absent when none. */
  heldCommitCount: Schema.optional(NonNegativeInt),
  stacks: Schema.Array(
    Schema.Struct({
      branches: Schema.Array(TrimmedNonEmptyStringSchema),
      assignedChangeCount: NonNegativeInt,
    }),
  ),
  unassignedChangeCount: NonNegativeInt,
});
export type GitButlerWorkspaceStatus = typeof GitButlerWorkspaceStatus.Type;

export const VcsWorkspaceStatus = Schema.Union([GitButlerWorkspaceStatus]);
export type VcsWorkspaceStatus = typeof VcsWorkspaceStatus.Type;

const VcsStatusLocalShape = {
  isRepo: Schema.Boolean,
  sourceControlProvider: Schema.optional(SourceControlProviderInfo),
  workspace: Schema.optional(VcsWorkspaceStatus),
  hasPrimaryRemote: Schema.Boolean,
  isDefaultRef: Schema.Boolean,
  refName: Schema.NullOr(GitRefName),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    // Absolute worktree root on the environment that every files[].path is
    // relative to. Absent when the server could not resolve it.
    rootPath: Schema.optional(GitFilePath),
    files: Schema.Array(
      Schema.Struct({
        path: GitFilePath,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
  branchChanges: Schema.optional(
    Schema.Struct({
      baseRef: Schema.NullOr(GitRefName),
      insertions: NonNegativeInt,
      deletions: NonNegativeInt,
    }),
  ),
};

const VcsStatusRemoteShape = {
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  aheadOfDefaultCount: Schema.optional(NonNegativeInt),
  pr: Schema.NullOr(VcsStatusChangeRequest),
};

export const VcsStatusLocalResult = Schema.Struct(VcsStatusLocalShape);
export type VcsStatusLocalResult = typeof VcsStatusLocalResult.Type;

export const VcsStatusRemoteResult = Schema.Struct(VcsStatusRemoteShape);
export type VcsStatusRemoteResult = typeof VcsStatusRemoteResult.Type;

export const VcsStatusResult = Schema.Struct({
  ...VcsStatusLocalShape,
  ...VcsStatusRemoteShape,
});
export type VcsStatusResult = typeof VcsStatusResult.Type;

export const VcsRefreshStatusResult = Schema.Struct({
  ...VcsStatusResult.fields,
  // Digest of the repository's refs after the refresh; absent when they could not be read.
  refsDigest: Schema.optional(TrimmedNonEmptyString),
});
export type VcsRefreshStatusResult = typeof VcsRefreshStatusResult.Type;

export const VcsStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    local: VcsStatusLocalResult,
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
  Schema.TaggedStruct("localUpdated", {
    local: VcsStatusLocalResult,
  }),
  Schema.TaggedStruct("remoteUpdated", {
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
]);
export type VcsStatusStreamEvent = typeof VcsStatusStreamEvent.Type;

export const VcsListRefsResult = Schema.Struct({
  isAtRepositoryRoot: Schema.optional(Schema.Boolean),
  refs: Schema.Array(VcsRef),
  isRepo: Schema.Boolean,
  hasPrimaryRemote: Schema.Boolean,
  nextCursor: NonNegativeInt.pipe(Schema.NullOr),
  totalCount: NonNegativeInt,
});
export type VcsListRefsResult = typeof VcsListRefsResult.Type;

export const VcsCreateWorktreeResult = Schema.Struct({
  worktree: VcsWorktree,
});
export type VcsCreateWorktreeResult = typeof VcsCreateWorktreeResult.Type;

export const GitResolvePullRequestResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
});
export type GitResolvePullRequestResult = typeof GitResolvePullRequestResult.Type;

export const GitPreparePullRequestThreadResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  branch: GitRefName,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  /** False when local commits or edits prevented a reused worktree from reaching the PR head. */
  isOnPullRequestHead: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type GitPreparePullRequestThreadResult = typeof GitPreparePullRequestThreadResult.Type;

export const VcsSwitchRefResult = Schema.Struct({
  refName: Schema.NullOr(GitRefName),
});
export type VcsSwitchRefResult = typeof VcsSwitchRefResult.Type;

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  branch: Schema.Struct({
    status: GitBranchStepStatus,
    name: Schema.optional(GitRefName),
    /** Associates a branch without replacing the checkout's synthetic workspace ref. */
    gitbutler: Schema.optional(Schema.Boolean),
  }),
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(GitRefName),
    upstreamBranch: Schema.optional(GitRefName),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseBranch: Schema.optional(GitRefName),
    headBranch: Schema.optional(GitRefName),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  toast: GitRunStackedActionToast,
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const VcsPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  refName: GitRefName,
  upstreamRef: GitRefName.pipe(Schema.NullOr),
});
export type VcsPullResult = typeof VcsPullResult.Type;

// Git stderr can echo credentials from argv and remote URLs. Only a fixed
// reason reaches the error and its diagnostic suffix; newer, unknown reasons
// decode as absent through GitCommandError.
export const GitCommandFailureReason = Schema.Literals([
  "authentication_failed",
  "branch_already_exists",
  "branch_checked_out_in_worktree",
  "config_locked",
  "host_key_unverified",
  "not_a_repository",
  "path_already_exists",
  "push_rejected_by_remote",
  "push_rejected_non_fast_forward",
  "ref_name_conflict",
  "ref_not_found",
  "remote_unreachable",
  "tag_would_be_clobbered",
]);
export type GitCommandFailureReason = typeof GitCommandFailureReason.Type;

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  argumentCount: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  stdoutLength: Schema.optional(Schema.Number),
  stderrLength: Schema.optional(Schema.Number),
  outputLength: Schema.optional(Schema.Number),
  reason: ForwardCompatibleOptional(GitCommandFailureReason),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const reason = this.reason === undefined ? "" : ` (${this.reason})`;
    return `Git command failed in ${this.operation} (${this.cwd}): ${this.detail}${reason}`;
  }
}

export class TextGenerationError extends Schema.TaggedError<TextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Text generation failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitManagerError extends Schema.TaggedError<GitManagerError>()("GitManagerError", {
  operation: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git manager failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitPullRequestMaterializationError extends Schema.TaggedError<GitPullRequestMaterializationError>()(
  "GitPullRequestMaterializationError",
  {
    cwd: TrimmedNonEmptyStringSchema,
    pullRequestNumber: PositiveInt,
    headRepository: Schema.NullOr(TrimmedNonEmptyStringSchema),
    headBranch: GitRefName,
    localBranch: GitRefName,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to materialize pull request #${this.pullRequestNumber} branch ${this.headBranch} as ${this.localBranch}.`;
  }
}

export const GitButlerForcePushTarget = Schema.Struct({
  branch: TrimmedNonEmptyStringSchema,
  remote: TrimmedNonEmptyStringSchema,
  remoteSha: TrimmedNonEmptyStringSchema,
  /** Remote commits missing from the local branch. Empty for a plain rewrite of pushed commits. */
  overwrittenCommits: Schema.Array(Schema.Struct({ sha: Schema.String, message: Schema.String })),
});
export type GitButlerForcePushTarget = typeof GitButlerForcePushTarget.Type;

/**
 * `but push` always forces, so nothing short of this stops it replacing a remote branch.
 * `approval` names what was checked, so it acknowledges that state and grants nothing else.
 */
export class GitButlerForcePushConfirmationError extends Schema.TaggedError<GitButlerForcePushConfirmationError>()(
  "GitButlerForcePushConfirmationError",
  {
    cwd: Schema.String,
    branch: GitRefName,
    targets: Schema.Array(GitButlerForcePushTarget),
    approval: TrimmedNonEmptyStringSchema,
    staleApproval: Schema.Boolean,
  },
) {
  override get message(): string {
    const refs = this.targets.map((target) => `${target.remote}/${target.branch}`).join(", ");
    return `${this.staleApproval ? "The remote changed after this was confirmed. " : ""}Pushing ${this.branch} would overwrite ${refs}, so nothing was pushed. Have a person review this, then retry with gitbutlerForcePushApproval set to this error's approval.`;
  }
}

export const GitButlerPublicationHold = Schema.Struct({
  /** Where the commit is now, or the branch it was committed to if it can't be found. */
  branch: TrimmedNonEmptyStringSchema,
  /** `unverified` compared differently from what was chosen; `interrupted` was never compared. */
  state: Schema.Literals(["unverified", "interrupted"]),
  /** Null when the commit was never identified. */
  commitSha: Schema.NullOr(TrimmedNonEmptyStringSchema),
  /** False when T3 Code can't locate the commit, so any branch might now hold its changes. */
  found: Schema.Boolean,
  /** Ends just this hold, publishing nothing, while it's still what was shown. */
  resolution: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type GitButlerPublicationHold = typeof GitButlerPublicationHold.Type;

/** Ends a hold from a terminal. Branch names can hold shell metacharacters, so the ref is quoted. */
export const gitButlerEndHoldCommand = (ref: string) =>
  `git update-ref -d '${ref.replaceAll("'", `'\\''`)}'`;

export const GitButlerHoldsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitButlerHoldsInput = typeof GitButlerHoldsInput.Type;

export const GitButlerHeldCommit = Schema.Struct({
  ...GitButlerPublicationHold.fields,
  /** Set in place of `resolution` when the commit isn't known to have ended, whoever started it. */
  possiblyRunningRef: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type GitButlerHeldCommit = typeof GitButlerHeldCommit.Type;

export const GitButlerHoldsResult = Schema.Struct({
  holds: Schema.Array(GitButlerHeldCommit),
});
export type GitButlerHoldsResult = typeof GitButlerHoldsResult.Type;

export const GitButlerResolveHoldsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  resolutions: Schema.Array(TrimmedNonEmptyStringSchema),
});
export type GitButlerResolveHoldsInput = typeof GitButlerResolveHoldsInput.Type;

/** A push or PR would send commits T3 Code couldn't confirm. `approval` covers just these. */
export class GitButlerPublicationHoldError extends Schema.TaggedError<GitButlerPublicationHoldError>()(
  "GitButlerPublicationHoldError",
  {
    cwd: Schema.String,
    branch: GitRefName,
    holds: Schema.Array(GitButlerPublicationHold),
    approval: TrimmedNonEmptyStringSchema,
    staleApproval: Schema.Boolean,
  },
) {
  override get message(): string {
    const holds = this.holds
      .map((hold) => hold.commitSha?.slice(0, 12) ?? `an unidentified commit on ${hold.branch}`)
      .join(", ");
    return `${this.staleApproval ? "What was reviewed has changed. " : ""}T3 Code could not confirm ${holds}, so nothing was pushed from ${this.branch}. Have a person review this, then retry with gitbutlerHoldApproval set to this error's approval.`;
  }
}

export const GitManagerServiceError = Schema.Union([
  GitManagerError,
  GitButlerForcePushConfirmationError,
  GitButlerPublicationHoldError,
  GitPullRequestMaterializationError,
  GitCommandError,
  SourceControlProviderError,
  TextGenerationError,
]);
export type GitManagerServiceError = typeof GitManagerServiceError.Type;

const GitActionProgressBase = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
});

const GitActionStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_started"),
  phases: Schema.Array(GitActionProgressPhase),
});
const GitActionPhaseStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("phase_started"),
  phase: GitActionProgressPhase,
  label: TrimmedNonEmptyStringSchema,
});
const GitActionHookStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_started"),
  hookName: TrimmedNonEmptyStringSchema,
});
const GitActionHookOutputEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_output"),
  hookName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  stream: GitActionProgressStream,
  text: TrimmedNonEmptyStringSchema,
});
const GitActionHookFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_finished"),
  hookName: TrimmedNonEmptyStringSchema,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
});
const GitActionFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_finished"),
  result: GitRunStackedActionResult,
});
const GitActionFailedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_failed"),
  phase: Schema.NullOr(GitActionProgressPhase),
  message: TrimmedNonEmptyStringSchema,
  createdBranch: Schema.optional(GitRefName),
});

export const GitActionProgressEvent = Schema.Union([
  GitActionStartedEvent,
  GitActionPhaseStartedEvent,
  GitActionHookStartedEvent,
  GitActionHookOutputEvent,
  GitActionHookFinishedEvent,
  GitActionFinishedEvent,
  GitActionFailedEvent,
]);
export type GitActionProgressEvent = typeof GitActionProgressEvent.Type;
