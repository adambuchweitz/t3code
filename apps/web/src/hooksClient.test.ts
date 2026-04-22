import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./environments/primary", () => ({
  resolvePrimaryEnvironmentHttpUrl: () => "http://127.0.0.1:3000/api/hooks/report",
}));

import { reportThreadFocusedHook } from "./hooksClient";

describe("hooksClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts thread.focused hook reports to the server", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));

    await reportThreadFocusedHook({
      environmentId: EnvironmentId.make("environment-local"),
      threadId: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Thread title",
      branch: "feature/hooks",
      worktreePath: "/tmp/worktree",
    });

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3000/api/hooks/report", {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "thread.focused",
        payload: {
          environmentId: "environment-local",
          threadId: "thread-1",
          projectId: "project-1",
          title: "Thread title",
          branch: "feature/hooks",
          worktreePath: "/tmp/worktree",
        },
      }),
    });
  });

  it("throws when the hook report request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("Bad hook request", { status: 400 }),
    );

    await expect(
      reportThreadFocusedHook({
        environmentId: EnvironmentId.make("environment-local"),
        threadId: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread title",
        branch: null,
        worktreePath: null,
      }),
    ).rejects.toThrow("Bad hook request");
  });
});
