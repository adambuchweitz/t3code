import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterSidebarProjects,
  sidebarProjectVisibility,
  updateHiddenSidebarProjectKeys,
} from "./projectVisibility.ts";

const local = { environmentId: EnvironmentId.make("local"), projectId: ProjectId.make("repo") };
const remote = { environmentId: EnvironmentId.make("remote"), projectId: ProjectId.make("repo") };
const projects = [local, remote].map(({ environmentId, projectId }) => ({
  environmentId,
  id: projectId,
}));

describe("sidebar project visibility", () => {
  it("hides only the selected environment and restores it without changing project records", () => {
    const hidden = updateHiddenSidebarProjectKeys([], [local], true);
    expect(filterSidebarProjects(projects, new Set(hidden))).toEqual([projects[1]]);
    expect(projects).toHaveLength(2);
    const restored = updateHiddenSidebarProjectKeys(hidden, [local], false);
    expect(filterSidebarProjects(projects, new Set(restored))).toBe(projects);
  });

  it("hides and restores every selected checkout while preserving other hidden projects", () => {
    const hidden = updateHiddenSidebarProjectKeys(["other:project"], [local, remote], true);
    expect(filterSidebarProjects(projects, new Set(hidden))).toEqual([]);
    expect(sidebarProjectVisibility(hidden, [local, remote])).toBe(false);
    expect(updateHiddenSidebarProjectKeys(hidden, [local, remote], true)).toEqual(hidden);
    expect(updateHiddenSidebarProjectKeys(hidden, [local, remote], false)).toEqual([
      "other:project",
    ]);
  });

  it("reports mixed visibility and can restore the whole selection", () => {
    const hidden = updateHiddenSidebarProjectKeys([], [local], true);
    expect(sidebarProjectVisibility(hidden, [local, remote])).toBeNull();
    expect(sidebarProjectVisibility(hidden, [remote])).toBe(true);
    const restored = updateHiddenSidebarProjectKeys(hidden, [local, remote], false);
    expect(sidebarProjectVisibility(restored, [local, remote])).toBe(true);
  });
});
