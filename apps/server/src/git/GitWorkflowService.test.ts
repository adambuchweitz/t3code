import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  GitCommandError,
  VcsProcessExitError,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import { ChildProcessSpawner } from "effect/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitButlerWorkspace from "../vcs/GitButlerWorkspace.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("GitWorkflowService", (it) => {
  it.effect(
    "routes manual and automatic workspace pulls through GitButler without requiring a git upstream",
    () => {
      const calls: Array<readonly string[]> = [];
      let invalidations = 0;
      const process = VcsProcess.VcsProcess.of({
        run: (request) =>
          Effect.sync(() => {
            calls.push(request.args);
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              stdout: JSON.stringify(
                request.args[0] === "status"
                  ? { uncommittedChanges: [], stacks: [] }
                  : request.args.includes("--check")
                    ? {
                        upToDate: false,
                        hasWorktreeConflicts: false,
                        branchStatuses: [{ status: "updatable" }],
                      }
                    : { status: "completed", conflicts: [], summary: { branchesConflicted: 0 } },
              ),
            };
          }),
      });
      const layerTest = GitWorkflowService.layer.pipe(
        Layer.provide(
          GitButlerWorkspace.layer.pipe(
            Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
          ),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            statusDetails: () =>
              Effect.succeed({
                isRepo: true,
                branch: "gitbutler/workspace",
                isDefaultBranch: false,
                hasOriginRemote: true,
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: false,
                upstreamRef: null,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
              }),
            pullCurrentBranch: () => Effect.die("git pull must never run in the workspace"),
          }),
        ),
        Layer.provide(
          Layer.mock(GitManager.GitManager)({
            invalidateStatus: () =>
              Effect.sync(() => {
                invalidations += 1;
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            resolve: () =>
              Effect.succeed({
                kind: "git",
                repository: { rootPath: "/repo" },
              } as VcsDriverRegistry.VcsDriverHandle),
          }),
        ),
      );
      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        assert.strictEqual((yield* workflow.pullCurrentBranch("/repo")).status, "pulled");
        assert.strictEqual((yield* workflow.autoPullCurrentBranch("/repo"))?.status, "pulled");
        assert.deepStrictEqual(
          calls.filter((args) => args[0] === "pull"),
          [
            ["pull", "--json"],
            ["pull", "--check", "--json"],
            ["pull", "--json"],
          ],
        );
        assert.strictEqual(invalidations, 2);
      }).pipe(Effect.provide(layerTest));
    },
  );
  it.effect("names the applied GitButler branches on a GitButler workspace checkout", () => {
    const localStatusFor = (refName: string): VcsStatusLocalResult => ({
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    });
    const butCalls: Array<string> = [];
    const butStdout = new Map<string, string>();
    const butProcess = VcsProcess.VcsProcess.of({
      run: (request) =>
        Effect.suspend(() => {
          if (request.command === "but" && request.args[0] !== "config") butCalls.push(request.cwd);
          const stdout =
            request.command === "git"
              ? request.args.at(-1) === "refs/t3/gitbutler-holds/"
                ? ""
                : "main\u0000origin/main\n"
              : request.args[0] === "config"
                ? JSON.stringify({ branch: "origin/main" })
                : butStdout.get(request.cwd);
          return stdout === undefined
            ? Effect.fail(
                new VcsProcessExitError({
                  operation: request.operation,
                  command: request.command,
                  cwd: request.cwd,
                  exitCode: 1,
                  detail: "Process exited with a non-zero status.",
                }),
              )
            : Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout,
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              });
        }),
    });
    butStdout.set(
      "/butler",
      JSON.stringify({
        uncommittedChanges: [{}],
        stacks: [
          { assignedChanges: [{}, {}], branches: [{ name: "feature/api" }] },
          { assignedChanges: [], branches: [{ name: "ui/base" }, { name: "ui/top" }] },
        ],
      }),
    );
    const refByCwd: Record<string, string> = {
      "/butler": "gitbutler/workspace",
      "/broken-butler": "gitbutler/workspace",
      "/plain": "main",
    };

    const layerTest = GitWorkflowService.layer.pipe(
      Layer.provide(
        GitButlerWorkspace.layer.pipe(
          Layer.provide(Layer.succeed(VcsProcess.VcsProcess, butProcess)),
        ),
      ),
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus: (input) => Effect.succeed(localStatusFor(refByCwd[input.cwd] ?? "main")),
          invalidateLocalStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refOnly = yield* workflow.localStatus({ cwd: "/butler" }, { includeWorkspace: false });
      assert.deepStrictEqual(refOnly, localStatusFor("gitbutler/workspace"));
      assert.deepStrictEqual(butCalls, []);
      const butler = yield* workflow.localStatus({ cwd: "/butler" });
      const broken = yield* workflow.localStatus({ cwd: "/broken-butler" });
      const plain = yield* workflow.localStatus({ cwd: "/plain" });

      assert.deepStrictEqual(butler.workspace, {
        _tag: "gitbutler",
        targetRefs: ["origin/main", "main"],
        stacks: [
          { branches: ["feature/api"], assignedChangeCount: 2 },
          { branches: ["ui/base", "ui/top"], assignedChangeCount: 0 },
        ],
        unassignedChangeCount: 1,
      });
      assert.deepStrictEqual(broken, localStatusFor("gitbutler/workspace"));
      assert.deepStrictEqual(plain, localStatusFor("main"));
      assert.deepStrictEqual(butCalls, ["/butler", "/broken-butler", "/broken-butler"]);

      // Repeated reads share one `but status`; each status invalidation forces a new one.
      yield* workflow.localStatus({ cwd: "/butler" });
      assert.deepStrictEqual(butCalls, ["/butler", "/broken-butler", "/broken-butler"]);
      yield* workflow.invalidateLocalStatus("/butler");
      yield* workflow.localStatus({ cwd: "/butler" });
      yield* workflow.invalidateStatus("/butler");
      yield* workflow.localStatus({ cwd: "/butler" });
      assert.deepStrictEqual(butCalls, [
        "/butler",
        "/broken-butler",
        "/broken-butler",
        "/butler",
        "/butler",
      ]);
    }).pipe(Effect.provide(layerTest));
  });
  it.effect("looks up a change request by the applied branch, never the workspace ref", () => {
    const lookups: Array<unknown> = [];
    let headSha: string | null = null;
    const pr = {
      number: 7,
      title: "API",
      url: "https://example.com/pr/7",
      baseRef: "main",
      headRef: "api",
      state: "open" as const,
    };
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const input = { cwd: "/butler", branch: "api" };
      // No head to compare, so a name match stays a candidate.
      assert.deepStrictEqual(yield* workflow.gitButlerBranchChangeRequest(input), {
        pr: { ...pr, updatedAt: null },
        association: "candidate",
      });
      assert.deepStrictEqual(lookups, [input]);

      // Positive proof confirms it; a head it cannot place, or cannot read, leaves it a candidate.
      for (const [sha, association] of [
        ["ours", "confirmed"],
        ["theirs", "candidate"],
        ["unreadable", "candidate"],
      ] as const) {
        headSha = sha;
        assert.strictEqual(
          (yield* workflow.gitButlerBranchChangeRequest(input)).association,
          association,
        );
      }
      lookups.length = 1;

      const error = yield* workflow
        .gitButlerBranchChangeRequest({ cwd: "/butler", branch: "removed" })
        .pipe(Effect.flip);
      assert.include(error.message, "no longer applied");
      assert.deepStrictEqual(lookups, [input]);
    }).pipe(
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(GitButlerWorkspace.GitButlerWorkspace)({
              readStatus: () =>
                Effect.succeed({
                  _tag: "gitbutler" as const,
                  stacks: [{ branches: ["api"], assignedChangeCount: 0 }],
                  unassignedChangeCount: 0,
                }),
              branchHasRevision: ({ cwd, sha }) =>
                sha === "unreadable"
                  ? Effect.fail(
                      new GitCommandError({
                        operation: "test",
                        command: "but status",
                        cwd,
                        detail: "unreadable",
                      }),
                    )
                  : Effect.succeed(sha === "ours"),
            }),
          ),
          Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
          Layer.provide(
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: (input) =>
                Effect.sync(() => {
                  lookups.push(input);
                  return {
                    ...pr,
                    updatedAt: null,
                    closedAt: null,
                    mergedAt: null,
                    headSha,
                    repositoryKey: "example/repo",
                  };
                }),
            }),
          ),
          Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  });
  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(GitButlerWorkspace.GitButlerWorkspace)({ invalidate: () => Effect.void }),
          ),
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

  it.effect("reads no HEAD path from a removed worktree without spawning Git", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-removed-wt-" });
      const removed = `${parent}/removed`;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.strictEqual(yield* workflow.headPath(removed), null);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(GitButlerWorkspace.GitButlerWorkspace)({ invalidate: () => Effect.void }),
          ),
          Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              execute: (input) => Effect.die(`spawned Git in ${input.cwd}`),
            }),
          ),
        ),
      ),
    ),
  );
});
