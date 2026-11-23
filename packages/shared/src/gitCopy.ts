import type { VcsWorkspaceStatus } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { gitButlerAppliedBranches, isGitButlerWorkspaceRef } from "./git.ts";

/**
 * GitButler's workspace ref says nothing about the work, so this names the linked branch, else the
 * only applied branch, else the workspace; with none known, just GitButler, as status may be loading.
 * @public
 */
export function resolveVcsRefDisplayName(
  refName: string | null,
  workspace?: VcsWorkspaceStatus | null,
  gitbutlerBranch?: string | null,
  resolve: MFunctionType = mFallback,
): string | null {
  if (gitbutlerBranch) {
    return workspace?._tag === "gitbutler" &&
      !gitButlerAppliedBranches(workspace).includes(gitbutlerBranch)
      ? resolve(msg("{branch} (not applied)", { branch: gitbutlerBranch }))
      : gitbutlerBranch;
  }
  if (refName === null || !isGitButlerWorkspaceRef(refName)) return refName;
  const branches = gitButlerAppliedBranches(workspace);
  if (branches.length === 0) return "GitButler";
  if (branches.length === 1) return branches[0] ?? "GitButler";
  return resolve(msg("GitButler workspace"));
}
