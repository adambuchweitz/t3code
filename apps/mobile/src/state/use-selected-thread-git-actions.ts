import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";

import { EnvironmentProject, EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  createVcsStatusRevalidationAtomFamily,
  gitButlerForcePushRetryAction,
  gitButlerHoldReview,
  gitButlerPublishConfirmation,
  type GitActionRequestInput,
  type VcsActionOperation,
  type VcsRef,
} from "@t3tools/client-runtime/state/vcs";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import {
  dedupeRemoteBranchesWithLocalMatches,
  sanitizeFeatureBranchName,
  isGitButlerWorkspaceRef,
} from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { msg } from "gt-react-native";
import { m } from "../i18n/messages";
import { AsyncResult } from "effect/reactivity";

import { useBranches } from "./queries";
import { threadEnvironment } from "./threads";
import { vcsActionManager, vcsEnvironment } from "./vcs";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { readEnvironmentScope, useEnvironmentScope } from "./session";
import {
  environmentConnectedAtom,
  setPendingConnectionError,
} from "./use-remote-environment-registry";
import { useAtomCommand } from "./use-atom-command";
import {
  alertGitButlerHoldFailure,
  confirmGitButlerHoldReview,
  confirmGitButlerPublish,
} from "./confirm-gitbutler-force-push";
import type { GitRepositoryTarget } from "./thread-git-target";
import { noteRepositoryGitAction, showGitActionResult } from "./use-vcs-action-state";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";
import { useEnvironmentQuery } from "./query";

function refreshFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return errorDisplayMessage(error, m) ?? m(msg("Failed to refresh git status."));
}

// Selecting a thread or reconnecting its environment refreshes the checkout's
// status once, shared by every sheet that shows it.
const selectedThreadStatusRevalidation = createVcsStatusRevalidationAtomFamily({
  refreshStatus: vcsEnvironment.refreshStatus,
  connected: environmentConnectedAtom,
  onRefreshed: (result) =>
    setPendingConnectionError(
      AsyncResult.isFailure(result) ? refreshFailureMessage(result.cause) : null,
    ),
});

/**
 * Git actions for the selected thread's own folder, or for `repository` when given. A repository
 * keeps the thread as the owner of the work but never writes its branch back onto the thread.
 */
