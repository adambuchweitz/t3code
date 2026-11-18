import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  filterBranchPickerRefs,
  gitButlerPickerSections,
  isGitButlerWorkspaceRef,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useState } from "react";

import { SheetHeader } from "../../../components/ui/SheetHeader";
import { FitSheet } from "../../../components/ui/FitSheet";
import { FormField, FormSection } from "../../../components/ui/FormSection";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListSection } from "../../../components/ui/ListSection";
import { useEnvironmentQuery } from "../../../state/query";
import { usePaginatedBranches } from "../../../state/queries";
import { useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { threadEnvironment } from "../../../state/threads";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { useRefreshBranchesOnFocus } from "../use-refresh-branches-on-focus";
import { SheetActionButton } from "./gitSheetComponents";
import * as Dialog from "../../../components/ui/Dialog";
import { Button } from "../../../components/ui/Button";

type GitBranchesSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function GitBranchesSheet(_props: GitBranchesSheetProps) {
  const gt = useGT();
  const navigation = useNavigation();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd, selectedThreadWorktreePath } = useSelectedThreadWorktree();
  useRefreshBranchesOnFocus(selectedThread?.environmentId, selectedThreadCwd);
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const { canChangeThreadBranch } = gitActions;

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const currentBranch = gitStatus.data?.refName ?? selectedThread?.branch ?? null;
  const gitButlerSections = gitButlerPickerSections(
    gitState.selectedThreadRefs,
    gitStatus.data?.workspace,
  );
  const canAssociateBranch = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const setAssociation = (gitbutlerBranch: string | null) => {
    if (!selectedThread || !canAssociateBranch) return;
    void updateMetadata({
      environmentId: selectedThread.environmentId,
      input: { threadId: selectedThread.id, gitbutlerBranch },
    }).then((result) => {
      if (result._tag === "Success") navigation.goBack();
    });
  };
  const currentWorktreePath = selectedThreadCwd;
  const branchPages = usePaginatedBranches({
    environmentId: selectedThread?.environmentId ?? null,
    cwd: selectedThreadCwd,
    query: null,
    refKind: "local",
  });
  // The saved first page shows until the live pages answer, including offline.
  // Servers older than refKind return remote refs too.
  const pagedBranches =
    branchPages.data === null
      ? gitState.selectedThreadBranches
      : branchPages.refs.filter((branch) => !branch.isRemote);
  const isGitButlerWorkspace =
    selectedThreadWorktreePath === null &&
    currentBranch !== null &&
    isGitButlerWorkspaceRef(currentBranch);
  const availableBranches = isGitButlerWorkspace
    ? gitButlerSections.unappliedRefs
    : filterBranchPickerRefs(pagedBranches, {
        currentRefName: currentBranch,
        workspace: gitStatus.data?.workspace,
        isSelectingWorktreeBase: false,
      });
  // Live ref pages stay waiting for changes, so only an unanswered first page is loading.
  const branchesLoading =
    branchPages.data === null && branchPages.isPending && availableBranches.length === 0;
  const busy = gitState.gitOperationLabel !== null;

  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeBaseBranchOverride, setWorktreeBaseBranchOverride] = useState<string | null>(null);
  const worktreeBaseBranch =
    worktreeBaseBranchOverride ??
    (currentBranch === null || currentBranch.startsWith("gitbutler/")
      ? (gitState.selectedThreadBranches.find(
          (branch) => branch.isDefault && !branch.name.startsWith("gitbutler/"),
        )?.name ?? "main")
      : currentBranch);
  const [worktreeBranchName, setWorktreeBranchName] = useState("");

  const disabledExistingBranchNames: Array<string> = [];
  for (const branch of availableBranches) {
    if (branch.worktreePath !== null && branch.worktreePath !== currentWorktreePath) {
      disabledExistingBranchNames.push(branch.name);
    }
  }
  const disabledExistingBranches = new Set(disabledExistingBranchNames);
  const requestUnapply = (branch: string, stack: readonly string[]) => {
    Dialog.confirm({
      title: gt("Unapply this stack?"),
      confirmText: gt("Unapply stack"),
      destructive: true,
      message: gt(
        "Branches: {branches}\n\nThis removes the whole stack from the working tree for every thread and agent sharing this checkout. You can apply it again later.",
        { branches: stack.join(", ") },
      ),
      onConfirm: () => {
        void gitActions.onUnapplyGitButlerBranch(branch);
      },
    });
  };

  return (
    <FitSheet
      header={
        <SheetHeader title={gt("Branches & worktrees")} onClose={() => navigation.goBack()} />
      }
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {isGitButlerWorkspace && gitStatus.data?.workspace?._tag === "gitbutler" ? (
        <ListSection
          title={gt("GitButler branches")}
          footer={
            gitButlerSections.appliedStacks.length <= 1
              ? gt(
                  "Apply adds branches; unapply removes their stack for everyone. Keep at least one stack applied; use GitButler directly to leave the workspace.",
                )
              : gt("Apply adds branches; unapply removes their stack for everyone.")
          }
        >
          <ListChoiceRow
            label={gt("Whole GitButler workspace")}
            selected={(selectedThread?.gitbutlerBranch ?? null) === null}
            disabled={!canAssociateBranch || busy}
            onPress={() => setAssociation(null)}
          />
          {gitButlerSections.appliedStacks.flatMap((stack) =>
            stack.map((branch) => (
              <ListChoiceRow
                key={branch}
                label={branch}
                description={
                  stack.length > 1
                    ? gt("Applied · stack {branch}", { branch: stack.at(-1) })
                    : gt("Applied", { $context: "GitButler branch applied in the workspace" })
                }
                selected={(selectedThread?.gitbutlerBranch ?? null) === branch}
                separated
                disabled={!canAssociateBranch || busy}
                onPress={() => setAssociation(branch)}
                meta={
                  <Button
                    label={gt("Unapply", { $context: "verb, remove a GitButler stack" })}
                    accessibilityLabel={gt("Unapply stack containing {branch}", { branch })}
                    disabled={
                      !gitActions.canUnapplyGitButlerBranch ||
                      busy ||
                      gitButlerSections.appliedStacks.length <= 1
                    }
                    onPress={() => requestUnapply(branch, stack)}
                  />
                }
              />
            )),
          )}
        </ListSection>
      ) : null}

      <FormSection title={gt("New branch")}>
        <FormField
          value={newBranchName}
          onChangeText={setNewBranchName}
          placeholder="feature/mobile-polish"
          accessibilityLabel={gt("New branch name")}
        />
        <SheetActionButton
          icon="plus"
          label={isGitButlerWorkspace ? gt("Create & apply") : gt("Create & checkout")}
          tone="primary"
          disabled={
            !(isGitButlerWorkspace ? gitActions.canCreateGitButlerBranch : canChangeThreadBranch) ||
            busy ||
            newBranchName.trim().length === 0
          }
          onPress={() => {
            const branch = sanitizeFeatureBranchName(newBranchName.trim());
            if (branch.length === 0) return;
            void gitActions.onCreateSelectedThreadBranch(branch).then((result) => {
              if (result === null || !navigation.isFocused()) return;
              setNewBranchName("");
              navigation.goBack();
            });
          }}
        />
      </FormSection>

      <FormSection title={gt("New worktree")}>
        <FormField
          label={gt("Base branch")}
          value={worktreeBaseBranch}
          onChangeText={setWorktreeBaseBranchOverride}
          placeholder="main"
          accessibilityLabel={gt("Worktree base branch")}
        />
        <FormField
          label={gt("New branch")}
          value={worktreeBranchName}
          onChangeText={setWorktreeBranchName}
          placeholder="feature/mobile-thread"
          accessibilityLabel={gt("Worktree branch name")}
        />
        <SheetActionButton
          icon="square.split.2x1"
          label={gt("Create worktree")}
          tone="primary"
          disabled={
            !canChangeThreadBranch ||
            busy ||
            worktreeBaseBranch.trim().length === 0 ||
            worktreeBaseBranch.trim().startsWith("gitbutler/") ||
            worktreeBranchName.trim().length === 0
          }
          onPress={() => {
            const baseBranch = worktreeBaseBranch.trim();
            const newBranch = worktreeBranchName.trim();
            if (baseBranch.length === 0 || newBranch.length === 0) return;
            void gitActions
              .onCreateSelectedThreadWorktree({ baseBranch, newBranch })
              .then((result) => {
                if (result === null || !navigation.isFocused()) return;
                setWorktreeBranchName("");
                navigation.goBack();
              });
          }}
        />
      </FormSection>

      <ListSection
        title={isGitButlerWorkspace ? gt("Not applied") : gt("Existing branches")}
        footer={
          branchesLoading
            ? gt("Loading branches...")
            : availableBranches.length === 0
              ? isGitButlerWorkspace
                ? gt("No unapplied branches found.")
                : gt("No local branches found.")
              : undefined
        }
      >
        {availableBranches.map((branch, index) => {
          const disabled = disabledExistingBranches.has(branch.name);
          const subtitle = branch.worktreePath
            ? branch.worktreePath === currentWorktreePath
              ? gt("Checked out in this thread")
              : gt("Checked out in another worktree")
            : branch.isRemote
              ? gt("Remote branch · apply to workspace")
              : branch.isDefault
                ? gt("Default branch")
                : gt("Local branch");

          return (
            <ListChoiceRow
              key={branch.name}
              label={branch.name}
              description={subtitle}
              selected={branch.current}
              separated={index > 0}
              disabled={
                !(isGitButlerWorkspace
                  ? gitActions.canApplyGitButlerBranch
                  : canChangeThreadBranch) ||
                busy ||
                disabled
              }
              onPress={() => {
                void gitActions.onCheckoutSelectedThreadBranch(branch.name).then((result) => {
                  if (result === null || !navigation.isFocused()) return;
                  navigation.goBack();
                });
              }}
            />
          );
        })}
      </ListSection>
      {branchPages.data?.nextCursor != null ? (
        <SheetActionButton
          icon="arrow.down.circle"
          label={gt("Load more")}
          disabled={branchPages.isFetchingNextPage}
          onPress={branchPages.loadNext}
        />
      ) : null}
    </FitSheet>
  );
}
