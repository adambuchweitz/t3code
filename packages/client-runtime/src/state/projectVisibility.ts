import type { ScopedProjectRef } from "@t3tools/contracts";

import { scopedProjectKey } from "../environment/scoped.ts";

export function filterSidebarProjects<T extends { environmentId: string; id: string }>(
  projects: ReadonlyArray<T>,
  hiddenKeys: ReadonlySet<string>,
): ReadonlyArray<T> {
  return hiddenKeys.size === 0
    ? projects
    : projects.filter((project) => !hiddenKeys.has(`${project.environmentId}:${project.id}`));
}

/** Visibility is device-local and keyed by environment, independently of grouping. */
export function updateHiddenSidebarProjectKeys(
  current: ReadonlyArray<string>,
  refs: ReadonlyArray<ScopedProjectRef>,
  hidden: boolean,
): string[] {
  const next = new Set(current);
  for (const ref of refs) {
    const key = scopedProjectKey(ref);
    if (hidden) next.add(key);
    else next.delete(key);
  }
  return [...next];
}

/** Null means the selected checkouts disagree; showing restores all of them. */
export function sidebarProjectVisibility(
  hiddenKeys: ReadonlyArray<string>,
  refs: ReadonlyArray<ScopedProjectRef>,
): boolean | null {
  const hidden = new Set(hiddenKeys);
  const count = refs.filter((ref) => hidden.has(scopedProjectKey(ref))).length;
  return count === 0 ? true : count === refs.length ? false : null;
}