export function useSelectedThreadGitActions(repository?: GitRepositoryTarget) {
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const readRefs = useAtomCommand(vcsEnvironment.readRefs, { reportFailure: false });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const createRef = useAtomCommand(vcsEnvironment.createRef, { reportFailure: false });
  const applyGitButlerBranch = useAtomCommand(vcsEnvironment.gitButlerApply, {
    reportFailure: false,
  });
  const unapplyGitButlerBranch = useAtomCommand(vcsEnvironment.gitButlerUnapply, {
    reportFailure: false,
  });
  const createGitButlerBranch = useAtomCommand(vcsEnvironment.gitButlerCreateBranch, {
    reportFailure: false,
  });
  const readGitButlerHolds = useAtomCommand(vcsEnvironment.gitButlerHolds, {
    reportFailure: false,
  });
  const resolveGitButlerHolds = useAtomCommand(vcsEnvironment.gitButlerResolveHolds, {
    reportFailure: false,
  });
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const canWriteSourceControl = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const canOperateThread = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canChangeThreadBranch = canWriteSourceControl && canOperateThread;
  // Only the thread's own folder has a branch the thread records, which takes operating the thread.
  const followsThreadBranch = repository === undefined;
  const canCreateFeatureBranch = followsThreadBranch
    ? canChangeThreadBranch
    : canWriteSourceControl;
  const threadWorktree = useSelectedThreadWorktree();
  const { selectedThreadWorktreePath } = threadWorktree;
  const selectedThreadCwd = repository?.cwd ?? threadWorktree.selectedThreadCwd;
  const gitStatus = useEnvironmentQuery(
    selectedThread && selectedThreadCwd
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  // A thread links GitButler branches of its own folder; a tracked repository has no link.
  const isGitButlerWorkspace =
    followsThreadBranch &&
    selectedThreadWorktreePath === null &&
    isGitButlerWorkspaceRef(gitStatus.data?.refName ?? "");
  const environmentId = selectedThread?.environmentId ?? null;
  const canApplyGitButlerBranch =
    useAtomValue(vcsEnvironment.gitButlerApply.permissionAtom(environmentId)) && canOperateThread;
  const canUnapplyGitButlerBranch = useAtomValue(
    vcsEnvironment.gitButlerUnapply.permissionAtom(environmentId),
  );
  const canCreateGitButlerBranch =
    useAtomValue(vcsEnvironment.gitButlerCreateBranch.permissionAtom(environmentId)) &&
    canOperateThread;
  const runStackedAction = useAtomCommand(
    vcsActionManager.runStackedAction({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    { reportFailure: false },
  );

  const selectedThreadGitRootCwd = repository?.cwd ?? selectedThreadProject?.workspaceRoot ?? null;
  const branchTarget = {
    environmentId: selectedThread?.environmentId ?? null,
    cwd: selectedThreadGitRootCwd,
    query: null,
  };
  const branchState = useBranches(branchTarget);
  const updateThreadGitContext = async (
    thread: NonNullable<typeof selectedThread>,
    nextState: {
      readonly branch?: string | null;
      readonly worktreePath?: string | null;
      readonly gitbutlerBranch?: string | null;
    },
  ) => {
    if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
      return AsyncResult.failure<never, EnvironmentAuthorizationError>(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthOrchestrationOperateScope,
            message: m(msg("This connection cannot update the thread's branch.")),
          }),
        ),
      );
    }
    return updateThreadMetadata({
      environmentId: thread.environmentId,
      input: {
        threadId: thread.id,
        ...(nextState.branch !== undefined ? { branch: nextState.branch } : {}),
        ...(nextState.worktreePath !== undefined ? { worktreePath: nextState.worktreePath } : {}),
        ...(nextState.gitbutlerBranch !== undefined
          ? { gitbutlerBranch: nextState.gitbutlerBranch }
          : {}),
      },
    });
  };

  const refreshSelectedThreadGitStatus = async (options?: {
    readonly quiet?: boolean;
    readonly cwd?: string | null;
  }) => {
    if (!selectedThread || !selectedThreadProject) {
      return null;
    }

    const cwd = options?.cwd ?? selectedThreadCwd;
    if (!cwd) {
      return null;
    }

    const target = { environmentId: selectedThread.environmentId, cwd };
    const execute = () =>
      refreshStatus({
        environmentId: selectedThread.environmentId,
        input: { cwd },
      });
    const result = options?.quiet
      ? await execute()
      : await vcsActionManager.track(
          appAtomRegistry,
          target,
          {
            operation: "refresh_status",
            label: m(msg("Refreshing source control status")),
          },
          execute,
        );
    if (AsyncResult.isFailure(result)) {
      setPendingConnectionError(refreshFailureMessage(result.cause));
      return null;
    }
    setPendingConnectionError(null);
    return result.value;
  };

  useAtomMount(
    selectedThreadStatusRevalidation(
      selectedThread && selectedThreadProject && selectedThreadCwd
        ? { environmentId: selectedThread.environmentId, cwd: selectedThreadCwd }
        : null,
    ),
  );

  const runSelectedThreadGitMutation = async <T, E>(
    operation: VcsActionOperation,
    label: string,
    execute: (input: {
      readonly thread: EnvironmentThreadShell;
      readonly project: EnvironmentProject;
      readonly cwd: string;
    }) => Promise<AtomCommandResult<T, E>>,
    options?: { readonly managedExternally?: boolean; readonly changesThreadBranch?: boolean },
  ): Promise<T | null> => {
    if (
      !selectedThread ||
      !selectedThreadProject ||
      !selectedThreadCwd ||
      !readEnvironmentScope(selectedThread.environmentId, AuthSourceControlWriteScope) ||
      (options?.changesThreadBranch === true &&
        followsThreadBranch &&
        !readEnvironmentScope(selectedThread.environmentId, AuthOrchestrationOperateScope))
    ) {
      return null;
    }

    const target = {
      environmentId: selectedThread.environmentId,
      cwd: selectedThreadCwd,
    };
    setPendingConnectionError(null);
    if (repository !== undefined) {
      noteRepositoryGitAction({
        threadRef: { environmentId: selectedThread.environmentId, threadId: selectedThread.id },
        cwd: selectedThreadCwd,
      });
    }
    const run = () =>
      execute({
        thread: selectedThread,
        project: selectedThreadProject,
        cwd: selectedThreadCwd,
      });
    const result =
      options?.managedExternally === true
        ? await run()
        : await vcsActionManager.track(appAtomRegistry, target, { operation, label }, run);
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      const message = errorDisplayMessage(error, m) ?? m(msg("Git action failed."));
      setPendingConnectionError(message);
      showGitActionResult({
        type: "error",
        title: m(msg("Git action failed")),
        description: message,
      });
      return null;
    }
    return result.value;
  };

  const refreshSelectedThreadBranches = async (): Promise<ReadonlyArray<VcsRef> | null> => {
    if (branchTarget.environmentId === null || branchTarget.cwd === null) return null;
    const result = await readRefs({
      environmentId: branchTarget.environmentId,
      input: { cwd: branchTarget.cwd, limit: 100, refresh: true },
    });
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      const message = errorDisplayMessage(error, m) ?? m(msg("Failed to refresh branches."));
      setPendingConnectionError(message);
      showGitActionResult({
        type: "error",
        title: m(msg("Git action failed")),
        description: message,
      });
      return null;
    }
    setPendingConnectionError(null);
    return dedupeRemoteBranchesWithLocalMatches(result.value.refs).filter(
      (branch) => !branch.isRemote,
    );
  };

  const syncSelectedThreadBranchState = async (input: {
    readonly thread: EnvironmentThreadShell;
    readonly cwd: string;
    readonly nextThreadState?: {
      readonly branch?: string | null;
      readonly worktreePath?: string | null;
      readonly gitbutlerBranch?: string | null;
    };
  }): Promise<AtomCommandResult<void, unknown>> => {
    // Git already changed; refresh even if metadata updates fail so the sheet shows the current branch.
    const updateResult =
      input.nextThreadState && followsThreadBranch
        ? await updateThreadGitContext(input.thread, input.nextThreadState)
        : AsyncResult.success(undefined);
    branchState.refresh();
    await refreshSelectedThreadGitStatus({ quiet: true, cwd: input.cwd });
    return AsyncResult.isFailure(updateResult)
      ? AsyncResult.failure(updateResult.cause)
      : AsyncResult.success(undefined);
  };

  const onApplyGitButlerBranch = (branch: string, create = false) =>
    runSelectedThreadGitMutation(
      create ? "create_ref" : "switch_ref",
      create ? "Creating GitButler branch" : "Applying GitButler branch",
      async ({ thread, cwd }) => {
        const result = await (create ? createGitButlerBranch : applyGitButlerBranch)({
          environmentId: thread.environmentId,
          input: { cwd, branch },
        });
        if (AsyncResult.isFailure(result)) return result;
        const syncResult = await syncSelectedThreadBranchState({
          thread,
          cwd,
          nextThreadState: { gitbutlerBranch: result.value.branch },
        });
        return AsyncResult.isFailure(syncResult) ? AsyncResult.failure(syncResult.cause) : result;
      },
      { changesThreadBranch: true },
    );

  const onUnapplyGitButlerBranch = (branch: string) =>
    runSelectedThreadGitMutation(
      "switch_ref",
      "Unapplying GitButler stack",
      async ({ thread, cwd }) => {
        const result = await unapplyGitButlerBranch({
          environmentId: thread.environmentId,
          input: { cwd, branch },
        });
        branchState.refresh();
        return result;
      },
    );

  const onCheckoutSelectedThreadBranch = async (branch: string) => {
    if (isGitButlerWorkspace) return onApplyGitButlerBranch(branch);
    return runSelectedThreadGitMutation(
      "switch_ref",
      m(msg("Switching branch")),
      async ({ thread, cwd }) => {
        const result = await switchRef({
          environmentId: thread.environmentId,
          input: { cwd, refName: branch },
        });
        if (AsyncResult.isFailure(result)) {
          return result;
        }
        const syncResult = await syncSelectedThreadBranchState({
          thread,
          cwd,
          nextThreadState: {
            branch: result.value.refName ?? thread.branch,
            worktreePath: selectedThreadWorktreePath,
          },
        });
        return AsyncResult.isFailure(syncResult) ? AsyncResult.failure(syncResult.cause) : result;
      },
      { changesThreadBranch: true },
    );
  };

  const onCreateSelectedThreadBranch = async (branch: string) => {
    if (isGitButlerWorkspace) return onApplyGitButlerBranch(branch, true);
    return runSelectedThreadGitMutation(
      "create_ref",
      m(msg("Creating branch")),
      async ({ thread, cwd }) => {
        const result = await createRef({
          environmentId: thread.environmentId,
          input: { cwd, refName: branch, switchRef: true },
        });
        if (AsyncResult.isFailure(result)) {
          return result;
        }
        const syncResult = await syncSelectedThreadBranchState({
          thread,
          cwd,
          nextThreadState: {
            branch: result.value.refName ?? thread.branch,
            worktreePath: selectedThreadWorktreePath,
          },
        });
        return AsyncResult.isFailure(syncResult) ? AsyncResult.failure(syncResult.cause) : result;
      },
      { changesThreadBranch: true },
    );
  };

  const onCreateSelectedThreadWorktree = async (nextWorktree: {
    readonly baseBranch: string;
    readonly newBranch: string;
  }) => {
    // A worktree moves the thread, which a repository beside it never does.
    if (!followsThreadBranch) return null;
    return runSelectedThreadGitMutation(
      "create_worktree",
      m(msg("Creating worktree")),
      async ({ thread, project }) => {
        const result = await createWorktree({
          environmentId: thread.environmentId,
          input: {
            cwd: project.workspaceRoot,
            refName: nextWorktree.baseBranch,
            newRefName: sanitizeFeatureBranchName(nextWorktree.newBranch),
            path: null,
          },
        });
        if (AsyncResult.isFailure(result)) {
          return result;
        }
        const syncResult = await syncSelectedThreadBranchState({
          thread,
          cwd: result.value.worktree.path,
          nextThreadState: {
            branch: result.value.worktree.refName,
            worktreePath: result.value.worktree.path,
          },
        });
        return AsyncResult.isFailure(syncResult) ? AsyncResult.failure(syncResult.cause) : result;
      },
      { changesThreadBranch: true },
    );
  };

  const onPullSelectedThreadBranch = async () => {
    await runSelectedThreadGitMutation(
      "pull",
      m(msg("Pulling latest changes")),
      async ({ thread, cwd }) => {
        const result = await pull({
          environmentId: thread.environmentId,
          input: { cwd },
        });
        if (AsyncResult.isFailure(result)) {
          return result;
        }
        await refreshSelectedThreadGitStatus({ quiet: true, cwd });
        showGitActionResult({
          type: "success",
          title:
            result.value.status === "skipped_up_to_date"
              ? m(msg("Already up to date"))
              : m(msg("Pulled latest on {branch}", { branch: result.value.refName })),
        });
        return result;
      },
    );
  };

  // Not a mutation until someone chooses to end a hold, so a read-only connection can still look.
  const onReviewSelectedThreadHolds = async (): Promise<void> => {
    if (!selectedThread || !selectedThreadCwd) return;
    const { environmentId } = selectedThread;
    const cwd = selectedThreadCwd;
    const holds = await readGitButlerHolds({ environmentId, input: { cwd } });
    if (AsyncResult.isFailure(holds)) {
      alertGitButlerHoldFailure("Could not read held commits", Cause.squash(holds.cause));
      return;
    }
    const review = gitButlerHoldReview(holds.value.holds);
    const shown = canWriteSourceControl ? review : { ...review, resolutions: [] };
    if (!(await confirmGitButlerHoldReview(shown))) return;
    const ended = await resolveGitButlerHolds({
      environmentId,
      input: { cwd, resolutions: [...review.resolutions] },
    });
    if (AsyncResult.isFailure(ended)) {
      alertGitButlerHoldFailure("Could not end the hold", Cause.squash(ended.cause));
    }
    await refreshSelectedThreadGitStatus({ quiet: true, cwd });
  };

  const onRunSelectedThreadGitAction = async (
    input: GitActionRequestInput,
  ): Promise<GitRunStackedActionResult | null> => {
    const actionId = uuidv4();
    return await runSelectedThreadGitMutation(
      "run_change_request",
      m(msg("Running source control action")),
      async ({ thread, cwd }) => {
        let result = await runStackedAction({
          actionId,
          action: input.action,
          ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
          ...(input.featureBranch ? { featureBranch: input.featureBranch } : {}),
          ...(input.filePaths?.length ? { filePaths: [...input.filePaths] } : {}),
          ...(input.gitbutlerChangeIds?.length
            ? { gitbutlerChangeIds: [...input.gitbutlerChangeIds] }
            : {}),
          ...(input.gitbutlerForcePushApproval
            ? { gitbutlerForcePushApproval: input.gitbutlerForcePushApproval }
            : {}),
          ...(input.gitbutlerHoldApproval
            ? { gitbutlerHoldApproval: input.gitbutlerHoldApproval }
            : {}),
          threadId: thread.id,
        });
        // The server rechecks each approval, so a remote that moved again asks again.
        while (AsyncResult.isFailure(result)) {
          const confirmation = gitButlerPublishConfirmation(Cause.squash(result.cause));
          if (confirmation === null) return result;
          const decision = await confirmGitButlerPublish(confirmation);
          if (decision === "cancel") return AsyncResult.success(null);
          if (decision === "end_holds") {
            const ended = await resolveGitButlerHolds({
              environmentId: thread.environmentId,
              input: { cwd, resolutions: [...confirmation.resolutions] },
            });
            await refreshSelectedThreadGitStatus({ quiet: true, cwd });
            return AsyncResult.isFailure(ended)
              ? AsyncResult.failure(ended.cause)
              : AsyncResult.success(null);
          }
          result = await runStackedAction({
            actionId: uuidv4(),
            action: gitButlerForcePushRetryAction(input.action),
            threadId: thread.id,
            ...confirmation.approval,
          });
        }

        if (
          !result.value.branch.gitbutler &&
          result.value.branch.status === "created" &&
          result.value.branch.name
        ) {
          const syncResult = await syncSelectedThreadBranchState({
            thread,
            cwd,
            nextThreadState: {
              branch: result.value.branch.name,
              worktreePath: selectedThreadWorktreePath,
            },
          });
          if (AsyncResult.isFailure(syncResult)) {
            return AsyncResult.failure(syncResult.cause);
          }
        } else {
          await refreshSelectedThreadGitStatus({ quiet: true, cwd });
        }
        showGitActionResult({
          type: "success",
          title: result.value.toast.title,
          description: result.value.toast.description,
          prUrl: result.value.toast.cta.kind === "open_pr" ? result.value.toast.cta.url : undefined,
        });
        return result;
      },
      { managedExternally: true, changesThreadBranch: input.featureBranch === true },
    );
  };

  return {
    canWriteSourceControl,
    canChangeThreadBranch,
    canCreateFeatureBranch,
    canApplyGitButlerBranch,
    canUnapplyGitButlerBranch,
    canCreateGitButlerBranch,
    onUnapplyGitButlerBranch,
    refreshSelectedThreadGitStatus,
    refreshSelectedThreadBranches,
    onCheckoutSelectedThreadBranch,
    onCreateSelectedThreadBranch,
    onCreateSelectedThreadWorktree,
    onPullSelectedThreadBranch,
    onRunSelectedThreadGitAction,
    onReviewSelectedThreadHolds,
  };
}
