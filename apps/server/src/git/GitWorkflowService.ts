import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

import {
  GitManagerError,
  GitCommandError,
  type GitButlerBranchChangeRequestResult,
  type GitButlerCommitChangesInput,
  type GitButlerCommitChangesResult,
  type GitButlerHoldsInput,
  type GitButlerHoldsResult,
  type GitButlerResolveHoldsInput,
  type VcsError,
  type GitButlerBranchInput,
  type GitButlerBranchResult,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type VcsWorkspaceStatus,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { gitButlerAppliedBranches, isGitButlerWorkspaceRef } from "@t3tools/shared/git";

import * as GitManager from "./GitManager.ts";
import * as GitButlerWorkspace from "../vcs/GitButlerWorkspace.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

/** GitButler's target, then the remote default, from refs already on disk; null when neither exists. */
export const resolveRemoteWorktreeBase = Effect.fn("resolveRemoteWorktreeBase")(function* (
  git: Pick<GitWorkflowService["Service"], "hasCommit" | "resolveRemoteTrackingCommit">,
  input: { readonly cwd: string; readonly workspace?: VcsWorkspaceStatus | undefined },
) {
  const { cwd } = input;
  const target = input.workspace?.targetRefs?.[0];
  if (target !== undefined && (yield* git.hasCommit({ cwd, refName: `refs/remotes/${target}` }))) {
    const { commitSha, remoteRefName } = yield* git.resolveRemoteTrackingCommit({
      cwd,
      refName: target,
      fallbackRemoteName: "origin",
    });
    return { commitSha, baseRefName: `refs/remotes/${remoteRefName}` };
  }
  if (yield* git.hasCommit({ cwd, refName: "refs/remotes/origin/HEAD" })) {
    const { commitSha } = yield* git.resolveRemoteTrackingCommit({
      cwd,
      refName: "HEAD",
      fallbackRemoteName: "origin",
    });
    return { commitSha, baseRefName: "refs/remotes/origin/HEAD" };
  }
  return null;
});

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly repositoryRoot: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly hasCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly hasRefNamed: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitLocalStatusOptions & { readonly includeWorkspace?: boolean },
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly currentBranch: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly upstreamDivergence: (cwd: string) => Effect.Effect<
      {
        readonly refName: string;
        readonly aheadCount: number;
        readonly behindCount: number;
      } | null,
      GitManagerServiceError
    >;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly readRefSnapshot: (cwd: string) => Effect.Effect<string | null>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    /** The checkout's own HEAD file, inside a linked worktree's admin directory when there is one. */
    readonly headPath: (cwd: string) => Effect.Effect<string | null, never>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly autoPullCurrentBranch: (
      cwd: string,
    ) => Effect.Effect<VcsPullResult | null, GitCommandError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitManager.GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName?: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"];
    readonly isGitButlerWorkspaceBase: GitVcsDriver.GitVcsDriver["Service"]["isGitButlerWorkspaceBase"];
    readonly pinBranchForWorktree: GitVcsDriver.GitVcsDriver["Service"]["pinBranchForWorktree"];
    readonly pinAppliedStackWorktreeBase: GitVcsDriver.GitVcsDriver["Service"]["pinAppliedStackWorktreeBase"];
    readonly readWorktreeStartCommit: GitVcsDriver.GitVcsDriver["Service"]["readWorktreeStartCommit"];
    readonly fetchWorktreeBaseCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly remote?: GitVcsDriver.GitWorktreeBaseRemote;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string } | null,
      GitCommandError
    >;
    readonly resolveDefaultBranchName: (
      cwd: string,
      remoteName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitVcsDriver.GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly gitButlerApply: (
      input: GitButlerBranchInput,
    ) => Effect.Effect<GitButlerBranchResult, GitCommandError>;
    readonly gitButlerUnapply: (
      input: GitButlerBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly gitButlerCreateBranch: (
      input: GitButlerBranchInput,
    ) => Effect.Effect<GitButlerBranchResult, GitCommandError>;
    /** Reads a change request by the applied branch; the workspace ref never has its own. */
    readonly gitButlerBranchChangeRequest: (
      input: GitButlerBranchInput,
    ) => Effect.Effect<GitButlerBranchChangeRequestResult, GitManagerServiceError | VcsError>;
    readonly gitButlerCommitChanges: (
      input: GitButlerCommitChangesInput,
    ) => Effect.Effect<GitButlerCommitChangesResult, GitManagerServiceError | VcsError>;
    readonly gitButlerHolds: (
      input: GitButlerHoldsInput,
    ) => Effect.Effect<GitButlerHoldsResult, GitCommandError>;
    readonly gitButlerResolveHolds: (
      input: GitButlerResolveHoldsInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly renameBranch: (input: {
      readonly exactName?: boolean;
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
  }
>()("t3/git/GitWorkflowService") {}

function nonRepositoryLocalStatus(): VcsStatusLocalResult {
  return {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryStatus(): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const gitButler = yield* GitButlerWorkspace.GitButlerWorkspace;

  // A GitButler checkout reports the synthetic workspace ref; its applied
  // branches come from `but`. Status stays usable when that CLI cannot answer.
  const withWorkspace = Effect.fn("GitWorkflowService.withWorkspace")(function* <
    Status extends VcsStatusLocalResult,
  >(cwd: string, status: Status) {
    if (status.refName === null || !isGitButlerWorkspaceRef(status.refName)) return status;
    return yield* gitButler.readStatus(cwd).pipe(
      Effect.map((workspace): Status => ({ ...status, workspace })),
      Effect.catch((error) =>
        Effect.logDebug("GitButler workspace status unavailable", { errorTag: error._tag }).pipe(
          Effect.as(status),
        ),
      ),
    );
  });

  // Nested projects and path aliases must share the checkout's branch-mutation lease.
  const withCheckoutLease = <A, E, R>(rootPath: string, effect: Effect.Effect<A, E, R>) =>
    fileSystem.realPath(rootPath).pipe(
      Effect.orElseSucceed(() => rootPath),
      Effect.flatMap((cwd) => withWorkspaceLease(cwd, effect)),
    );

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
    return handle;
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
    return handle;
  });

  const detectGitRepositoryForStatus = Effect.fn("GitWorkflowService.detectGitRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const handle = yield* registry.detect({ cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation,
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
      if (!handle) {
        return false;
      }
      return true;
    },
  );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
    if (!handle) {
      return false;
    }
    return true;
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  return GitWorkflowService.of({
    repositoryRoot: Effect.fn("GitWorkflowService.repositoryRoot")(function (cwd) {
      return registry.detect({ cwd }).pipe(
        Effect.map((handle) => (handle?.kind === "git" ? handle.repository.rootPath : null)),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.repositoryRoot",
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
    }),
    hasCommit: Effect.fn("GitWorkflowService.hasCommit")(function (input) {
      return ensureGitCommand("GitWorkflowService.hasCommit", input.cwd).pipe(
        Effect.andThen(
          git.execute({
            operation: "GitWorkflowService.hasCommit",
            cwd: input.cwd,
            args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
            allowNonZeroExit: true,
          }),
        ),
        Effect.map((result) => result.exitCode === 0),
      );
    }),
    hasRefNamed: Effect.fn("GitWorkflowService.hasRefNamed")(function (input) {
      // Pattern characters would widen the ref match.
      return /[*?[\\]/.test(input.refName)
        ? Effect.succeed(false)
        : ensureGitCommand("GitWorkflowService.hasRefNamed", input.cwd).pipe(
            Effect.andThen(
              git.execute({
                operation: "GitWorkflowService.hasRefNamed",
                cwd: input.cwd,
                args: [
                  "for-each-ref",
                  "--count=1",
                  "--format=%(refname)",
                  `refs/**/${input.refName}`,
                ],
              }),
            ),
            Effect.map((result) => result.stdout.trim().length > 0),
          );
    }),
    status: Effect.fn("GitWorkflowService.status")(function (input) {
      return detectGitRepositoryForStatus("GitWorkflowService.status", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? gitManager
                .status(input)
                .pipe(Effect.flatMap((status) => withWorkspace(input.cwd, status)))
            : Effect.succeed(nonRepositoryStatus()),
        ),
      );
    }),
    localStatus: Effect.fn("GitWorkflowService.localStatus")(function (input, options) {
      return detectGitRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) => {
          if (!isGitRepository) return Effect.succeed(nonRepositoryLocalStatus());
          const status = gitManager.localStatus(input, options);
          return options?.includeWorkspace === false
            ? status
            : status.pipe(Effect.flatMap((value) => withWorkspace(input.cwd, value)));
        }),
      );
    }),
    currentBranch: Effect.fn("GitWorkflowService.currentBranch")(function* (cwd) {
      if (!(yield* detectGitRepositoryForStatus("GitWorkflowService.currentBranch", cwd))) {
        return null;
      }
      const result = yield* git.execute({
        operation: "GitWorkflowService.currentBranch",
        cwd,
        args: ["symbolic-ref", "--quiet", "HEAD"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      });
      if (result.exitCode === 0) {
        return result.stdout.trim().replace(/^refs\/heads\//, "") || null;
      }
      if (result.exitCode === 1) return null;
      return yield* new GitCommandError({
        operation: "GitWorkflowService.currentBranch",
        command: "git symbolic-ref",
        cwd,
        argumentCount: 3,
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
        detail: "Failed to read the checked-out branch.",
      });
    }),
    upstreamDivergence: Effect.fn("GitWorkflowService.upstreamDivergence")(function* (cwd) {
      const details = yield* git.statusDetailsRemote(cwd, { refreshUpstream: false });
      return details.hasUpstream && details.branch !== null
        ? {
            refName: details.branch,
            aheadCount: details.aheadCount,
            behindCount: details.behindCount,
          }
        : null;
    }),
    remoteStatus: Effect.fn("GitWorkflowService.remoteStatus")(function (input, options) {
      return detectGitRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.remoteStatus(input, options) : Effect.succeed(null),
        ),
      );
    }),
    invalidateLocalStatus: Effect.fn("GitWorkflowService.invalidateLocalStatus")(function (cwd) {
      return gitManager.invalidateLocalStatus(cwd).pipe(Effect.andThen(gitButler.invalidate(cwd)));
    }),
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    readRefSnapshot: git.readRefSnapshot,
    invalidateStatus: Effect.fn("GitWorkflowService.invalidateStatus")(function (cwd) {
      return gitManager.invalidateStatus(cwd).pipe(Effect.andThen(gitButler.invalidate(cwd)));
    }),
    headPath: Effect.fn("GitWorkflowService.headPath")(function* (cwd) {
      // Clients keep watching threads whose worktree was removed; spawning there fails noisily.
      if (!(yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => true)))) return null;
      return yield* git
        .execute({
          operation: "GitWorkflowService.headPath",
          cwd,
          args: ["rev-parse", "--path-format=absolute", "--git-path", "HEAD"],
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
          Effect.orElseSucceed(() => null),
        );
    }),
    pullCurrentBranch: Effect.fn("GitWorkflowService.pullCurrentBranch")(function* (cwd) {
      const handle = yield* ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd);
      return yield* withCheckoutLease(
        handle.repository.rootPath,
        Effect.gen(function* () {
          const status = yield* git.statusDetails(cwd);
          return yield* status.branch !== null && isGitButlerWorkspaceRef(status.branch)
            ? gitButler.pull(cwd)
            : git.pullCurrentBranch(cwd);
        }),
      ).pipe(
        Effect.ensuring(
          gitManager.invalidateStatus(cwd).pipe(Effect.andThen(gitButler.invalidate(cwd))),
        ),
      );
    }),
    autoPullCurrentBranch: Effect.fn("GitWorkflowService.autoPullCurrentBranch")(function* (cwd) {
      const status = yield* git.statusDetails(cwd);
      if (status.branch !== null && isGitButlerWorkspaceRef(status.branch)) {
        return yield* withCheckoutLease(
          status.workingTree.rootPath ?? cwd,
          gitButler.autoPull(cwd),
        ).pipe(
          Effect.ensuring(
            gitManager.invalidateStatus(cwd).pipe(Effect.andThen(gitButler.invalidate(cwd))),
          ),
        );
      }
      const reason = !status.isRepo
        ? "not-a-repository"
        : !status.isDefaultBranch
          ? "not-on-default-branch"
          : !status.hasUpstream
            ? "no-upstream"
            : status.hasWorkingTreeChanges
              ? "working-tree-changes"
              : status.aheadCount > 0
                ? "local-commits"
                : null;
      if (reason !== null) {
        yield* Effect.logDebug("Skipped automatic project pull", { reason });
        return null;
      }
      if (status.behindCount <= 0) return null;
      return yield* git
        .pullCurrentBranch(cwd)
        .pipe(Effect.ensuring(gitManager.invalidateStatus(cwd)));
    }),
    runStackedAction: Effect.fn("GitWorkflowService.runStackedAction")(function (input, options) {
      return ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(
            handle.repository.rootPath,
            gitManager.runStackedAction(input, options),
          ),
        ),
      );
    }),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: Effect.fn("GitWorkflowService.preparePullRequestThread")(
      function (input) {
        return ensureGit("GitWorkflowService.preparePullRequestThread", input.cwd).pipe(
          Effect.flatMap((handle) =>
            input.mode === "local"
              ? withCheckoutLease(
                  handle.repository.rootPath,
                  gitManager.preparePullRequestThread(input),
                )
              : gitManager.preparePullRequestThread(input),
          ),
        );
      },
    ),
    listRefs: Effect.fn("GitWorkflowService.listRefs")(function (input) {
      return detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      );
    }),
    createWorktree: Effect.fn("GitWorkflowService.createWorktree")(function (input, options) {
      return ensureGitCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.andThen(gitManager.createWorktree(input, options)),
      );
    }),
    listLocalBranchNames: Effect.fn("GitWorkflowService.listLocalBranchNames")(function (cwd) {
      return ensureGitCommand("GitWorkflowService.listLocalBranchNames", cwd).pipe(
        Effect.andThen(git.listLocalBranchNames(cwd)),
      );
    }),
    fetchRemote: Effect.fn("GitWorkflowService.fetchRemote")(function (input) {
      return ensureGitCommand("GitWorkflowService.fetchRemote", input.cwd).pipe(
        Effect.andThen(git.fetchRemote(input)),
      );
    }),
    remoteExists: Effect.fn("GitWorkflowService.remoteExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteExists", input.cwd).pipe(
        Effect.andThen(git.remoteExists(input)),
      );
    }),
    remoteBranchExists: Effect.fn("GitWorkflowService.remoteBranchExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteBranchExists", input.cwd).pipe(
        Effect.andThen(git.remoteBranchExists(input)),
      );
    }),
    resolvePrimaryRemoteName: Effect.fn("GitWorkflowService.resolvePrimaryRemoteName")(
      function (cwd) {
        return ensureGitCommand("GitWorkflowService.resolvePrimaryRemoteName", cwd).pipe(
          Effect.andThen(git.resolvePrimaryRemoteName(cwd)),
        );
      },
    ),
    resolveRemoteTrackingCommit: Effect.fn("GitWorkflowService.resolveRemoteTrackingCommit")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
          Effect.andThen(git.resolveRemoteTrackingCommit(input)),
        );
      },
    ),
    resolveWorktreeBaseRemote: Effect.fn("GitWorkflowService.resolveWorktreeBaseRemote")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.resolveWorktreeBaseRemote", input.cwd).pipe(
          Effect.andThen(git.resolveWorktreeBaseRemote(input)),
        );
      },
    ),
    pinBranchForWorktree: Effect.fn("GitWorkflowService.pinBranchForWorktree")(function (input) {
      return ensureGitCommand("GitWorkflowService.pinBranchForWorktree", input.cwd).pipe(
        Effect.andThen(git.pinBranchForWorktree(input)),
      );
    }),
    pinAppliedStackWorktreeBase: Effect.fn("GitWorkflowService.pinAppliedStackWorktreeBase")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.pinAppliedStackWorktreeBase", input.cwd).pipe(
          Effect.andThen(git.pinAppliedStackWorktreeBase(input)),
        );
      },
    ),
    readWorktreeStartCommit: Effect.fn("GitWorkflowService.readWorktreeStartCommit")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.readWorktreeStartCommit", input.cwd).pipe(
          Effect.andThen(git.readWorktreeStartCommit(input)),
        );
      },
    ),
    isGitButlerWorkspaceBase: Effect.fn("GitWorkflowService.isGitButlerWorkspaceBase")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.isGitButlerWorkspaceBase", input.cwd).pipe(
          Effect.andThen(git.isGitButlerWorkspaceBase(input)),
        );
      },
    ),
    fetchWorktreeBaseCommit: Effect.fn("GitWorkflowService.fetchWorktreeBaseCommit")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.fetchWorktreeBaseCommit", input.cwd).pipe(
          Effect.andThen(git.fetchWorktreeBaseCommit(input)),
        );
      },
    ),
    resolveDefaultBranchName: Effect.fn("GitWorkflowService.resolveDefaultBranchName")(
      function (cwd, remoteName) {
        return ensureGitCommand("GitWorkflowService.resolveDefaultBranchName", cwd).pipe(
          Effect.andThen(git.resolveDefaultBranchName(cwd, remoteName)),
        );
      },
    ),
    removeWorktree: Effect.fn("GitWorkflowService.removeWorktree")(function (input) {
      return ensureGitCommand("GitWorkflowService.removeWorktree", input.cwd).pipe(
        Effect.andThen(git.removeWorktree(input)),
      );
    }),
    pruneWorktrees: Effect.fn("GitWorkflowService.pruneWorktrees")(function (input) {
      return ensureGitCommand("GitWorkflowService.pruneWorktrees", input.cwd).pipe(
        Effect.andThen(git.pruneWorktrees(input)),
      );
    }),
    deleteLocalBranch: Effect.fn("GitWorkflowService.deleteLocalBranch")(function (input) {
      return ensureGitCommand("GitWorkflowService.deleteLocalBranch", input.cwd).pipe(
        Effect.andThen(git.deleteLocalBranch(input)),
      );
    }),
    createRef: Effect.fn("GitWorkflowService.createRef")(function (input) {
      return ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          input.switchRef
            ? withCheckoutLease(handle.repository.rootPath, git.createRef(input))
            : git.createRef(input),
        ),
      );
    }),
    gitButlerApply: Effect.fn("GitWorkflowService.gitButlerApply")(function (input) {
      return ensureGitCommand("GitWorkflowService.gitButlerApply", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(
            handle.repository.rootPath,
            gitButler.apply(input).pipe(Effect.ensuring(gitManager.invalidateStatus(input.cwd))),
          ),
        ),
      );
    }),
    gitButlerUnapply: Effect.fn("GitWorkflowService.gitButlerUnapply")(function (input) {
      return ensureGitCommand("GitWorkflowService.gitButlerUnapply", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(
            handle.repository.rootPath,
            gitButler.unapply(input).pipe(Effect.ensuring(gitManager.invalidateStatus(input.cwd))),
          ),
        ),
      );
    }),
    gitButlerCommitChanges: Effect.fn("GitWorkflowService.gitButlerCommitChanges")(
      function* (input) {
        return yield* gitButler.readCommitChanges(input);
      },
    ),
    gitButlerHolds: Effect.fn("GitWorkflowService.gitButlerHolds")(function (input) {
      return gitButler.readHolds(input.cwd);
    }),
    gitButlerResolveHolds: Effect.fn("GitWorkflowService.gitButlerResolveHolds")(function (input) {
      return gitButler
        .resolveHolds(input)
        .pipe(Effect.ensuring(gitManager.invalidateStatus(input.cwd)));
    }),
    gitButlerBranchChangeRequest: Effect.fn("GitWorkflowService.gitButlerBranchChangeRequest")(
      function* (input) {
        const workspace = yield* gitButler.readStatus(input.cwd);
        if (!gitButlerAppliedBranches(workspace).includes(input.branch)) {
          return yield* new GitCommandError({
            operation: "GitWorkflowService.gitButlerBranchChangeRequest",
            command: "but status",
            cwd: input.cwd,
            detail: "This GitButler branch is no longer applied. Refresh and try again.",
          });
        }
        const pr = yield* gitManager.branchPullRequest(input);
        if (pr === null) return { pr, association: null };
        // A failed read cannot prove the link, so it leaves the change request a candidate.
        const confirmed =
          !!pr.headSha &&
          (yield* gitButler
            .branchHasRevision({ ...input, sha: pr.headSha })
            .pipe(Effect.orElseSucceed(() => false)));
        const {
          closedAt: _closedAt,
          mergedAt: _mergedAt,
          headSha: _sha,
          repositoryKey: _key,
          ...change
        } = pr;
        return { pr: change, association: confirmed ? "confirmed" : "candidate" };
      },
    ),
    gitButlerCreateBranch: Effect.fn("GitWorkflowService.gitButlerCreateBranch")(function (input) {
      return ensureGitCommand("GitWorkflowService.gitButlerCreateBranch", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(
            handle.repository.rootPath,
            gitButler
              .createBranch(input)
              .pipe(Effect.ensuring(gitManager.invalidateStatus(input.cwd))),
          ),
        ),
      );
    }),
    switchRef: Effect.fn("GitWorkflowService.switchRef")(function (input) {
      return ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(handle.repository.rootPath, Effect.scoped(git.switchRef(input))),
        ),
      );
    }),
    renameBranch: Effect.fn("GitWorkflowService.renameBranch")(function (input) {
      return ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      );
    }),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
