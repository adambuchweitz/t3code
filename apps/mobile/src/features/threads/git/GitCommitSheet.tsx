import { FitSheet } from "../../../components/ui/FitSheet";
import { SheetHeader } from "../../../components/ui/SheetHeader";
import { Button } from "../../../components/ui/Button";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { msg, T, useGT, useMessages, Var } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import {
  gitButlerActionStatus,
  gitButlerCommitSelectionView,
  gitButlerLinkedBranch,
  isGitButlerCommitFileSelected,
  reviewedGitButlerCommitSelection,
  toggleGitButlerCommitFiles,
} from "@t3tools/client-runtime/state/vcs";
import type { GitButlerCommitFile } from "@t3tools/contracts";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import { useEnvironmentQuery } from "../../../state/query";
import {
  gitRepositoryTargetFromRoute,
  type GitRepositoryRouteParams,
} from "../../../state/thread-git-target";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { m, type MessageResolver } from "../../../i18n/messages";

type GitCommitSheetProps = StaticScreenProps<
  {
    readonly environmentId: string;
    readonly threadId: string;
  } & GitRepositoryRouteParams
>;

function CommitFileRow(props: {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
  readonly included: boolean;
  readonly note?: string | null;
  /** Absent for a file that can only be shown. */
  readonly onToggle?: () => void;
}) {
  const slash = props.path.lastIndexOf("/");
  const name = props.path.slice(slash + 1);
  const directory = slash >= 0 ? props.path.slice(0, slash) : null;
  return (
    <Pressable
      className="min-h-16 flex-row items-center gap-3 border-t border-border-subtle py-3"
      accessibilityRole="checkbox"
      accessibilityLabel={props.path}
      accessibilityState={{ checked: props.included, disabled: !props.onToggle }}
      disabled={!props.onToggle}
      onPress={props.onToggle}
    >
      {props.onToggle ? (
        <View
          className={cn(
            "size-5 items-center justify-center rounded-full",
            props.included ? "bg-primary" : "border border-input-border",
          )}
        >
          {props.included ? (
            <SymbolView name="checkmark" size={13} tintColorClassName="accent-primary-foreground" />
          ) : null}
        </View>
      ) : null}
      <View className="flex-1 gap-1">
        <Text
          numberOfLines={1}
          ellipsizeMode="middle"
          className="text-sm font-t3-medium text-foreground"
        >
          {name}
        </Text>
        {directory ? (
          <Text numberOfLines={1} ellipsizeMode="middle" className="text-xs text-foreground-muted">
            {directory}
          </Text>
        ) : null}
        {props.note ? <Text className="text-xs text-foreground-muted">{props.note}</Text> : null}
      </View>
      <View className="flex-row gap-2">
        <Text className="text-xs text-adaptive-emerald-700-300">
          +{formatDiffCount(props.insertions)}
        </Text>
        <Text className="text-xs text-adaptive-rose-700-300">
          −{formatDiffCount(props.deletions)}
        </Text>
      </View>
    </Pressable>
  );
}

function gitButlerFileNote(file: GitButlerCommitFile, resolve: MessageResolver = m) {
  const count = file.changeIds.length;
  if (file.scope === "locked") {
    if (file.assignedBranch) {
      return resolve(msg("Assigned to {branch}", { branch: file.assignedBranch }));
    }
    return file.changedElsewhere
      ? resolve(msg("Also changed on another branch"))
      : resolve(msg("Can't be committed here"));
  }
  if (file.scope === "mixed") {
    return count > 1
      ? resolve(
          msg(
            "{count, plural, one {{count} hunks, some unassigned} other {{count} hunks, some unassigned}}",
            { count },
          ),
        )
      : resolve(msg("Partly unassigned"));
  }
  return count > 1
    ? resolve(msg("{count, plural, one {{count} hunks} other {{count} hunks}}", { count }))
    : null;
}

