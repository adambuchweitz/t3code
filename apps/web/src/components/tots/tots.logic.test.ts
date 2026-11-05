import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveConnectedTot, resolveTotState, type ConnectedThreadInput } from "./tots.logic";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const project = ProjectId.make("project-lang");

const lineage = (parentThreadId: string | null) => ({
  parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
  relationshipToParent: parentThreadId === null ? null : ("subagent" as const),
  rootThreadId: ThreadId.make(parentThreadId ?? "self"),
});

const thread = (overrides: Partial<ConnectedThreadInput> = {}): ConnectedThreadInput => ({
  environmentId: envA,
  threadId: ThreadId.make("thread"),
  projectId: ProjectId.make("project-other"),
  lineage: lineage(null),
  ...overrides,
});

const brace = {
  environmentId: envA,
  threadId: ThreadId.make("tot-thread"),
  projectId: project,
};

describe("resolveTotState", () => {
  it.each([
    ["approval", "needs"],
    ["input", "needs"],
    ["request", "needs"],
    ["failed", "needs"],
    ["limited", "needs"],
    ["preparing", "working"],
    ["working", "working"],
    ["waiting", "working"],
    ["ready", "idle"],
    [null, "idle"],
  ] as const)("maps a %s thread to %s", (threadStatus, expected) => {
    expect(resolveTotState({ connected: true, threadStatus })).toBe(expected);
  });

  it("is offline whenever its machine is unreachable, even mid-run", () => {
    expect(resolveTotState({ connected: false, threadStatus: "working" })).toBe("offline");
  });
});

describe("resolveConnectedTot", () => {
  const readNothing = () => null;

  it("finds the thread's own Tot first", () => {
    expect(
      resolveConnectedTot({
        thread: thread({ threadId: brace.threadId, projectId: project }),
        tots: [brace],
        readThread: readNothing,
      }),
    ).toEqual({ tot: brace, connection: "self" });
  });

  it("walks up parents to the Tot that launched the thread", () => {
    expect(
      resolveConnectedTot({
        thread: thread({ lineage: lineage("middle") }),
        tots: [brace],
        readThread: (_environmentId, threadId) =>
          threadId === "middle" ? { lineage: lineage("tot-thread") } : null,
      }),
    ).toEqual({ tot: brace, connection: "launched" });
  });

  it("finds the root Tot when a finished subagent in between has no shell", () => {
    expect(
      resolveConnectedTot({
        thread: thread({
          lineage: {
            parentThreadId: ThreadId.make("finished-subagent"),
            relationshipToParent: "subagent",
            rootThreadId: brace.threadId,
          },
        }),
        tots: [brace],
        readThread: readNothing,
      }),
    ).toEqual({ tot: brace, connection: "launched" });
  });

  it("prefers a nearer Tot over the root when every parent has a shell", () => {
    const forkedTot = { ...brace, threadId: ThreadId.make("forked-tot") };
    const childOfFork = {
      parentThreadId: forkedTot.threadId,
      relationshipToParent: "subagent" as const,
      rootThreadId: brace.threadId,
    };
    expect(
      resolveConnectedTot({
        thread: thread({
          lineage: { ...childOfFork, parentThreadId: ThreadId.make("middle") },
        }),
        tots: [brace, forkedTot],
        readThread: () => ({ lineage: childOfFork }),
      }),
    ).toEqual({ tot: forkedTot, connection: "launched" });
  });

  it("follows delegated work across environments", () => {
    const remote = { ...brace, environmentId: envB };
    expect(
      resolveConnectedTot({
        thread: thread({
          delegatedFrom: { environmentId: envB, threadId: remote.threadId, title: "Lang" },
        }),
        tots: [remote],
        readThread: readNothing,
      }),
    ).toEqual({ tot: remote, connection: "launched" });
  });

  it("prefers the launching Tot over the project's Tot", () => {
    const other = { ...brace, threadId: ThreadId.make("other-tot") };
    expect(
      resolveConnectedTot({
        thread: thread({ projectId: project, lineage: lineage("tot-thread") }),
        tots: [other, brace],
        readThread: readNothing,
      }),
    ).toEqual({ tot: brace, connection: "launched" });
  });

  it("falls back to the project's Tot", () => {
    expect(
      resolveConnectedTot({
        thread: thread({ projectId: project }),
        tots: [brace],
        readThread: readNothing,
      }),
    ).toEqual({ tot: brace, connection: "project" });
  });

  it("doesn't match the same project id on another environment", () => {
    expect(
      resolveConnectedTot({
        thread: thread({ environmentId: envB, projectId: project }),
        tots: [brace],
        readThread: readNothing,
      }),
    ).toBeNull();
  });

  it("stops on a parent cycle", () => {
    expect(
      resolveConnectedTot({
        thread: thread({ lineage: lineage("loop") }),
        tots: [brace],
        readThread: () => ({ lineage: lineage("loop") }),
      }),
    ).toBeNull();
  });
});
