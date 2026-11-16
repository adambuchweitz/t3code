import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadFocusReport, threadFocusReportKey } from "./useThreadFocusReporter";

const thread = {
  environmentId: EnvironmentId.make("environment-remote"),
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Hooks",
  branch: "feature/hooks",
  worktreePath: "/srv/project/.worktrees/hooks",
};

describe("threadFocusReport", () => {
  it("tells this client's own server about a remote thread, naming where it lives", () => {
    const report = threadFocusReport(thread, EnvironmentId.make("environment-local"));
    expect(report.environmentId).toBe("environment-local");
    expect(report.input).toEqual({
      environmentId: "environment-remote",
      threadId: "thread-1",
      projectId: "project-1",
      title: "Hooks",
      branch: "feature/hooks",
      worktreePath: "/srv/project/.worktrees/hooks",
    });
  });

  it("reports to the thread's environment when the client has no server of its own", () => {
    expect(threadFocusReport(thread, null).environmentId).toBe("environment-remote");
  });

  it("sends a thread without a branch or worktree as null rather than an invalid empty value", () => {
    const report = threadFocusReport({ ...thread, branch: " ", worktreePath: null }, null);
    expect(report.input.branch).toBeNull();
    expect(report.input.worktreePath).toBeNull();
  });

  it("treats a title change as the same focus but a new worktree as a new one", () => {
    const key = (overrides: Partial<typeof thread>) =>
      JSON.stringify(threadFocusReportKey(threadFocusReport({ ...thread, ...overrides }, null)));
    expect(key({ title: "Renamed" })).toBe(key({}));
    expect(key({ worktreePath: "/srv/project/.worktrees/other" })).not.toBe(key({}));
    expect(key({ branch: "feature/other" })).not.toBe(key({}));
  });
});