function GitButlerFileGroup(props: {
  readonly title: string;
  readonly description?: string;
  readonly files: ReadonlyArray<GitButlerCommitFile>;
  readonly selected: ReadonlySet<string>;
  readonly onChange: (selected: ReadonlySet<string>) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { files, selected, onChange } = props;
  if (files.length === 0) return null;
  const selectable = files.filter((file) => file.scope !== "locked");
  const allSelected = selectable.every((file) => isGitButlerCommitFileSelected(file, selected));
  return (
    <View>
      <View className="flex-row items-center justify-between gap-2 pb-2">
        <View className="flex-1 gap-1">
          <Text className="text-base font-t3-bold text-foreground">{props.title}</Text>
          {props.description ? (
            <Text className="text-xs text-foreground-muted">{props.description}</Text>
          ) : null}
        </View>
        {selectable.length > 0 ? (
          <Button
            label={allSelected ? gt("Deselect all") : gt("Select all")}
            tone="text"
            onPress={() => onChange(toggleGitButlerCommitFiles(selectable, selected))}
          />
        ) : null}
      </View>
      {files.map((file) => (
        <CommitFileRow
          key={file.path}
          path={file.path}
          insertions={file.insertions}
          deletions={file.deletions}
          included={isGitButlerCommitFileSelected(file, selected)}
          note={gitButlerFileNote(file, messages)}
          {...(file.scope === "locked"
            ? {}
            : { onToggle: () => onChange(toggleGitButlerCommitFiles([file], selected)) })}
        />
      ))}
    </View>
  );
}

export function GitCommitSheet(props: GitCommitSheetProps) {
  const repository = gitRepositoryTargetFromRoute(props.route.params);
  const gt = useGT();
  const navigation = useNavigation();
  const { selectedThread } = useThreadSelection();
  const threadWorktree = useSelectedThreadWorktree();
  const selectedThreadCwd = repository?.cwd ?? threadWorktree.selectedThreadCwd;
  const gitState = useSelectedThreadGitState(repository);
  const gitActions = useSelectedThreadGitActions(repository);
  const { canWriteSourceControl, canCreateFeatureBranch } = gitActions;

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const busy = gitState.gitOperationLabel !== null;
  const isDefaultRef = gitStatus.data?.isDefaultRef ?? false;
  const allFiles = gitStatus.data?.workingTree?.files ?? [];
  // Fixed once known. If the checkout's mode changes underneath, what was chosen must not become a
  // plain commit of everything; the server refuses the mismatch instead.
  const [openedInGitButler, setOpenedInGitButler] = useState<boolean | null>(null);
  if (openedInGitButler === null && gitStatus.data) {
    setOpenedInGitButler(gitStatus.data.workspace?._tag === "gitbutler");
  }
  const isGitButler = openedInGitButler === true;
  // The thread's link names a branch of its own folder, not of a tracked repository.
  const linkedBranch = repository === undefined ? selectedThread?.gitbutlerBranch : null;
  const actionStatus = gitButlerActionStatus(gitStatus.data, linkedBranch);
  const appliedBranch = gitButlerLinkedBranch(gitStatus.data, linkedBranch);
  const commitChanges = useEnvironmentQuery(
    isGitButler && selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.gitButlerCommitChanges({
          environmentId: selectedThread.environmentId,
          input: {
            cwd: selectedThreadCwd,
            ...(appliedBranch === null ? {} : { branch: appliedBranch }),
          },
        })
      : null,
  );

  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [gitButlerSelection, setGitButlerSelection] = useState<ReadonlySet<string>>(new Set());
  const gitButlerView = commitChanges.data
    ? gitButlerCommitSelectionView(commitChanges.data.files, gitButlerSelection)
    : null;

  const selectedFiles = allFiles.filter((file) => !excludedFiles.has(file.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;
  const canCommit = isGitButler ? gitButlerView?.canCommit === true : !noneSelected;
  const canCommitOnNewBranch = isGitButler
    ? gitButlerView?.canCommitOnNewBranch === true
    : !noneSelected;
  const selectedInsertions = selectedFiles.reduce((sum, file) => sum + file.insertions, 0);
  const selectedDeletions = selectedFiles.reduce((sum, file) => sum + file.deletions, 0);

  const runCommitAction = async (featureBranch: boolean) => {
    if (!canWriteSourceControl || (featureBranch && !canCreateFeatureBranch)) return;
    const selectionInput = isGitButler
      ? { gitbutlerChangeIds: [...gitButlerSelection] }
      : !allSelected
        ? { filePaths: selectedFiles.map((file) => file.path) }
        : {};
    const commitMessage = dialogCommitMessage.trim();
    navigation.goBack();
    await gitActions.onRunSelectedThreadGitAction({
      action: "commit",
      featureBranch,
      ...(commitMessage ? { commitMessage } : {}),
      ...selectionInput,
    });
  };

  return (
    <FitSheet
      header={
        <SheetHeader
          title={gt("Commit changes")}
          subtitle={[
            repository?.name,
            actionStatus?.refName ??
              (isGitButler ? gt("New GitButler branch") : gt("(detached HEAD)")),
          ]
            .filter(Boolean)
            .join(" · ")}
          onCancel={() => navigation.goBack()}
          accessibilityLabel={gt("Cancel commit")}
        />
      }
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      contentContainerClassName="px-5 pt-4 gap-5"
    >
      {isDefaultRef ? (
        <Text className="text-sm text-warning-foreground">
          <T>You’re on the default branch. You can create a new branch when committing.</T>
        </Text>
      ) : null}
      <View className="gap-2">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Commit message</T>
        </Text>
        <TextInput
          multiline
          accessibilityLabel={gt("Commit message")}
          value={dialogCommitMessage}
          onChangeText={setDialogCommitMessage}
          placeholder={gt("Describe your changes…")}
          textAlignVertical="top"
          className="min-h-24 rounded-xl bg-subtle px-4 py-3 text-base"
        />
        <Text className="text-xs text-foreground-muted">
          <T>Leave empty to generate a message automatically.</T>
        </Text>
      </View>
      {isGitButler ? (
        <View className="gap-5">
          <Text className="text-xs text-foreground-muted">
            <T>
              Nothing is included until you choose it. Each file commits the changes it has now.
            </T>
          </Text>
          {commitChanges.error ? (
            <Text className="text-sm text-danger-foreground">{commitChanges.error}</Text>
          ) : null}
          {gitButlerView === null ? (
            commitChanges.error ? null : (
              <Text className="py-4 text-sm text-foreground-muted">
                <T>Loading changes…</T>
              </Text>
            )
          ) : (
            <>
              {gitButlerView.needsReview ? (
                <View className="gap-1" accessibilityRole="alert">
                  <Text className="text-sm text-warning-foreground">
                    <T>A change you chose was edited, committed, or locked.</T>
                  </Text>
                  <Button
                    label={gt("Remove it")}
                    tone="text"
                    onPress={() =>
                      setGitButlerSelection((selected) =>
                        reviewedGitButlerCommitSelection(commitChanges.data?.files ?? [], selected),
                      )
                    }
                  />
                </View>
              ) : null}
              <GitButlerFileGroup
                title={
                  appliedBranch === null
                    ? gt("Assigned to this branch")
                    : gt("Assigned to {branch}", { branch: appliedBranch })
                }
                files={gitButlerView.assigned}
                selected={gitButlerSelection}
                onChange={setGitButlerSelection}
              />
              <GitButlerFileGroup
                title={gt("Shared, not assigned to a branch")}
                description={gt("These may belong to another agent or person using this checkout.")}
                files={gitButlerView.shared}
                selected={gitButlerSelection}
                onChange={setGitButlerSelection}
              />
              <GitButlerFileGroup
                title={gt("Unavailable", { $context: "files that can't be committed here" })}
                description={gt("Commit these from GitButler.")}
                files={gitButlerView.locked}
                selected={gitButlerSelection}
                onChange={setGitButlerSelection}
              />
              <Text className="text-xs text-foreground-muted">
                {gt(
                  "{count, plural, one {{count} selected · +{insertions} −{deletions}} other {{count} selected · +{insertions} −{deletions}}}",
                  {
                    count: gitButlerView.selectedFileCount,
                    insertions: formatDiffCount(gitButlerView.insertions),
                    deletions: formatDiffCount(gitButlerView.deletions),
                  },
                )}
              </Text>
            </>
          )}
        </View>
      ) : (
        <View>
          <View className="flex-row items-center justify-between gap-2 pb-2">
            <View className="flex-1 gap-1">
              <Text className="text-base font-t3-bold text-foreground">
                <T>Changed files</T>
              </Text>
              <Text className="text-xs text-foreground-muted">
                <T>
                  <Var>{selectedFiles.length}</Var> of <Var>{allFiles.length}</Var> selected · +
                  <Var>{formatDiffCount(selectedInsertions)}</Var> −
                  <Var>{formatDiffCount(selectedDeletions)}</Var>
                </T>
              </Text>
            </View>
            {allFiles.length > 0 ? (
              <Button
                label={
                  allSelected
                    ? gt("Deselect all")
                    : gt("Select all", { $context: "selects every changed file to commit" })
                }
                tone="text"
                onPress={() =>
                  setExcludedFiles(
                    allSelected ? new Set(allFiles.map((file) => file.path)) : new Set(),
                  )
                }
              />
            ) : null}
          </View>
          {allFiles.length === 0 ? (
            <Text className="py-4 text-sm text-foreground-muted">
              <T>No changed files to commit.</T>
            </Text>
          ) : (
            allFiles.map((file) => {
              const included = !excludedFiles.has(file.path);
              const slash = file.path.lastIndexOf("/");
              const name = file.path.slice(slash + 1);
              const directory = slash >= 0 ? file.path.slice(0, slash) : null;
              return (
                <Pressable
                  key={file.path}
                  className="min-h-16 flex-row items-center gap-3 border-t border-border-subtle py-3"
                  accessibilityRole="checkbox"
                  accessibilityLabel={file.path}
                  accessibilityState={{ checked: included }}
                  onPress={() =>
                    setExcludedFiles((current) => {
                      const next = new Set(current);
                      if (next.has(file.path)) next.delete(file.path);
                      else next.add(file.path);
                      return next;
                    })
                  }
                >
                  <View
                    className={cn(
                      "size-5 items-center justify-center rounded-full",
                      included ? "bg-primary" : "border border-input-border",
                    )}
                  >
                    {included ? (
                      <SymbolView
                        name="checkmark"
                        size={13}
                        tintColorClassName="accent-primary-foreground"
                      />
                    ) : null}
                  </View>
                  <View className="flex-1 gap-1">
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="middle"
                      className="text-sm font-t3-medium text-foreground"
                    >
                      {name}
                    </Text>
                    {directory ? (
                      <Text
                        numberOfLines={1}
                        ellipsizeMode="middle"
                        className="text-xs text-foreground-muted"
                      >
                        {directory}
                      </Text>
                    ) : null}
                  </View>
                  <View className="flex-row gap-2">
                    <Text className="text-xs text-adaptive-emerald-700-300">
                      +{formatDiffCount(file.insertions)}
                    </Text>
                    <Text className="text-xs text-adaptive-rose-700-300">
                      −{formatDiffCount(file.deletions)}
                    </Text>
                  </View>
                </Pressable>
              );
            })
          )}
        </View>
      )}
      <View className="gap-2">
        <Button
          label={gt("Commit changes")}
          icon="checkmark"
          tone="primary"
          fullWidth
          disabled={!canWriteSourceControl || !canCommit || busy}
          onPress={() => void runCommitAction(false)}
        />
        <Button
          label={gt("Commit on a new branch")}
          icon="arrow.branch"
          tone="text"
          fullWidth
          disabled={
            !canWriteSourceControl || !canCreateFeatureBranch || !canCommitOnNewBranch || busy
          }
          onPress={() => void runCommitAction(true)}
        />
      </View>
    </FitSheet>
  );
}
