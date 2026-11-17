import {
  isGitButlerCommitFileSelected,
  toggleGitButlerCommitFiles,
  type GitButlerCommitSelectionView,
} from "@t3tools/client-runtime/state/vcs";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { GitButlerCommitFile } from "@t3tools/contracts";

import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { ScrollArea } from "./ui/scroll-area";
import { StartTruncatedPath } from "./StartTruncatedPath";

function fileNote(file: GitButlerCommitFile) {
  const hunks = file.changeIds.length > 1 ? `${file.changeIds.length} hunks` : null;
  if (file.scope === "locked") {
    if (file.assignedBranch) return `Assigned to ${file.assignedBranch}`;
    return file.changedElsewhere ? "Also changed on another branch" : "Can't be committed here";
  }
  if (file.scope === "mixed") {
    return hunks ? `${hunks}, some unassigned` : "Partly unassigned";
  }
  return hunks;
}

function FileGroup(props: {
  readonly title: string;
  readonly description?: string;
  readonly files: ReadonlyArray<GitButlerCommitFile>;
  readonly selected: ReadonlySet<string>;
  readonly onChange: (selected: ReadonlySet<string>) => void;
  readonly canOpenFile: boolean;
  readonly onOpenFile: (path: string) => void;
}) {
  const { files, selected, onChange } = props;
  if (files.length === 0) return null;
  const selectable = files.filter((file) => file.scope !== "locked");
  const selectedCount = selectable.filter((file) =>
    isGitButlerCommitFileSelected(file, selected),
  ).length;
  return (
    <section className="space-y-1">
      <div className="flex items-start gap-2 px-2 pt-1">
        {selectable.length > 0 && (
          <span className="mt-0.5 flex">
            <Checkbox
              aria-label={`Select all: ${props.title}`}
              checked={selectedCount === selectable.length}
              indeterminate={selectedCount > 0 && selectedCount < selectable.length}
              onCheckedChange={() => onChange(toggleGitButlerCommitFiles(selectable, selected))}
            />
          </span>
        )}
        <div className="min-w-0">
          <h3 className="text-xs font-medium">{props.title}</h3>
          {props.description && (
            <p className="text-xs text-muted-foreground">{props.description}</p>
          )}
        </div>
      </div>
      {files.map((file) => {
        const note = fileNote(file);
        return (
          <div
            key={file.path}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent/50"
          >
            {file.scope !== "locked" && (
              <Checkbox
                aria-label={`Include ${file.path}`}
                checked={isGitButlerCommitFileSelected(file, selected)}
                onCheckedChange={() => onChange(toggleGitButlerCommitFiles([file], selected))}
              />
            )}
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left enabled:cursor-pointer"
              disabled={!props.canOpenFile}
              aria-label={`Open ${file.path} in editor`}
              onClick={() => props.onOpenFile(file.path)}
            >
              <StartTruncatedPath
                path={file.path}
                className={`flex-1${file.scope === "locked" ? " text-muted-foreground" : ""}`}
              />
              <span className="shrink-0 text-right">
                {note && <span className="me-2 font-sans text-muted-foreground">{note}</span>}
                <span className="text-diff-addition">+{formatDiffCount(file.insertions)}</span>
                <span className="text-muted-foreground"> / </span>
                <span className="text-diff-deletion">-{formatDiffCount(file.deletions)}</span>
              </span>
            </button>
          </div>
        );
      })}
    </section>
  );
}

export function GitButlerCommitFiles(props: {
  readonly branch: string | null;
  readonly view: GitButlerCommitSelectionView | null;
  readonly error: string | null;
  readonly selected: ReadonlySet<string>;
  readonly onChange: (selected: ReadonlySet<string>) => void;
  readonly onReview: () => void;
  readonly canOpenFile: boolean;
  readonly onOpenFile: (path: string) => void;
}) {
  const { view } = props;
  const group = {
    selected: props.selected,
    onChange: props.onChange,
    canOpenFile: props.canOpenFile,
    onOpenFile: props.onOpenFile,
  };
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Nothing is included until you choose it. Each file commits the changes it has now.
      </p>
      {props.error && <p className="text-xs text-destructive-foreground">{props.error}</p>}
      {view === null ? (
        !props.error && <p className="text-muted-foreground">Loading changes…</p>
      ) : view.assigned.length + view.shared.length + view.locked.length === 0 ? (
        <p className="font-medium">none</p>
      ) : (
        <>
          {view.needsReview && (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 text-xs text-warning"
            >
              <span>A change you chose was edited, committed, or locked.</span>
              <Button variant="outline" size="xs" onClick={props.onReview}>
                Remove it
              </Button>
            </div>
          )}
          <div className="h-52 rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/[0.025] dark:ring-white/5">
            <ScrollArea>
              <div className="space-y-3 p-1">
                <FileGroup
                  {...group}
                  title={`Assigned to ${props.branch ?? "this branch"}`}
                  files={view.assigned}
                />
                <FileGroup
                  {...group}
                  title="Shared, not assigned to a branch"
                  description="These may belong to another agent or person using this checkout."
                  files={view.shared}
                />
                <FileGroup
                  {...group}
                  title="Unavailable"
                  description="Commit these from GitButler."
                  files={view.locked}
                />
              </div>
            </ScrollArea>
          </div>
          <div className="flex justify-between font-mono">
            <span className="font-sans text-muted-foreground">
              {view.selectedFileCount} {view.selectedFileCount === 1 ? "file" : "files"} selected
            </span>
            <span>
              <span className="text-diff-addition">+{formatDiffCount(view.insertions)}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-diff-deletion">-{formatDiffCount(view.deletions)}</span>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
