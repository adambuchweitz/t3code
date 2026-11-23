// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type GitButlerCommitChangesResult,
  type GitButlerForcePushConfirmationError,
  type GitButlerPublicationHoldError,
  type GitCommandError,
  VcsProcessExitError,
} from "@t3tools/contracts";

import pullConflict from "./fixtures/gitbutler-pull-conflict.json" with { type: "json" };
import pullCheck from "./fixtures/gitbutler-pull-check-update.json" with { type: "json" };
import commitOutput from "./fixtures/gitbutler-commit.json" with { type: "json" };
import applyOutput from "./fixtures/gitbutler-apply.json" with { type: "json" };
import applyRemoteOutput from "./fixtures/gitbutler-apply-remote.json" with { type: "json" };
import unapplyOutput from "./fixtures/gitbutler-unapply.json" with { type: "json" };
import newBranchOutput from "./fixtures/gitbutler-branch-new.json" with { type: "json" };

import * as GitButlerWorkspace from "./GitButlerWorkspace.ts";
import * as VcsProcess from "./VcsProcess.ts";

const exitError = (request: VcsProcess.VcsProcessInput) =>
  new VcsProcessExitError({
    operation: request.operation,
    command: request.command,
    cwd: request.cwd,
    exitCode: 1,
    detail: "Process exited with a non-zero status.",
  });

/** Runs `but` through `answer`, recording every argv it was started with. */
function butLayer(
  answer: (
    args: ReadonlyArray<string>,
    call: number,
  ) => Effect.Effect<string | VcsProcess.VcsProcessOutput, VcsProcessExitError>,
  head: string | (() => string) = "refs/heads/gitbutler/workspace",
  remote: {
    /** Defaults to a dry run with nothing to force, so pushes behave as ordinary pushes. */
    readonly dryRun?: (branch: string) => Effect.Effect<string, VcsProcessExitError>;
    readonly revParse?: (ref: string) => Effect.Effect<string, VcsProcessExitError>;
    readonly stagedDiff?: () => Effect.Effect<string, VcsProcessExitError>;
    /** What `diff-tree HEAD <ref>` lists, which is nothing unless a test says otherwise. */
    readonly changedElsewhere?: (ref: string) => string;
    /** What the commit changed, which is what was staged unless a test says otherwise. */
    readonly commitDiff?: () => Effect.Effect<string, VcsProcessExitError>;
  } = {},
) {
  const calls: Array<ReadonlyArray<string>> = [];
  // Stands in for a commit that holds exactly what was staged, unless a test says otherwise.
  let stagedPaths: readonly string[] = [];
  let staged = "";
  const process = VcsProcess.VcsProcess.of({
    run: (request) =>
      Effect.suspend(() => {
        const output = (stdout: string) => ({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
        if (request.command === "git" && request.args.includes("update-index")) {
          stagedPaths = String(request.stdin).split("\0");
          return Effect.succeed(output(""));
        }
        if (
          request.command === "git" &&
          request.args.includes("diff-index") &&
          request.args.includes("--cached")
        ) {
          return (
            remote.stagedDiff?.() ??
            Effect.succeed(
              stagedPaths.map((path) => `:100644 100644 base blob M\0${path}\0`).join(""),
            )
          ).pipe(
            Effect.tap((stdout) =>
              Effect.sync(() => {
                staged = stdout;
              }),
            ),
            Effect.mapError(() => exitError(request)),
            Effect.map(output),
          );
        }
        if (request.command === "git" && request.args.includes("diff-tree")) {
          return request.args.includes("--raw")
            ? (remote.commitDiff?.() ?? Effect.succeed(staged)).pipe(
                Effect.mapError(() => exitError(request)),
                Effect.map(output),
              )
            : Effect.succeed(output(remote.changedElsewhere?.(request.args.at(-2)!) ?? ""));
        }
        if (request.command === "git" && request.args[0] === "rev-parse" && remote.revParse) {
          return remote.revParse(request.args.at(-1)!).pipe(
            Effect.mapError(() => exitError(request)),
            Effect.map(output),
          );
        }
        if (request.args.includes("--dry-run")) {
          calls.push(request.args);
          return (
            remote.dryRun?.(request.args[1]!) ?? Effect.succeed(JSON.stringify({ branches: [] }))
          ).pipe(
            Effect.mapError(() => exitError(request)),
            Effect.map(output),
          );
        }
        const plumbingOutput =
          request.command === "git"
            ? request.args[0] === "symbolic-ref"
              ? typeof head === "function"
                ? head()
                : head
              : request.args[0] === "for-each-ref"
                ? request.args.at(-1)?.startsWith("refs/t3/")
                  ? ""
                  : "main\u0000origin/main\ntrunk\u0000origin/main\n"
                : request.args[0] === "remote"
                  ? "origin\nmy-org/upstream\n"
                  : `refs/${request.args.at(-1)?.startsWith("origin/") ? "remotes" : "heads"}/${request.args.at(-1)}`
            : request.args[0] === "config"
              ? request.args[1] === "push-remote"
                ? JSON.stringify({ push_remote: "fork", explicit: true })
                : JSON.stringify({ branch: "origin/main" })
              : null;
        if (plumbingOutput !== null)
          return Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: plumbingOutput,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        calls.push(request.args);
        return answer(request.args, calls.length).pipe(
          Effect.mapError(() => exitError(request)),
          Effect.map((stdout) =>
            typeof stdout === "string"
              ? {
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout,
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }
              : stdout,
          ),
        );
      }),
  });
  const layer = GitButlerWorkspace.layer.pipe(
    Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process)),
    Layer.provide(NodeServices.layer),
  );
  return { calls, layer };
}

// These race a commit against a writer exactly between T3's last check and the CLI's read. The
// real CLI, where installed, proves the premise both as a server and as an agent, since `but`
// shortens IDs outside agent environments. CI runs a stand-in that commits the same way.
const butInstalled = NodeChildProcess.spawnSync("but", ["--version"]).status === 0;
const write = (dir: string, file: string, content: string | Buffer) =>
  NodeFS.writeFileSync(NodePath.join(dir, file), content);
const binary = (marker: string) => Buffer.from(`\0${marker}\n`);

interface RaceFixture {
  readonly name: string;
  readonly path: string;
  readonly changeType: "added" | "modified" | "removed" | "renamed";
  readonly attributes?: string;
  readonly change: (dir: string) => void;
  /** Runs at the moment `but commit` is called, after every T3 check. */
  readonly race?: (dir: string) => void;
  readonly realCliOnly?: boolean;
  /** A text hunk, whose ID the CLI may notice changed, so refusing the commit is right too. */
  readonly hunk?: string;
  /** Paths the commit must delete beyond `path` itself, when the commit matches. */
  readonly expectDeleted?: string;
}

const LONG_TEXT = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";

const editTwinRenames = (dir: string) => {
  NodeFS.rmSync(NodePath.join(dir, "long.txt"));
  NodeFS.rmSync(NodePath.join(dir, "twin.txt"));
  write(dir, "long2.txt", `${LONG_TEXT}chosen\n`);
  write(dir, "twin2.txt", `${LONG_TEXT}chosen\n`);
};

const raceFixtures: ReadonlyArray<RaceFixture> = [
  {
    name: "the other edited rename of an identical pair",
    path: "twin2.txt",
    changeType: "renamed",
    realCliOnly: true,
    hunk: "@@ -1 +1,2 @@\n base\n+chosen\n",
    change: editTwinRenames,
    race: (dir) => write(dir, "twin.txt", LONG_TEXT),
  },
  {
    name: "edited rename whose identical twin was renamed too",
    path: "long2.txt",
    changeType: "renamed",
    realCliOnly: true,
    hunk: "@@ -1 +1,2 @@\n base\n+chosen\n",
    change: editTwinRenames,
    race: (dir) => write(dir, "long.txt", LONG_TEXT),
  },
  {
    name: "text edit",
    path: "old.txt",
    changeType: "modified",
    hunk: "@@ -1 +1 @@\n-base\n+chosen\n",
    change: (dir) => write(dir, "old.txt", "chosen\n"),
    race: (dir) => write(dir, "old.txt", "racer\n"),
  },
  {
    name: "text edit whose same lines moved to a repeat of the line",
    path: "repeat.txt",
    changeType: "modified",
    hunk: "@@ -1 +1 @@\n-same\n+chosen\n",
    change: (dir) => write(dir, "repeat.txt", "chosen\nmiddle\nsame\n"),
    race: (dir) => write(dir, "repeat.txt", "same\nmiddle\nchosen\n"),
  },
  {
    name: "text edit that lost its final newline",
    path: "old.txt",
    changeType: "modified",
    hunk: "@@ -1 +1 @@\n-base\n+chosen\n",
    change: (dir) => write(dir, "old.txt", "chosen\n"),
    race: (dir) => write(dir, "old.txt", "chosen"),
  },
  {
    name: "text edit whose mode flipped",
    path: "old.txt",
    changeType: "modified",
    hunk: "@@ -1 +1 @@\n-base\n+chosen\n",
    change: (dir) => write(dir, "old.txt", "chosen\n"),
    race: (dir) => NodeFS.chmodSync(NodePath.join(dir, "old.txt"), 0o755),
  },
  {
    name: "text rename with an edit whose source came back",
    path: "long2.txt",
    changeType: "renamed",
    hunk: "@@ -1 +1,2 @@\n base\n+chosen\n",
    change: (dir) => {
      NodeFS.rmSync(NodePath.join(dir, "long.txt"));
      write(dir, "long2.txt", `${LONG_TEXT}chosen\n`);
    },
    race: (dir) => write(dir, "long.txt", LONG_TEXT),
  },
  {
    name: "binary edit",
    path: "logo.bin",
    changeType: "modified",
    change: (dir) => write(dir, "logo.bin", binary("chosen")),
    race: (dir) => write(dir, "logo.bin", binary("racer")),
  },
  {
    name: "binary replaced by text",
    path: "logo.bin",
    changeType: "modified",
    change: (dir) => write(dir, "logo.bin", binary("chosen")),
    race: (dir) => write(dir, "logo.bin", "hello\n"),
  },
  {
    name: "binary mode flip",
    path: "logo.bin",
    changeType: "modified",
    change: (dir) => write(dir, "logo.bin", binary("chosen")),
    race: (dir) => NodeFS.chmodSync(NodePath.join(dir, "logo.bin"), 0o755),
  },
  {
    name: "binary deletion, then recreated",
    path: "logo.bin",
    changeType: "removed",
    change: (dir) => NodeFS.rmSync(NodePath.join(dir, "logo.bin")),
    race: (dir) => write(dir, "logo.bin", binary("racer")),
  },
  {
    name: "pure rename with new content",
    path: "new.bin",
    changeType: "renamed",
    expectDeleted: "old.bin",
    change: (dir) =>
      NodeFS.renameSync(NodePath.join(dir, "old.bin"), NodePath.join(dir, "new.bin")),
    race: (dir) => write(dir, "new.bin", binary("racer")),
  },
  {
    name: "pure rename whose source came back",
    path: "new.bin",
    changeType: "renamed",
    expectDeleted: "old.bin",
    change: (dir) =>
      NodeFS.renameSync(NodePath.join(dir, "old.bin"), NodePath.join(dir, "new.bin")),
    race: (dir) => write(dir, "old.bin", binary("old")),
  },
  {
    name: "clean-filtered binary edit",
    path: "tagged.dat",
    changeType: "modified",
    attributes: "*.dat filter=tag\n",
    change: (dir) => write(dir, "tagged.dat", binary("chosen")),
    race: (dir) => write(dir, "tagged.dat", binary("racer")),
  },
  {
    name: "pure rename of a symlink",
    path: "link2",
    changeType: "renamed",
    expectDeleted: "link",
    change: (dir) => NodeFS.renameSync(NodePath.join(dir, "link"), NodePath.join(dir, "link2")),
  },
  {
    name: "rename whose content matches another deleted file",
    path: "new.bin",
    changeType: "renamed",
    realCliOnly: true,
    expectDeleted: "old.bin",
    change: (dir) => {
      NodeFS.rmSync(NodePath.join(dir, "twin.bin"));
      NodeFS.renameSync(NodePath.join(dir, "old.bin"), NodePath.join(dir, "new.bin"));
    },
  },
];

const withRaceFixture = <A, E, R>(
  fixture: RaceFixture,
  realCli: false | "server" | "agent",
  use: (input: {
    readonly dir: string;
    readonly git: (...args: string[]) => string;
    readonly but: GitButlerWorkspace.GitButlerWorkspace["Service"];
    readonly commits: { count: number };
    readonly listReads: { count: number };
    readonly butIds: () => ReadonlyMap<string, string>;
    readonly runBut: (...args: string[]) => void;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-but-race-"))),
    (root) =>
      Effect.gen(function* () {
        const home = NodePath.join(root, "home");
        const dir = NodePath.join(root, "repo");
        const origin = NodePath.join(root, "origin.git");
        NodeFS.mkdirSync(home);
        NodeFS.mkdirSync(dir);
        // Nothing outside the fixture is read or written, including GitButler's user-level state.
        const env = {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: NodePath.join(home, "config"),
          XDG_DATA_HOME: NodePath.join(home, "data"),
          XDG_CACHE_HOME: NodePath.join(home, "cache"),
          XDG_STATE_HOME: NodePath.join(home, "state"),
          GIT_CONFIG_NOSYSTEM: "1",
          // Drops the test setup's core.filemode=false, which would hide mode changes from git.
          GIT_CONFIG_COUNT: "0",
          GIT_AUTHOR_NAME: "T3",
          GIT_AUTHOR_EMAIL: "t3@example.com",
          GIT_COMMITTER_NAME: "T3",
          GIT_COMMITTER_EMAIL: "t3@example.com",
        };
        // `env -i`, since the ambient agent variables this test may run under change `but`'s IDs.
        const butEnvironment = (mode: typeof realCli) => [
          "-i",
          ...[
            "PATH",
            "HOME",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "XDG_STATE_HOME",
          ].map((name) => `${name}=${env[name as keyof typeof env]}`),
          "GIT_CONFIG_NOSYSTEM=1",
          // A background sync would race the next command for GitButler's database.
          "NO_BG_TASKS=1",
          ...(mode === "agent" ? ["AI_AGENT=t3-test"] : []),
        ];
        const git = (...args: string[]) => {
          const result = NodeChildProcess.spawnSync("git", args, {
            cwd: dir,
            env,
            encoding: "utf8",
          });
          if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
          return result.stdout.trim();
        };
        git("init", "-q", "-b", "main");
        git("config", "user.name", "T3");
        git("config", "user.email", "t3@example.com");
        git("config", "filter.tag.clean", "sed s/^/CLEANED:/");
        git("config", "filter.tag.smudge", "cat");
        write(dir, ".gitattributes", fixture.attributes ?? "");
        write(dir, "logo.bin", binary("logo"));
        write(dir, "old.bin", binary("old"));
        write(dir, "old.txt", "base\n");
        write(dir, "repeat.txt", "same\nmiddle\nsame\n");
        write(dir, "long.txt", LONG_TEXT);
        write(
          dir,
          "wide.txt",
          `${Array.from({ length: 40 }, (_, line) => `line ${line}`).join("\n")}\n`,
        );
        write(dir, "twin.txt", LONG_TEXT);
        write(dir, "twin.bin", binary("old"));
        write(dir, "tagged.dat", binary("tagged"));
        NodeFS.symlinkSync("logo.bin", NodePath.join(dir, "link"));
        git("add", "-A");
        git("commit", "-qm", "base");
        NodeChildProcess.spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
        git("remote", "add", "origin", origin);
        git("push", "-q", "origin", "main");
        git("fetch", "-q", "origin");
        if (realCli) {
          const created = NodeChildProcess.spawnSync(
            "env",
            [...butEnvironment(realCli), "but", "branch", "new", "feature"],
            { cwd: dir },
          );
          if (created.status !== 0) throw new Error(created.stderr.toString());
        } else {
          git("branch", "feature");
        }
        fixture.change(dir);

        const commits = { count: 0 };
        const listReads = { count: 0 };
        const real = yield* VcsProcess.VcsProcess;
        const succeed = (stdout: string) => ({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
        const process_ = VcsProcess.VcsProcess.of({
          run: (request) =>
            Effect.suspend(() => {
              if (request.command === "but" && request.args[0] === "commit") {
                commits.count += 1;
                fixture.race?.(dir);
              }
              if (request.command === "but" && !realCli) {
                const change = {
                  filePath: fixture.path,
                  cliId: "file",
                  changeType: fixture.changeType,
                };
                if (request.args[0] === "status") {
                  return Effect.succeed(
                    succeed(
                      JSON.stringify({
                        uncommittedChanges: [change],
                        stacks: [{ branches: [{ name: "feature" }], assignedChanges: [] }],
                      }),
                    ),
                  );
                }
                if (request.args[0] === "diff") {
                  listReads.count += 1;
                  return Effect.succeed(
                    succeed(
                      JSON.stringify({
                        changes: [
                          {
                            id: fixture.hunk ? "file:1" : "file:e",
                            path: fixture.path,
                            status: "modified",
                            diff: {
                              type: "patch",
                              hunks: fixture.hunk ? [{ diff: fixture.hunk }] : [],
                            },
                          },
                        ],
                      }),
                    ),
                  );
                }
                git("add", "-A");
                git("commit", "-qm", "selected");
                return Effect.succeed(
                  succeed(JSON.stringify({ commitId: git("rev-parse", "HEAD") })),
                );
              }
              if (request.command === "but") {
                return real.run({
                  ...request,
                  command: "env",
                  args: [...butEnvironment(realCli), "but", ...request.args],
                });
              }
              return real.run({ ...request, env: { ...env, ...request.env } });
            }),
        });
        const context = yield* Layer.build(
          GitButlerWorkspace.layer.pipe(
            Layer.provide(Layer.succeed(VcsProcess.VcsProcess, process_)),
          ),
        );
        return yield* use({
          dir,
          git,
          but: Context.get(context, GitButlerWorkspace.GitButlerWorkspace),
          commits,
          listReads,
          runBut: (...args) => {
            const result = NodeChildProcess.spawnSync(
              "env",
              [...butEnvironment(realCli), "but", ...args],
              { cwd: dir },
            );
            if (result.status !== 0) throw new Error(result.stderr.toString());
          },
          butIds: () => {
            const { stdout } = NodeChildProcess.spawnSync(
              "env",
              [...butEnvironment(realCli), "but", "diff", "--json"],
              { cwd: dir, encoding: "utf8" },
            );
            const { changes } = JSON.parse(stdout) as {
              changes: ReadonlyArray<{ id: string; path: string }>;
            };
            return new Map(changes.map(({ path, id }) => [path, id]));
          },
        });
      }).pipe(Effect.scoped),
    (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  ).pipe(Effect.provide(Layer.provideMerge(VcsProcess.layer, NodeServices.layer)));

const committedRaw = (git: (...args: string[]) => string, sha: string) =>
  git("diff-tree", "-r", "--root", "--no-commit-id", "--no-renames", "--name-status", sha);

const runRaceFixture = (fixture: RaceFixture, realCli: false | "server" | "agent") =>
  Effect.gen(function* () {
    // Once with the writer and once without, so a real CLI that stopped matching git's view of a
    // file fails here rather than in someone's commit.
    for (const race of fixture.race ? [true, false] : [false]) {
      yield* withRaceFixture(
        race ? fixture : { ...fixture, race: () => {} },
        realCli,
        ({ dir, git, but, commits }) =>
          Effect.gen(function* () {
            const before = git("rev-parse", "HEAD");
            const { files } = yield* but.readCommitChanges({ cwd: dir, branch: "feature" });
            const file = files.find((entry) => entry.path === fixture.path);
            assert.isDefined(file, fixture.name);
            assert.notStrictEqual(file!.scope, "locked", fixture.name);
            const exit = yield* but
              .commit({
                cwd: dir,
                branch: "feature",
                message: "Selected",
                changeIds: file!.changeIds,
              })
              .pipe(Effect.exit);
            assert.strictEqual(commits.count, 1, fixture.name);
            if (Exit.isFailure(exit)) {
              assert.isTrue(race && fixture.hunk !== undefined, fixture.name);
              assert.strictEqual(git("rev-parse", "HEAD"), before, fixture.name);
              assert.strictEqual(git("for-each-ref", "refs/t3/gitbutler-holds/"), "", fixture.name);
              return;
            }
            const sha = exit.value!.commitSha;
            assert.strictEqual(git("cat-file", "-t", sha), "commit", fixture.name);
            if (race) {
              assert.include(exit.value!.selectionMismatch ?? "", fixture.path, fixture.name);
              assert.include(exit.value!.selectionMismatch ?? "", sha.slice(0, 12), fixture.name);
            } else {
              assert.isUndefined(exit.value!.selectionMismatch, fixture.name);
              if (fixture.expectDeleted) {
                assert.include(committedRaw(git, sha), `D\t${fixture.expectDeleted}`, fixture.name);
              }
            }
          }),
      );
    }
  });

const diffOutput = (marker: string) =>
  JSON.stringify({
    changes: [
      {
        id: "a:1",
        path: "a.ts",
        status: "modified",
        diff: { type: "patch", hunks: [{ diff: `@@ -1 +1 @@\n-old\n+${marker}\n` }] },
      },
      {
        id: "b:1",
        path: "b.ts",
        status: "modified",
        diff: { type: "patch", hunks: [{ diff: "@@ -0,0 +1 @@\n+b\n" }] },
      },
    ],
  });

const statusOutput = (branch: string) =>
  JSON.stringify({
    uncommittedChanges: [],
    stacks: [{ assignedChanges: [], branches: [{ name: branch }] }],
  });

describe("GitButlerWorkspace", () => {
  it.effect("serializes unapply so concurrent clients cannot remove the final stack", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let branches = ["first", "second"];
      const { calls, layer } = butLayer((args) => {
        if (args[0] === "status")
          return Effect.succeed(
            JSON.stringify({
              uncommittedChanges: [],
              stacks: branches.map((name) => ({ branches: [{ name }], assignedChanges: [] })),
            }),
          );
        if (args[0] === "unapply")
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.map(() => {
              branches = branches.filter((name) => name !== args.at(-1));
              return JSON.stringify({ branches: [args.at(-1)] });
            }),
          );
        return Effect.succeed("{}");
      });
      yield* Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        const first = yield* Effect.forkChild(but.unapply({ cwd: "/repo", branch: "first" }));
        yield* Deferred.await(started);
        const second = yield* Effect.forkChild(
          but.unapply({ cwd: "/repo", branch: "second" }).pipe(Effect.flip),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        assert.include((yield* Fiber.join(second)).message, "last applied stack");
        assert.deepStrictEqual(branches, ["second"]);
        assert.strictEqual(calls.filter((args) => args[0] === "unapply").length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );
  it.effect(
    "applies local and remote branches, creates applied branches, and keeps workspace mode after unapply",
    () => {
      let head = "refs/heads/gitbutler/workspace";
      const status = JSON.stringify({
        uncommittedChanges: [],
        stacks: [
          {
            branches: [{ name: "feature/stacked" }, { name: "feature/first" }],
            assignedChanges: [],
          },
          { branches: [{ name: "feature/second" }], assignedChanges: [] },
        ],
      });
      const { calls, layer } = butLayer(
        (args) => {
          if (args[0] === "unapply") head = "refs/heads/feature/second";
          return Effect.succeed(
            args[0] === "status"
              ? status
              : JSON.stringify(
                  args[0] === "apply"
                    ? args.at(-1) === "origin/remote-only"
                      ? applyRemoteOutput
                      : applyOutput
                    : args[0] === "unapply"
                      ? unapplyOutput
                      : args[0] === "branch"
                        ? newBranchOutput
                        : {},
                ),
          );
        },
        () => head,
      );
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        assert.deepStrictEqual(yield* but.apply({ cwd: "/repo", branch: "feature/first" }), {
          branch: "feature/first",
        });
        assert.deepStrictEqual(yield* but.apply({ cwd: "/repo", branch: "origin/remote-only" }), {
          branch: "remote-only",
        });
        assert.deepStrictEqual(
          yield* but.createBranch({ cwd: "/repo", branch: "feature/stacked" }),
          { branch: "feature/stacked" },
        );
        yield* but.unapply({ cwd: "/repo", branch: "feature/first" });
        assert.deepStrictEqual(
          calls.filter((args) => args[0] !== "status"),
          [
            ["apply", "--json", "--", "feature/first"],
            ["apply", "--json", "--", "origin/remote-only"],
            ["branch", "new", "--json", "--", "feature/stacked"],
            ["unapply", "--json", "--", "feature/first"],
            ["switch", "--workspace", "--json"],
          ],
        );
        assert.deepStrictEqual((yield* but.readStatus("/repo")).targetRefs, [
          "origin/main",
          "main",
          "trunk",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("retries a workspace change while GitButler's database is briefly locked", () => {
    const locked = {
      exitCode: ChildProcessSpawner.ExitCode(1),
      stdout: "",
      stderr: "Error: database is locked",
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    let branchAttempts = 0;
    const { layer } = butLayer((args) => {
      if (args[0] === "branch") {
        branchAttempts += 1;
        return Effect.succeed(branchAttempts < 3 ? locked : JSON.stringify(newBranchOutput));
      }
      return Effect.succeed(statusOutput("feature/first"));
    });
    return Effect.gen(function* () {
      const but = yield* GitButlerWorkspace.GitButlerWorkspace;
      const created = yield* but
        .createBranch({ cwd: "/repo", branch: "feature/stacked" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("2 seconds");
      assert.deepStrictEqual(yield* Fiber.join(created), { branch: "feature/stacked" });
      assert.strictEqual(branchAttempts, 3);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "blocks final-stack unapply, inactive branches, internal refs, targets, and non-workspace checkouts",
    () => {
      const { calls, layer } = butLayer(() => Effect.succeed(statusOutput("feature/first")));
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        for (const branch of ["feature/first", "missing"]) {
          const error = yield* but.unapply({ cwd: "/repo", branch }).pipe(Effect.flip);
          assert.strictEqual(error._tag, "GitCommandError");
          if (branch === "feature/first") assert.include(error.message, "last applied stack");
        }
        for (const method of [but.apply, but.unapply, but.createBranch]) {
          for (const branch of ["--force", "gitbutler/workspace", "main", "origin/main", "trunk"]) {
            assert.strictEqual(
              (yield* method({ cwd: "/repo", branch }).pipe(Effect.flip))._tag,
              "GitCommandError",
            );
          }
        }
        assert.isTrue(calls.every((args) => args[0] === "status"));
      }).pipe(
        Effect.provide(layer),
        Effect.andThen(
          Effect.gen(function* () {
            const { calls, layer } = butLayer(() => Effect.succeed("{}"), "refs/heads/main");
            yield* Effect.gen(function* () {
              const but = yield* GitButlerWorkspace.GitButlerWorkspace;
              for (const method of [but.apply, but.unapply, but.createBranch]) {
                assert.include(
                  (yield* method({ cwd: "/repo", branch: "feature/first" }).pipe(Effect.flip))
                    .message,
                  "GitButler workspace",
                );
              }
              assert.deepStrictEqual(calls, []);
            }).pipe(Effect.provide(layer));
          }),
        ),
      );
    },
  );

  it.effect(
    "preserves stderr and invalidates status and diffs after successful or failed workspace edits",
    () =>
      Effect.forEach(["apply", "unapply", "createBranch"] as const, (action) =>
        Effect.forEach([0, 1], (exitCode) => {
          let statusReads = 0;
          const { calls, layer } = butLayer((args) => {
            if (args[0] === "status") {
              statusReads++;
              return Effect.succeed(
                JSON.stringify({
                  uncommittedChanges: [],
                  stacks: [
                    { branches: [{ name: "feature/first" }], assignedChanges: [] },
                    { branches: [{ name: `other-${statusReads}` }], assignedChanges: [] },
                  ],
                }),
              );
            }
            if (args[0] === "diff") return Effect.succeed(diffOutput("new"));
            return Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(exitCode),
              stdout: JSON.stringify(action === "createBranch" ? newBranchOutput : applyOutput),
              stderr: "  could not update workspace  ",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          });
          return Effect.gen(function* () {
            const but = yield* GitButlerWorkspace.GitButlerWorkspace;
            yield* but.readStatus("/repo");
            yield* but.readBranchDiff({ cwd: "/repo", branch: "feature/first" });
            const edit = but[action]({ cwd: "/repo", branch: "feature/first" });
            if (exitCode === 1) {
              const error = yield* edit.pipe(Effect.flip);
              assert.strictEqual(error._tag, "GitCommandError");
              assert.include(error.message, "could not update workspace");
              assert.strictEqual(error.exitCode, 1);
            } else yield* edit;
            const status = yield* but.readStatus("/repo");
            assert.strictEqual(status.stacks[1]?.branches[0], `other-${statusReads}`);
            assert.isAtLeast(statusReads, 2);
            yield* but.readBranchDiff({ cwd: "/repo", branch: "feature/first" });
            assert.strictEqual(calls.filter((args) => args[0] === "diff").length, 2);
          }).pipe(Effect.provide(layer));
        }),
      ),
  );

  describe("commits that race a concurrent writer", () => {
    it.live.each(raceFixtures.filter((fixture) => !fixture.realCliOnly))(
      "reports a commit that took a late write: $name",
      (fixture) => runRaceFixture(fixture, false),
    );

    it.live("refuses a new file whose mode changed after the dialog read", () =>
      withRaceFixture(
        {
          name: "new file",
          path: "new.txt",
          changeType: "added",
          hunk: "@@ -0,0 +1 @@\n+new\n",
          change: (dir) => write(dir, "new.txt", "new\n"),
        },
        false,
        ({ dir, but }) =>
          Effect.gen(function* () {
            const { files } = yield* but.readCommitChanges({ cwd: dir, branch: "feature" });
            NodeFS.chmodSync(NodePath.join(dir, "new.txt"), 0o755);
            const error = yield* but
              .commit({
                cwd: dir,
                branch: "feature",
                message: "Selected",
                changeIds: files[0]!.changeIds,
              })
              .pipe(Effect.flip);
            assert.include(error.detail, "nothing was committed");
          }),
      ),
    );

    it.live("locks a rename whose source differs on the branch", () =>
      withRaceFixture(
        {
          name: "rename",
          path: "new.bin",
          changeType: "renamed",
          change: (dir) =>
            NodeFS.renameSync(NodePath.join(dir, "old.bin"), NodePath.join(dir, "new.bin")),
        },
        false,
        ({ dir, git, but }) =>
          Effect.gen(function* () {
            const emptyTree = git("hash-object", "-w", "-t", "tree", "/dev/null");
            git("branch", "-f", "feature", git("commit-tree", "-m", "emptied", emptyTree));
            const { files } = yield* but.readCommitChanges({ cwd: dir, branch: "feature" });
            assert.deepStrictEqual([files[0]!.scope, files[0]!.changedElsewhere], ["locked", true]);
          }),
      ),
    );

    it.live("reports a submodule bump nobody chose, whatever the repo ignores", () =>
      withRaceFixture(
        {
          name: "gitlink",
          path: "old.txt",
          changeType: "modified",
          hunk: "@@ -1 +1 @@\n-base\n+chosen\n",
          change: (dir) => write(dir, "old.txt", "chosen\n"),
        },
        false,
        ({ dir, git, but }) =>
          Effect.gen(function* () {
            const bump = (message: string) => {
              git("-C", "vendored", "commit", "-q", "--allow-empty", "-m", message);
              const sha = git("-C", "vendored", "rev-parse", "HEAD");
              git("update-index", "--add", "--cacheinfo", `160000,${sha},vendored`);
            };
            git("init", "-q", "vendored");
            bump("first");
            write(dir, ".gitmodules", '[submodule "vendored"]\n\tpath = vendored\n\turl = ./x\n');
            git("add", ".gitmodules");
            git("commit", "-qm", "vendor");
            git("config", "submodule.vendored.ignore", "all");
            const { files } = yield* but.readCommitChanges({ cwd: dir, branch: "feature" });
            const changeIds = files[0]!.changeIds;
            bump("second");
            const committed = yield* but.commit({
              cwd: dir,
              branch: "feature",
              message: "Selected",
              changeIds,
            });
            assert.include(committed?.selectionMismatch ?? "", "vendored");
          }),
      ),
    );

    it.live("reports a file nobody chose that landed in the commit", () =>
      withRaceFixture(
        {
          name: "extra file",
          path: "old.txt",
          changeType: "modified",
          hunk: "@@ -1 +1 @@\n-base\n+chosen\n",
          change: (dir) => write(dir, "old.txt", "chosen\n"),
          race: (dir) => write(dir, "extra.txt", "someone else's\n"),
        },
        false,
        ({ dir, but }) =>
          Effect.gen(function* () {
            const { files } = yield* but.readCommitChanges({ cwd: dir, branch: "feature" });
            const committed = yield* but.commit({
              cwd: dir,
              branch: "feature",
              message: "Selected",
              changeIds: files[0]!.changeIds,
            });
            assert.include(committed?.selectionMismatch ?? "", "extra.txt");
          }),
      ),
    );

    it.live("reads a contentless change without touching the real index or object store", () =>
      withRaceFixture(raceFixtures[0]!, false, ({ dir, git, but }) =>
        Effect.gen(function* () {
          // A plain `git status` would write the refreshed stat data of this clean file back.
          NodeFS.utimesSync(NodePath.join(dir, "wide.txt"), 0, 0);
          const index = () => NodeFS.readFileSync(NodePath.join(dir, ".git/index"));
          const before = [index(), git("count-objects", "-v")] as const;
          yield* but.readCommitChanges({ cwd: dir, branch: "feature" });
          assert.deepStrictEqual([index(), git("count-objects", "-v")], [...before]);
        }),
      ),
    );

    describe.skipIf(!butInstalled)("real but", () => {
      it.live.each(raceFixtures)("as a server: $name", (fixture) =>
        runRaceFixture(fixture, "server"),
      );
      it.live.each(raceFixtures)("as an agent: $name", (fixture) =>
        runRaceFixture(fixture, "agent"),
      );

      // Outside agent environments about one edit in six keeps its short ID, so nothing but T3's
      // own checks can catch it, either side of the moment the commit starts.
      it.live.each(["after the dialog read", "as the commit starts"] as const)(
        "catches an edit that keeps a hunk's short ID: %s",
        (moment) => {
          let racer = "";
          return withRaceFixture(
            {
              name: "edit",
              path: "old.txt",
              changeType: "modified",
              change: (dir) => write(dir, "old.txt", "chosen\n"),
              race: (dir) => {
                if (moment === "as the commit starts") write(dir, "old.txt", racer);
              },
            },
            "server",
            ({ dir, git, but, butIds }) =>
              Effect.gen(function* () {
                const chosenId = butIds().get("old.txt");
                for (let attempt = 0; attempt < 200 && racer === ""; attempt += 1) {
                  write(dir, "old.txt", `racer ${attempt}\n`);
                  if (butIds().get("old.txt") === chosenId) racer = `racer ${attempt}\n`;
                }
                assert.notStrictEqual(racer, "", "no edit kept the short ID, so the premise moved");
                write(dir, "old.txt", "chosen\n");
                const { files } = yield* but.readCommitChanges({ cwd: dir, branch: "feature" });
                const changeIds = files.find((file) => file.path === "old.txt")!.changeIds;
                if (moment === "after the dialog read") {
                  write(dir, "old.txt", racer);
                  const before = git("rev-parse", "HEAD");
                  const error = yield* but
                    .commit({ cwd: dir, branch: "feature", message: "Selected", changeIds })
                    .pipe(Effect.flip);
                  assert.include(error.detail, "nothing was committed");
                  assert.strictEqual(git("rev-parse", "HEAD"), before);
                  return;
                }
                const committed = yield* but.commit({
                  cwd: dir,
                  branch: "feature",
                  message: "Selected",
                  changeIds,
                });
                assert.include(committed!.selectionMismatch ?? "", "old.txt");
              }),
          );
        },
      );

      // The branch's blob can't match what's on disk, and nothing else proves what a commit holds.
      it.live.each([
        {
          name: "an edit",
          path: "wide.txt",
          first: (dir: string) =>
            write(
              dir,
              "wide.txt",
              Array.from(
                { length: 40 },
                (_, line) => `line ${line}${line === 4 ? " edited" : ""}\n`,
              ).join(""),
            ),
          second: (dir: string) =>
            write(
              dir,
              "wide.txt",
              Array.from(
                { length: 40 },
                (_, line) => `line ${line}${line === 4 || line === 34 ? " edited" : ""}\n`,
              ).join(""),
            ),
        },
        {
          name: "a chmod",
          path: "old.txt",
          first: (dir: string) => NodeFS.chmodSync(NodePath.join(dir, "old.txt"), 0o755),
          second: (dir: string) => write(dir, "old.txt", "chosen\n"),
        },
        {
          name: "a deletion, re-added as it was",
          path: "old.txt",
          first: (dir: string) => NodeFS.rmSync(NodePath.join(dir, "old.txt")),
          second: (dir: string) => write(dir, "old.txt", "base\n"),
        },
      ])("won't commit a file after another stack's $name", ({ path, first, second }) =>
        withRaceFixture(
          { name: "stacks", path, changeType: "modified", change: first },
          "server",
          ({ dir, git, but, runBut }) =>
            Effect.gen(function* () {
              runBut("branch", "new", "other");
              const read = (branch: string) =>
                but
                  .readCommitChanges({ cwd: dir, branch })
                  .pipe(Effect.map(({ files }) => files.find((file) => file.path === path)!));
              yield* but.commit({
                cwd: dir,
                branch: "other",
                message: "Other stack",
                changeIds: (yield* read("other")).changeIds,
              });
              second(dir);
              const file = yield* read("feature");
              assert.strictEqual(file.scope, "locked");
              assert.isTrue(file.changedElsewhere);
              const head = git("rev-parse", "feature");
              const error = yield* but
                .commit({
                  cwd: dir,
                  branch: "feature",
                  message: "Selected",
                  changeIds: file.changeIds,
                })
                .pipe(Effect.flip);
              assert.include(error.detail, "nothing was committed");
              assert.strictEqual(git("rev-parse", "feature"), head);
            }),
        ),
      );

      it.live("commits a further edit on the branch that made the first, not on a new one", () =>
        withRaceFixture(
          {
            name: "own edit",
            path: "old.txt",
            changeType: "modified",
            change: (dir) => write(dir, "old.txt", "first\n"),
          },
          "server",
          ({ dir, git, but, runBut }) =>
            Effect.gen(function* () {
              runBut("branch", "new", "other");
              const read = but
                .readCommitChanges({ cwd: dir, branch: "feature" })
                .pipe(
                  Effect.map(
                    ({ files }) => files.find((file) => file.path === "old.txt")!.changeIds,
                  ),
                );
              yield* but.commit({
                cwd: dir,
                branch: "feature",
                message: "First",
                changeIds: yield* read,
              });
              write(dir, "old.txt", "second\n");
              const changeIds = yield* read;
              const error = yield* but
                .commit({
                  cwd: dir,
                  branch: "fresh",
                  createBranch: true,
                  message: "Fresh",
                  changeIds,
                })
                .pipe(Effect.flip);
              assert.include(error.detail, "nothing was committed");
              const committed = yield* but.commit({
                cwd: dir,
                branch: "feature",
                message: "Second",
                changeIds,
              });
              assert.isUndefined(committed?.selectionMismatch);
              assert.strictEqual(git("show", "feature:old.txt"), "second");
            }),
        ),
      );

      it.live("refuses a text edit whose mode changed after the dialog read", () =>
        withRaceFixture(
          raceFixtures.find((fixture) => fixture.name === "text edit")!,
          "server",
          ({ dir, but }) =>
            Effect.gen(function* () {
              const { files } = yield* but.readCommitChanges({ cwd: dir, branch: "feature" });
              const changeIds = files.find((file) => file.path === "old.txt")!.changeIds;
              NodeFS.chmodSync(NodePath.join(dir, "old.txt"), 0o755);
              const error = yield* but
                .commit({ cwd: dir, branch: "feature", message: "Selected", changeIds })
                .pipe(Effect.flip);
              assert.include(error.detail, "nothing was committed");
            }),
        ),
      );

      it.live("refuses an edited rename that found another source after the dialog read", () =>
        withRaceFixture(
          {
            name: "swapped source",
            path: "long2.txt",
            changeType: "renamed",
            change: (dir) => {
              NodeFS.rmSync(NodePath.join(dir, "long.txt"));
              write(dir, "long2.txt", `${LONG_TEXT}chosen\n`);
            },
          },
          "server",
          ({ dir, git, but }) =>
            Effect.gen(function* () {
              const head = git("rev-parse", "HEAD");
              const { files } = yield* but.readCommitChanges({ cwd: dir, branch: "feature" });
              const changeIds = files.find((file) => file.path === "long2.txt")!.changeIds;
              write(dir, "long.txt", LONG_TEXT);
              write(
                dir,
                "wide.txt",
                `${Array.from({ length: 40 }, (_, line) => `line ${line}`).join("\n")}\n`,
              );
              NodeFS.rmSync(NodePath.join(dir, "twin.txt"));
              const error = yield* but
                .commit({ cwd: dir, branch: "feature", message: "Selected", changeIds })
                .pipe(Effect.flip);
              assert.include(error.detail, "nothing was committed");
              assert.strictEqual(git("rev-parse", "HEAD"), head);
            }),
        ),
      );

      // These are the late writes the CLI catches itself, because they do change its ID.
      it.live.each<RaceFixture>([
        {
          name: "text rename edited",
          path: "new.txt",
          changeType: "renamed",
          change: (dir) =>
            NodeFS.renameSync(NodePath.join(dir, "old.txt"), NodePath.join(dir, "new.txt")),
          race: (dir) => write(dir, "new.txt", "base\nracer\n"),
        },
        {
          name: "text rename whose source came back",
          path: "new.txt",
          changeType: "renamed",
          change: (dir) =>
            NodeFS.renameSync(NodePath.join(dir, "old.txt"), NodePath.join(dir, "new.txt")),
          race: (dir) => write(dir, "old.txt", "base\n"),
        },
        {
          name: "binary edit reverted",
          path: "logo.bin",
          changeType: "modified",
          change: (dir) => write(dir, "logo.bin", binary("chosen")),
          race: (dir) => write(dir, "logo.bin", binary("logo")),
        },
      ])("commits nothing when: $name", (fixture) =>
        withRaceFixture(fixture, "agent", ({ dir, git, but }) =>
          Effect.gen(function* () {
            const head = git("rev-parse", "feature");
            const { files } = yield* but.readCommitChanges({ cwd: dir, branch: "feature" });
            const changeIds = files.find((file) => file.path === fixture.path)!.changeIds;
            const error = yield* but
              .commit({ cwd: dir, branch: "feature", message: "Selected", changeIds })
              .pipe(Effect.flip);
            assert.include(error.detail, "nothing was committed");
            assert.strictEqual(git("rev-parse", "feature"), head);
          }),
        ),
      );

      it.live("two renames of identical files can't be chosen", () =>
        withRaceFixture(
          {
            name: "identical renames",
            path: "new.bin",
            changeType: "renamed",
            change: (dir) => {
              NodeFS.renameSync(NodePath.join(dir, "old.bin"), NodePath.join(dir, "new.bin"));
              NodeFS.renameSync(NodePath.join(dir, "twin.bin"), NodePath.join(dir, "new2.bin"));
            },
          },
          "server",
          ({ dir, but }) =>
            Effect.gen(function* () {
              const { files } = yield* but.readCommitChanges({ cwd: dir, branch: "feature" });
              const renames = files.filter((file) => file.path.startsWith("new"));
              assert.lengthOf(renames, 2);
              assert.isTrue(renames.every((file) => file.scope === "locked"));
            }),
        ),
      );
    });
  });

  describe("commit dialog polling", () => {
    const newFile: RaceFixture = {
      name: "new file",
      path: "new.txt",
      changeType: "added",
      hunk: "@@ -0,0 +1 @@\n+new\n",
      change: (dir: string) => write(dir, "new.txt", "new\n"),
    };
    const ids = (result: GitButlerCommitChangesResult) => result.files.flatMap((f) => f.changeIds);

    it.effect("reads the list again only once a dirty file's bytes or the commit moved", () =>
      withRaceFixture(newFile, false, ({ dir, git, but, listReads }) =>
        Effect.gen(function* () {
          const poll = but.readCommitChanges({ cwd: dir, branch: "feature" });
          const first = ids(yield* poll);
          yield* TestClock.adjust("3 seconds");
          assert.deepStrictEqual(ids(yield* poll), first);
          assert.strictEqual(listReads.count, 1);

          // Same size and mtime, so stat data alone would call this unchanged.
          const file = NodePath.join(dir, "new.txt");
          const { atime, mtime } = NodeFS.statSync(file);
          write(dir, "new.txt", "old\n");
          NodeFS.utimesSync(file, atime, mtime);
          yield* TestClock.adjust("3 seconds");
          yield* poll;
          assert.strictEqual(listReads.count, 2);

          git("add", "-A");
          git("commit", "-qm", "moved");
          yield* TestClock.adjust("3 seconds");
          yield* poll;
          assert.strictEqual(listReads.count, 3);
        }),
      ),
    );

    it.effect.each(['"quoted"', "new\nline"])("hashes the dirty file named %j", (path) =>
      withRaceFixture(
        {
          ...newFile,
          path,
          change: (dir) => {
            write(dir, path, "new\n");
            // What the name would mean if git read it unquoted.
            write(dir, "quoted", "other\n");
          },
        },
        false,
        ({ dir, but, listReads }) =>
          Effect.gen(function* () {
            const poll = but.readCommitChanges({ cwd: dir, branch: "feature" });
            yield* poll;
            yield* TestClock.adjust("3 seconds");
            yield* poll;
            assert.strictEqual(listReads.count, 1);
            write(dir, path, "old\n");
            yield* TestClock.adjust("3 seconds");
            yield* poll;
            assert.strictEqual(listReads.count, 2);
          }),
      ),
    );

    it.effect("reads an unchanged list again once it reaches its maximum age", () =>
      withRaceFixture(newFile, false, ({ dir, but, listReads }) =>
        Effect.gen(function* () {
          const poll = but.readCommitChanges({ cwd: dir, branch: "feature" });
          yield* poll;
          yield* TestClock.adjust("29 seconds");
          yield* poll;
          assert.strictEqual(listReads.count, 1);
          yield* TestClock.adjust("2 seconds");
          yield* poll;
          assert.strictEqual(listReads.count, 2);
        }),
      ),
    );

    it.effect("reads the list on every poll when a dirty path can't be hashed", () =>
      withRaceFixture(
        {
          ...newFile,
          change: (dir) => NodeFS.symlinkSync("missing", NodePath.join(dir, "new.txt")),
        },
        false,
        ({ dir, but, listReads }) =>
          Effect.gen(function* () {
            const poll = but.readCommitChanges({ cwd: dir, branch: "feature" });
            yield* poll;
            yield* TestClock.adjust("3 seconds");
            yield* poll;
            assert.strictEqual(listReads.count, 2);
          }),
      ),
    );

    it.effect("still refuses a choice from a reused list, then shows what changed", () =>
      withRaceFixture(newFile, false, ({ dir, but, listReads, commits }) =>
        Effect.gen(function* () {
          const poll = but.readCommitChanges({ cwd: dir, branch: "feature" });
          const chosen = ids(yield* poll);
          // Git's status has no mode for an untracked file, so the signature can't see this.
          NodeFS.chmodSync(NodePath.join(dir, "new.txt"), 0o755);
          yield* TestClock.adjust("3 seconds");
          assert.deepStrictEqual(ids(yield* poll), chosen);
          const error = yield* but
            .commit({ cwd: dir, branch: "feature", message: "Selected", changeIds: chosen })
            .pipe(Effect.flip);
          assert.include(error.detail, "nothing was committed");
          assert.strictEqual(commits.count, 0);
          const reads = listReads.count;
          assert.notDeepEqual(ids(yield* poll), chosen);
          assert.strictEqual(listReads.count, reads + 1);
        }),
      ),
    );

    it.effect(
      "shares one read between clients and keeps a read an edit overtook from lingering",
      () =>
        Effect.gen(function* () {
          const diffStarted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const { calls, layer } = butLayer((args) =>
            args[0] === "status"
              ? Effect.succeed(statusOutput("api"))
              : Deferred.succeed(diffStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(diffOutput("new")),
                ),
          );
          const diffReads = () => calls.filter((args) => args[0] === "diff").length;
          yield* Effect.gen(function* () {
            const but = yield* GitButlerWorkspace.GitButlerWorkspace;
            const poll = but.readCommitChanges({ cwd: "/repo", branch: "api" });
            const clients = yield* Effect.all([poll, poll], { concurrency: "unbounded" }).pipe(
              Effect.forkChild,
            );
            yield* Deferred.await(diffStarted);
            yield* but.invalidate("/repo");
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(clients);
            assert.strictEqual(diffReads(), 1);
            yield* poll;
            assert.strictEqual(diffReads(), 2);
          }).pipe(Effect.provide(layer));
        }),
    );
  });

  describe("commit selection", () => {
    const change = (filePath: string) => ({ filePath, cliId: filePath });
    const hunks = (path: string, ...ids: string[]) =>
      ids.map((id) => ({
        id,
        path,
        status: "modified",
        diff: { type: "patch", hunks: [{ diff: "@@ -1 +1 @@\n-old\n+new\n" }] },
      }));
    const workspace = JSON.stringify({
      uncommittedChanges: [
        change("free.ts"),
        change("mixed.ts"),
        change("foreign.ts"),
        change("conflict.ts"),
      ],
      conflictedFiles: ["conflict.ts"],
      mergeBase: { commitId: "base-commit" },
      stacks: [
        {
          branches: [{ name: "feature/top" }, { name: "feature/base" }],
          assignedChanges: [change("own.ts"), change("mixed.ts")],
        },
        { branches: [{ name: "other" }], assignedChanges: [change("foreign.ts")] },
      ],
    });
    const worktree = JSON.stringify({
      changes: [
        ...hunks("free.ts", "free:1", "free:2"),
        ...hunks("mixed.ts", "mixed:1"),
        ...hunks("own.ts", "own:1"),
        ...hunks("foreign.ts", "foreign:1"),
        ...hunks("conflict.ts", "conflict:1"),
        // No ID, so it can only be shown, and nothing in status explains it.
        { path: "unknown.ts", status: "modified", diff: { type: "binaryFile" } },
      ],
    });
    const butWorkspace = (
      commitAnswer: () => Effect.Effect<string | VcsProcess.VcsProcessOutput> = () =>
        Effect.succeed(JSON.stringify(commitOutput)),
      changedElsewhere?: (ref: string) => string,
      commitDiff?: () => Effect.Effect<string>,
    ) =>
      butLayer(
        (args) =>
          args[0] === "status"
            ? Effect.succeed(workspace)
            : args[0] === "diff"
              ? Effect.succeed(worktree)
              : commitAnswer(),
        undefined,
        {
          ...(changedElsewhere === undefined ? {} : { changedElsewhere }),
          ...(commitDiff === undefined ? {} : { commitDiff }),
        },
      );

    it.effect("separates this branch's changes from shared and locked ones", () =>
      Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        const scopes = (result: GitButlerCommitChangesResult) =>
          Object.fromEntries(
            result.files.map((file) => [
              file.path,
              [file.scope, file.assignedBranch ?? null, file.changeIds.length],
            ]),
          );
        const targeted = yield* but.readCommitChanges({ cwd: "/repo", branch: "feature/base" });
        assert.deepStrictEqual(scopes(targeted), {
          "conflict.ts": ["locked", null, 1],
          "foreign.ts": ["locked", "other", 1],
          "free.ts": ["shared", null, 2],
          "mixed.ts": ["mixed", null, 1],
          "own.ts": ["target", null, 1],
          "unknown.ts": ["locked", null, 0],
        });
        const free = targeted.files.find((file) => file.path === "free.ts");
        assert.deepStrictEqual([free?.insertions, free?.deletions], [2, 2]);
        const untargeted = scopes(yield* but.readCommitChanges({ cwd: "/repo" }));
        assert.deepStrictEqual(untargeted["own.ts"], ["locked", "feature/top", 1]);
        assert.deepStrictEqual(untargeted["free.ts"], ["shared", null, 2]);
      }).pipe(Effect.provide(butWorkspace().layer)),
    );

    const offered = (...ids: readonly string[]) =>
      Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        const { files } = yield* but.readCommitChanges({ cwd: "/repo", branch: "feature/top" });
        const all = files.flatMap((file) => file.changeIds);
        return ids.map((id) => all.find((changeId) => changeId.startsWith(`${id}@`)) ?? id);
      });

    it.effect("commits whole files by the hunk IDs that name them", () => {
      const { calls, layer } = butWorkspace(undefined, undefined, () =>
        Effect.succeed(
          ["free.ts", "own.ts"].map((path) => `:100644 100644 base blob M\0${path}\0`).join(""),
        ),
      );
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        const changeIds = yield* offered("free:1", "free:2", "own:1");
        assert.deepStrictEqual(
          yield* but.prepareCommit({
            cwd: "/repo",
            branch: "feature/top",
            changeIds: [...changeIds, changeIds[0]!],
          }),
          {
            changeIds,
            cliIds: ["free:1", "free:2", "own:1"],
            filePaths: ["free.ts", "own.ts"],
            expected: [
              { path: "free.ts", mode: "100644", blob: "blob", renamedFrom: null },
              { path: "own.ts", mode: "100644", blob: "blob", renamedFrom: null },
            ],
          },
        );
        assert.deepStrictEqual(
          yield* but.commit({
            cwd: "/repo",
            branch: "feature/base",
            message: "Selected",
            changeIds,
          }),
          { commitSha: commitOutput.commitId },
        );
        assert.deepStrictEqual(
          calls.filter((args) => args[0] === "commit"),
          [
            [
              "commit",
              "-b",
              "feature/base",
              "-m",
              "Selected",
              "--json",
              "--",
              "free:1",
              "free:2",
              "own:1",
            ],
          ],
        );
      }).pipe(Effect.provide(layer));
    });

    it.effect("refuses stale, locked, and wrong-branch selections without committing", () => {
      const { calls, layer } = butWorkspace();
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        const refused = (input: {
          branch: string;
          changeIds: readonly string[];
          createBranch?: boolean;
        }) => but.commit({ cwd: "/repo", message: "Refused", ...input }).pipe(Effect.flip);
        // A bare CLI ID says nothing about content, so it counts as stale too.
        for (const stale of ["free:old", "free:2"]) {
          const changeIds = [...(yield* offered("free:1")), stale];
          const edited = yield* refused({ branch: "feature/top", changeIds });
          assert.include(edited.detail, "edited or committed");
        }
        assert.include(
          (yield* refused({ branch: "feature/top", changeIds: yield* offered("foreign:1") }))
            .detail,
          "assigned to other",
        );
        assert.include(
          (yield* refused({ branch: "feature/top", changeIds: yield* offered("conflict:1") }))
            .detail,
          "cannot be committed",
        );
        // A new branch has no stack, so this stack's changes would be taken from it.
        for (const changeIds of [yield* offered("own:1"), yield* offered("mixed:1")]) {
          assert.strictEqual(
            (yield* refused({ branch: "fresh", createBranch: true, changeIds }))._tag,
            "GitCommandError",
          );
        }
        assert.strictEqual(
          (yield* refused({ branch: "unapplied", changeIds: yield* offered("free:1") }))._tag,
          "GitCommandError",
        );
        assert.isFalse(calls.some((args) => args[0] === "commit"));
      }).pipe(Effect.provide(layer));
    });

    it.effect("refuses part of a file, which no check of the commit could prove", () => {
      const { calls, layer } = butWorkspace();
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        const error = yield* but
          .commit({
            cwd: "/repo",
            branch: "feature/top",
            message: "Selected",
            changeIds: yield* offered("free:1"),
          })
          .pipe(Effect.flip);
        assert.include(error.detail, "Only part of free.ts");
        assert.isFalse(calls.some((args) => args[0] === "commit"));
      }).pipe(Effect.provide(layer));
    });

    it.effect("locks and refuses a file that differs where the commit would start", () => {
      const { calls, layer } = butWorkspace(undefined, (ref) =>
        ref === "refs/heads/feature/top" ? "own.ts\0" : ref === "base-commit" ? "free.ts\0" : "",
      );
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        const fileOn = (branch?: string, path = "own.ts") =>
          but
            .readCommitChanges({ cwd: "/repo", branch })
            .pipe(Effect.map(({ files }) => files.find((file) => file.path === path)!));
        const own = yield* fileOn("feature/top");
        assert.deepStrictEqual([own.scope, own.changedElsewhere], ["locked", true]);
        const free = yield* fileOn("feature/top", "free.ts");
        assert.deepStrictEqual([free.scope, free.changedElsewhere], ["shared", undefined]);
        assert.strictEqual((yield* fileOn(undefined, "free.ts")).scope, "locked");

        const refused = (branch: string, createBranch: boolean, changeIds: readonly string[]) =>
          but
            .commit({ cwd: "/repo", branch, createBranch, message: "Refused", changeIds })
            .pipe(Effect.flip);
        assert.include((yield* refused("feature/top", false, own.changeIds)).detail, "differs");
        assert.include((yield* refused("fresh", true, free.changeIds)).detail, "new branch");
        assert.isFalse(calls.some((args) => args[0] === "commit"));
      }).pipe(Effect.provide(layer));
    });

    it.effect("reports a commit it can't read back as unconfirmed", () => {
      const { calls, layer } = butLayer(
        (args) =>
          Effect.succeed(
            args[0] === "status"
              ? workspace
              : args[0] === "diff"
                ? worktree
                : JSON.stringify(commitOutput),
          ),
        undefined,
        {
          commitDiff: () =>
            Effect.fail(
              new VcsProcessExitError({
                operation: "test",
                command: "git",
                cwd: "/repo",
                exitCode: 1,
                detail: "unreadable",
              }),
            ),
        },
      );
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        const committed = yield* but.commit({
          cwd: "/repo",
          branch: "feature/top",
          message: "Selected",
          changeIds: yield* offered("own:1"),
        });
        assert.strictEqual(committed?.commitSha, commitOutput.commitId);
        assert.include(committed?.selectionMismatch ?? "", "could not confirm");
        assert.include(committed?.selectionMismatch ?? "", commitOutput.commitId.slice(0, 12));
        assert.isTrue(calls.some((args) => args[0] === "commit"));
      }).pipe(Effect.provide(layer));
    });

    it.effect("locks everything for a new branch when `but` doesn't say where it starts", () => {
      const { layer } = butLayer((args) =>
        Effect.succeed(
          args[0] === "status"
            ? JSON.stringify({ uncommittedChanges: [change("free.ts")], stacks: [] })
            : JSON.stringify({ changes: hunks("free.ts", "free:1") }),
        ),
      );
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        const { files } = yield* but.readCommitChanges({ cwd: "/repo" });
        assert.deepStrictEqual(
          files.map((file) => file.scope),
          ["locked"],
        );
      }).pipe(Effect.provide(layer));
    });

    it.effect("refuses a binary edit even though `but` keeps its ID", () => {
      let blob = "blob-one";
      const { calls, layer } = butLayer(
        (args) =>
          Effect.succeed(
            args[0] === "status"
              ? JSON.stringify({
                  uncommittedChanges: [{ ...change("logo.png"), changeType: "modified" }],
                  stacks: [{ branches: [{ name: "api" }], assignedChanges: [] }],
                })
              : args[0] === "diff"
                ? JSON.stringify({
                    changes: [
                      {
                        id: "logo:empt",
                        path: "logo.png",
                        status: "modified",
                        diff: { type: "patch", hunks: [] },
                      },
                    ],
                  })
                : JSON.stringify(commitOutput),
          ),
        undefined,
        { stagedDiff: () => Effect.succeed(`:100644 100644 base ${blob} M\0logo.png\0`) },
      );
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        const { files } = yield* but.readCommitChanges({ cwd: "/repo", branch: "api" });
        const changeIds = files[0]!.changeIds;
        assert.match(changeIds[0]!, /^logo:empt@[0-9a-f]{32}$/);
        blob = "blob-two";
        const input = { cwd: "/repo", branch: "api", message: "Logo", changeIds };
        assert.include((yield* but.commit(input).pipe(Effect.flip)).detail, "edited or committed");
        assert.isFalse(calls.some((args) => args[0] === "commit"));
        blob = "blob-one";
        yield* but.commit(input);
        assert.strictEqual(calls.find((args) => args[0] === "commit")?.at(-1), "logo:empt");
      }).pipe(Effect.provide(layer));
    });

    it.effect("reports an edit that lands after the check as stale", () => {
      const rejected = {
        exitCode: ChildProcessSpawner.ExitCode(1),
        stdout: "",
        stderr: "Error: Could not find uncommitted change: 'free:1'",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        const error = yield* but
          .commit({
            cwd: "/repo",
            branch: "feature/top",
            message: "Late",
            changeIds: yield* offered("free:1", "free:2"),
          })
          .pipe(Effect.flip);
        assert.include(error.detail, "nothing was committed");
      }).pipe(Effect.provide(butWorkspace(() => Effect.succeed(rejected)).layer));
    });
  });

  it.effect(
    "publishes the selected branch with GitButler and returns its stacked PR rather than an ancestor's",
    () => {
      const review = (sourceBranch: string, targetBranch: string, number: number) => ({
        sourceBranch,
        targetBranch,
        number,
        htmlUrl: `https://github.com/acme/repo/pull/${number}`,
        title: sourceBranch,
      });
      const { calls, layer } = butLayer((args) =>
        Effect.succeed(
          args[0] === "status"
            ? statusOutput("feature/api")
            : JSON.stringify({
                published: [review("base", "main", 1), review("feature/api", "base", 2)],
                alreadyExisting: [],
              }),
        ),
      );
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        yield* but.push({ cwd: "/repo", branch: "feature/api" });
        const pr = yield* but.createPullRequest({ cwd: "/repo", branch: "feature/api" });
        assert.strictEqual(pr.baseBranch, "base");
        assert.strictEqual(pr.number, 2);
        assert.strictEqual(pr.status, "created");
        yield* but.createPullRequest({ cwd: "/repo", branch: "feature/api", draft: true });
        assert.deepStrictEqual(
          calls.filter((args) => args[0] !== "status"),
          [
            ["push", "feature/api", "--dry-run", "--json"],
            ["push", "feature/api", "--json"],
            ["push", "feature/api", "--dry-run", "--json"],
            ["pr", "new", "feature/api", "--default", "--json"],
            ["push", "feature/api", "--dry-run", "--json"],
            ["pr", "new", "feature/api", "--default", "--json", "--draft"],
          ],
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "checks every applied branch before auto-pull and skips dirty, conflicting, current, or unknown states",
    () => {
      const cases = [
        "clean",
        "dirty",
        "assigned",
        "conflicted-file",
        "dirty-worktree",
        "became-dirty",
        "conflicts",
        "worktree-conflicts",
        "unknown",
        "current",
      ];
      return Effect.forEach(cases, (scenario) => {
        let statusReads = 0;
        const { calls, layer } = butLayer((args) => {
          if (args[0] === "status") statusReads += 1;
          return Effect.succeed(
            JSON.stringify(
              args[0] === "status"
                ? {
                    uncommittedChanges:
                      scenario === "dirty" || (scenario === "became-dirty" && statusReads > 1)
                        ? [{}]
                        : [],
                    conflictedFiles: scenario === "conflicted-file" ? ["a.ts"] : [],
                    worktrees: [{ uncommittedChanges: scenario === "dirty-worktree" ? [{}] : [] }],
                    stacks: [
                      {
                        branches: [{ name: "api" }],
                        assignedChanges: scenario === "assigned" ? [{}] : [],
                      },
                    ],
                  }
                : args.includes("--check")
                  ? {
                      ...pullCheck,
                      upToDate: scenario === "current",
                      hasWorktreeConflicts: scenario === "worktree-conflicts",
                      branchStatuses: [
                        {
                          name: "api",
                          status:
                            scenario === "conflicts"
                              ? "conflicted"
                              : scenario === "unknown"
                                ? "future-status"
                                : "updatable",
                          rebasable: true,
                        },
                      ],
                    }
                  : { status: "completed", conflicts: [], summary: { branchesConflicted: 0 } },
            ),
          );
        });
        return Effect.gen(function* () {
          const but = yield* GitButlerWorkspace.GitButlerWorkspace;
          const result = yield* but.autoPull("/repo");
          assert.strictEqual(result?.status ?? null, scenario === "clean" ? "pulled" : null);
          const pulls = calls.filter((args) => args[0] === "pull");
          assert.deepStrictEqual(
            pulls,
            scenario === "clean"
              ? [
                  ["pull", "--check", "--json"],
                  ["pull", "--json"],
                ]
              : ["dirty", "assigned", "conflicted-file", "dirty-worktree"].includes(scenario)
                ? []
                : [["pull", "--check", "--json"]],
          );
        }).pipe(Effect.provide(layer));
      });
    },
  );

  it.effect(
    "preserves CLI stderr and explains interactive forge authentication without retrying a mutation",
    () => {
      const { calls, layer } = butLayer((args) =>
        args[0] === "status"
          ? Effect.succeed(statusOutput("api"))
          : Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(1),
              stdout: "",
              stderr: "Error: No authenticated forge user",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
      );
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        for (const action of [
          but.push({ cwd: "/repo", branch: "api" }).pipe(Effect.asVoid),
          but.createPullRequest({ cwd: "/repo", branch: "api" }).pipe(Effect.asVoid),
          but.pull("/repo").pipe(Effect.asVoid),
        ]) {
          const error = yield* action.pipe(Effect.flip);
          assert.strictEqual(error._tag, "GitCommandError");
          assert.include(error.message, "No authenticated forge user");
        }
        const authError = yield* but
          .createPullRequest({ cwd: "/repo", branch: "api" })
          .pipe(Effect.flip);
        assert.include(authError.message, "but config forge auth");
        assert.strictEqual(
          calls.filter((args) => args[0] === "push" && !args.includes("--dry-run")).length,
          1,
        );
        assert.strictEqual(calls.filter((args) => args[0] === "pr").length, 2);
      }).pipe(Effect.provide(layer));
    },
  );

  describe("force-push guard", () => {
    const forced = (branch: string, upstreamCommits?: ReadonlyArray<unknown>) =>
      JSON.stringify({
        branches: [
          {
            branchName: branch,
            remote: "origin",
            requiresForce: true,
            ...(upstreamCommits ? { upstreamCommits } : {}),
          },
        ],
      });
    const stackStatus = (...branches: ReadonlyArray<string>) =>
      JSON.stringify({
        uncommittedChanges: [],
        stacks: [{ assignedChanges: [], branches: branches.map((name) => ({ name })) }],
      });
    const reviewOutput = JSON.stringify({
      published: [
        {
          sourceBranch: "api",
          targetBranch: "main",
          number: 1,
          htmlUrl: "https://example.com/pull/1",
          title: "api",
        },
      ],
      alreadyExisting: [],
    });
    const realWrites = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
      calls.filter(
        (args) => (args[0] === "push" && !args.includes("--dry-run")) || args[0] === "pr",
      );
    const answer = (args: ReadonlyArray<string>) =>
      Effect.succeed(args[0] === "status" ? statusOutput("api") : reviewOutput);

    const guardedActions = {
      push: (but: GitButlerWorkspace.GitButlerWorkspace["Service"], approval?: string) =>
        but
          .push({
            cwd: "/repo",
            branch: "api",
            ...(approval ? { forcePushApproval: approval } : {}),
          })
          .pipe(Effect.asVoid),
      pr: (but: GitButlerWorkspace.GitButlerWorkspace["Service"], approval?: string) =>
        but
          .createPullRequest({
            cwd: "/repo",
            branch: "api",
            ...(approval ? { forcePushApproval: approval } : {}),
          })
          .pipe(Effect.asVoid),
    };

    it.effect("needs an approval of the current remote to push or open a PR over it", () =>
      Effect.forEach([guardedActions.push, guardedActions.pr], (run) => {
        let remoteSha = "aaa";
        const { calls, layer } = butLayer(answer, undefined, {
          dryRun: () => Effect.succeed(forced("api", [{ sha: "aaa", message: "theirs" }])),
          revParse: () => Effect.succeed(remoteSha),
        });
        return Effect.gen(function* () {
          const but = yield* GitButlerWorkspace.GitButlerWorkspace;

          const refused = yield* run(but).pipe(Effect.flip);
          assert.strictEqual(refused._tag, "GitButlerForcePushConfirmationError");
          if (refused._tag !== "GitButlerForcePushConfirmationError") return;
          assert.deepStrictEqual(refused.targets, [
            {
              branch: "api",
              remote: "origin",
              remoteSha: "aaa",
              overwrittenCommits: [{ sha: "aaa", message: "theirs" }],
            },
          ]);
          assert.strictEqual(refused.staleApproval, false);
          assert.deepStrictEqual(realWrites(calls), []);

          // The remote moves between the confirmation and the action.
          remoteSha = "bbb";
          const stale = yield* run(but, refused.approval).pipe(Effect.flip);
          assert.strictEqual(stale._tag, "GitButlerForcePushConfirmationError");
          if (stale._tag !== "GitButlerForcePushConfirmationError") return;
          assert.strictEqual(stale.staleApproval, true);
          assert.notStrictEqual(stale.approval, refused.approval);
          assert.deepStrictEqual(realWrites(calls), []);

          yield* run(but, stale.approval);
          assert.strictEqual(realWrites(calls).length, 1);
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect("pushes nothing when it cannot name the remote commit being replaced", () => {
      const { calls, layer } = butLayer(answer, undefined, {
        dryRun: () => Effect.succeed(forced("api")),
        revParse: () =>
          Effect.fail(
            new VcsProcessExitError({
              operation: "test",
              command: "git",
              cwd: "/repo",
              exitCode: 1,
              detail: "unknown ref",
            }),
          ),
      });
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        const error = yield* but
          .push({ cwd: "/repo", branch: "api", forcePushApproval: "origin/api@unknown" })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "GitCommandError");
        assert.deepStrictEqual(realWrites(calls), []);
      }).pipe(Effect.provide(layer));
    });

    it.effect("checks the branches below a stacked branch, which a push also sends", () => {
      const { calls, layer } = butLayer(
        (args) => Effect.succeed(args[0] === "status" ? stackStatus("top", "mid", "base") : "{}"),
        undefined,
        {
          dryRun: (branch) =>
            Effect.succeed(branch === "base" ? forced("base") : JSON.stringify({ branches: [] })),
        },
      );
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        const refused = yield* but.push({ cwd: "/repo", branch: "top" }).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "GitButlerForcePushConfirmationError");
        if (refused._tag !== "GitButlerForcePushConfirmationError") return;
        assert.deepStrictEqual(
          refused.targets.map((target) => target.branch),
          ["base"],
        );
        assert.deepStrictEqual(realWrites(calls), []);

        // A branch higher in the stack is not part of what pushing `mid` sends.
        calls.length = 0;
        yield* but.push({ cwd: "/repo", branch: "mid" }).pipe(Effect.flip);
        assert.deepStrictEqual(
          calls.filter((args) => args.includes("--dry-run")).map((args) => args[1]),
          ["mid", "base"],
        );
      }).pipe(Effect.provide(layer));
    });

    it.effect("pushes nothing when the check cannot reach the remote or be read", () =>
      Effect.forEach(
        [
          () =>
            Effect.fail(
              new VcsProcessExitError({
                operation: "test",
                command: "but",
                cwd: "/repo",
                exitCode: 1,
                detail: "fetch failed",
              }),
            ),
          () => Effect.succeed('{"branches":[{}]}'),
        ],
        (dryRun) => {
          const { calls, layer } = butLayer(answer, undefined, { dryRun });
          return Effect.gen(function* () {
            const but = yield* GitButlerWorkspace.GitButlerWorkspace;
            const pushError = yield* but.push({ cwd: "/repo", branch: "api" }).pipe(Effect.flip);
            assert.strictEqual(pushError._tag, "GitCommandError");
            const prError = yield* but
              .createPullRequest({ cwd: "/repo", branch: "api" })
              .pipe(Effect.flip);
            assert.strictEqual(prError._tag, "GitCommandError");
            assert.deepStrictEqual(realWrites(calls), []);
          }).pipe(Effect.provide(layer));
        },
      ),
    );
  });

  describe("publication holds", () => {
    type Commit = { readonly commitId: string; readonly changeId: string };
    interface Fixture {
      readonly git: (...args: string[]) => string;
      /** The same repository as a restarted server sees it: no memory, only what git kept. */
      readonly restart: Effect.Effect<GitButlerWorkspace.GitButlerWorkspace["Service"]>;
      readonly writes: string[];
      readonly commits: Map<string, ReadonlyArray<Commit>>;
      readonly dir: string;
      /** Top first, as `but status` lists a stack. */
      stacks: ReadonlyArray<ReadonlyArray<string>>;
      commitBehavior: "clean" | "mismatch" | "fail" | "fail_after_landing" | "exit_1" | "hang";
      failGit: (args: ReadonlyArray<string>) => boolean;
      onCommitStart: Effect.Effect<void>;
      onDryRun: () => void;
    }

    const withFixture = <A, E>(
      use: (
        fixture: Fixture,
        but: GitButlerWorkspace.GitButlerWorkspace["Service"],
      ) => Effect.Effect<A, E>,
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-but-hold-"))),
        (dir) =>
          Effect.gen(function* () {
            const env = {
              ...process.env,
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_AUTHOR_NAME: "T3",
              GIT_AUTHOR_EMAIL: "t3@example.com",
              GIT_COMMITTER_NAME: "T3",
              GIT_COMMITTER_EMAIL: "t3@example.com",
            };
            const git = (...args: string[]) => {
              const result = NodeChildProcess.spawnSync("git", args, {
                cwd: dir,
                encoding: "utf8",
                env,
              });
              if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
              return result.stdout.trim();
            };
            git("init", "-q", "-b", "main");
            NodeFS.writeFileSync(NodePath.join(dir, "a.txt"), "base\n");
            git("add", "-A");
            git("commit", "-qm", "base");
            for (const branch of ["base", "feature", "upper", "other"]) git("branch", branch);
            NodeFS.writeFileSync(NodePath.join(dir, "a.txt"), "chosen\n");

            const real = yield* VcsProcess.VcsProcess;
            const succeed = (stdout: string) => ({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
            const land = (branch: string, extra: boolean): Commit => {
              if (extra) NodeFS.writeFileSync(NodePath.join(dir, "extra.txt"), "theirs\n");
              git("add", "-A");
              git("commit", "-qm", "selected");
              const commitId = git("rev-parse", "HEAD");
              git("branch", "-f", branch, commitId);
              const commit = { commitId, changeId: "changeidone" };
              fixture.commits.set(branch, [commit, ...(fixture.commits.get(branch) ?? [])]);
              return commit;
            };
            const processFake = VcsProcess.VcsProcess.of({
              run: (request) =>
                Effect.suspend(() => {
                  if (request.command === "git") {
                    return fixture.failGit(request.args)
                      ? Effect.fail(exitError(request))
                      : real.run({ ...request, env: { ...env, ...request.env } });
                  }
                  const [command] = request.args;
                  if (command === "status") {
                    return Effect.succeed(
                      succeed(
                        JSON.stringify({
                          uncommittedChanges: [
                            { filePath: "a.txt", cliId: "file", changeType: "modified" },
                          ],
                          stacks: fixture.stacks.map((names) => ({
                            assignedChanges: [],
                            branches: names.map((name) => ({
                              name,
                              commits: fixture.commits.get(name) ?? [],
                            })),
                          })),
                        }),
                      ),
                    );
                  }
                  if (command === "diff") {
                    return Effect.succeed(
                      succeed(
                        JSON.stringify({
                          changes: [
                            {
                              id: "file:1",
                              path: "a.txt",
                              status: "modified",
                              diff: {
                                type: "patch",
                                hunks: [{ diff: "@@ -1 +1 @@\n-base\n+chosen\n" }],
                              },
                            },
                          ],
                        }),
                      ),
                    );
                  }
                  if (command === "config") {
                    return Effect.succeed(
                      succeed(
                        JSON.stringify(
                          request.args[1] === "push-remote"
                            ? { push_remote: "origin" }
                            : { branch: "origin/main" },
                        ),
                      ),
                    );
                  }
                  if (request.args.includes("--dry-run")) {
                    fixture.onDryRun();
                    return Effect.succeed(succeed(JSON.stringify({ branches: [] })));
                  }
                  if (command === "commit") {
                    fixture.writes.push("commit");
                    return fixture.onCommitStart.pipe(
                      Effect.andThen(
                        Effect.suspend(
                          (): Effect.Effect<VcsProcess.VcsProcessOutput, VcsProcessExitError> => {
                            const branch = request.args[2]!;
                            switch (fixture.commitBehavior) {
                              case "hang":
                                return Effect.never;
                              case "exit_1":
                                return Effect.succeed({
                                  ...succeed(""),
                                  exitCode: ChildProcessSpawner.ExitCode(1),
                                });
                              case "fail":
                                return Effect.fail(exitError(request));
                              case "fail_after_landing":
                                land(branch, false);
                                return Effect.fail(exitError(request));
                              default:
                                return Effect.succeed(
                                  succeed(
                                    JSON.stringify(
                                      land(branch, fixture.commitBehavior === "mismatch"),
                                    ),
                                  ),
                                );
                            }
                          },
                        ),
                      ),
                    );
                  }
                  const target = request.args[command === "pr" ? 2 : 1];
                  fixture.writes.push(`${command} ${target}`);
                  return Effect.succeed(
                    succeed(
                      command === "pr"
                        ? JSON.stringify({
                            published: [
                              {
                                sourceBranch: target,
                                targetBranch: "main",
                                number: 1,
                                htmlUrl: "https://example.com/1",
                                title: "PR",
                              },
                            ],
                            alreadyExisting: [],
                          })
                        : "{}",
                    ),
                  );
                }),
            });
            const scope = yield* Effect.scope;
            const restart = Layer.buildWithScope(
              GitButlerWorkspace.layer.pipe(
                Layer.provide(Layer.succeed(VcsProcess.VcsProcess, processFake)),
                Layer.provide(NodeServices.layer),
              ),
              scope,
            ).pipe(
              Effect.map((context) => Context.get(context, GitButlerWorkspace.GitButlerWorkspace)),
            );
            const fixture: Fixture = {
              dir,
              git,
              restart,
              writes: [],
              commits: new Map(),
              stacks: [["upper", "feature", "base"], ["other"]],
              commitBehavior: "clean",
              failGit: () => false,
              onCommitStart: Effect.void,
              onDryRun: () => {},
            };
            return yield* use(fixture, yield* restart).pipe(
              // Stopping a commit is proven or not by platform; the Windows cases say so themselves.
              Effect.provideService(HostProcess.Platform, "linux"),
            );
          }).pipe(Effect.scoped),
        (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      ).pipe(Effect.provide(Layer.provideMerge(VcsProcess.layer, NodeServices.layer)));

    const commitOn = (
      fixture: Fixture,
      but: GitButlerWorkspace.GitButlerWorkspace["Service"],
      behavior: Fixture["commitBehavior"],
      branch = "feature",
    ) =>
      Effect.gen(function* () {
        const { files } = yield* but.readCommitChanges({ cwd: fixture.dir, branch });
        fixture.commitBehavior = behavior;
        return yield* but
          .commit({
            cwd: fixture.dir,
            branch,
            message: "Selected",
            changeIds: files[0]!.changeIds,
          })
          .pipe(Effect.exit);
      });
    const holdRefs = (fixture: Fixture) =>
      fixture.git("for-each-ref", "--format=%(refname)", "refs/t3/gitbutler-holds/");
    const refused = <A, R>(
      effect: Effect.Effect<
        A,
        GitCommandError | GitButlerForcePushConfirmationError | GitButlerPublicationHoldError,
        R
      >,
    ) =>
      effect.pipe(
        Effect.flip,
        Effect.map((error) => {
          if (error._tag !== "GitButlerPublicationHoldError") {
            throw new Error(`expected a hold, got ${error.message}`);
          }
          return error;
        }),
      );

    it.live("holds what a push or PR would send, including from above in a stack", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          const exit = yield* commitOn(fixture, but, "mismatch");
          assert.isTrue(Exit.isSuccess(exit));
          const cwd = fixture.dir;
          const direct = yield* refused(but.push({ cwd, branch: "feature" }));
          assert.deepInclude(direct.holds[0], {
            branch: "feature",
            state: "unverified",
            commitSha: fixture.git("rev-parse", "feature"),
            found: true,
          });
          yield* refused(but.push({ cwd, branch: "upper" }));
          yield* refused(but.createPullRequest({ cwd, branch: "feature" }));
          yield* refused(but.createPullRequest({ cwd, branch: "upper" }));
          assert.deepStrictEqual(fixture.writes, ["commit"]);
          // Neither sends the held commit: one is below it, and the other is another stack.
          yield* but.push({ cwd, branch: "base" });
          yield* but.push({ cwd, branch: "other" });
          assert.deepStrictEqual(fixture.writes, ["commit", "push base", "push other"]);
          assert.strictEqual((yield* but.readStatus(cwd)).heldCommitCount, 1);
        }),
      ),
    );

    it.live("keeps holding after a restart, until exactly what's held is approved", () =>
      withFixture((fixture, first) =>
        Effect.gen(function* () {
          yield* commitOn(fixture, first, "mismatch");
          const cwd = fixture.dir;
          const but = yield* fixture.restart;
          const hold = yield* refused(but.push({ cwd, branch: "feature" }));
          const stale = yield* refused(
            but.push({ cwd, branch: "feature", holdApproval: "something else" }),
          );
          assert.isTrue(stale.staleApproval);
          assert.deepStrictEqual(fixture.writes, ["commit"]);
          yield* but.push({ cwd, branch: "feature", holdApproval: hold.approval });
          assert.strictEqual(holdRefs(fixture), "");
          assert.isUndefined((yield* but.readStatus(cwd)).heldCommitCount);
          yield* but.push({ cwd, branch: "feature" });
          assert.deepStrictEqual(fixture.writes, ["commit", "push feature", "push feature"]);
        }),
      ),
    );

    it.live("follows a rewrite by change ID, and an amend voids an earlier approval", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          yield* commitOn(fixture, but, "mismatch");
          const cwd = fixture.dir;
          const held = fixture.git("rev-parse", "feature");
          const hold = yield* refused(but.push({ cwd, branch: "feature" }));

          const amended = { commitId: "f".repeat(40), changeId: "changeidone" };
          fixture.commits.set("feature", [amended]);
          const afterAmend = yield* refused(
            but.push({ cwd, branch: "feature", holdApproval: hold.approval }),
          );
          assert.isTrue(afterAmend.staleApproval);
          assert.strictEqual(afterAmend.holds[0]!.commitSha, amended.commitId);

          // Moved to another stack, it holds that stack and frees this one.
          fixture.commits.set("feature", []);
          fixture.commits.set("other", [amended]);
          const moved = yield* refused(but.push({ cwd, branch: "other" }));
          assert.strictEqual(moved.holds[0]!.branch, "other");
          yield* but.push({ cwd, branch: "feature" });
          assert.deepStrictEqual(fixture.writes, ["commit", "push feature"]);
          // The ref keeps the original inspectable however the branch was rewritten.
          assert.strictEqual(fixture.git("cat-file", "-t", held), "commit");
        }),
      ),
    );

    it.live("holds every stack once the commit can't be found, as after an uncommit", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          yield* commitOn(fixture, but, "mismatch");
          const cwd = fixture.dir;
          fixture.commits.set("feature", []);
          fixture.git("branch", "-f", "feature", "main");
          const lost = yield* refused(but.push({ cwd, branch: "other" }));
          assert.isFalse(lost.holds[0]!.found);
          assert.deepStrictEqual(fixture.writes, ["commit"]);
          yield* but.push({ cwd, branch: "other", holdApproval: lost.approval });
          assert.deepStrictEqual(fixture.writes, ["commit", "push other"]);
        }),
      ),
    );

    it.live("waits out an unapply, holds again on reapply, and holds all after deletion", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          yield* commitOn(fixture, but, "mismatch");
          const cwd = fixture.dir;
          const applied = fixture.stacks;
          const commits = fixture.commits.get("feature")!;
          fixture.stacks = [["other"]];
          fixture.commits.delete("feature");
          yield* but.push({ cwd, branch: "other" });

          fixture.stacks = applied;
          fixture.commits.set("feature", commits);
          yield* refused(but.push({ cwd, branch: "feature" }));

          fixture.stacks = [["other"]];
          fixture.commits.delete("feature");
          fixture.git("checkout", "-q", "main");
          fixture.git("branch", "-D", "feature");
          const lost = yield* refused(but.push({ cwd, branch: "other" }));
          assert.isFalse(lost.holds[0]!.found);
        }),
      ),
    );

    it.live("holds a branch whose commit was cut off, across a restart", () =>
      withFixture((fixture, first) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          fixture.onCommitStart = Deferred.succeed(started, undefined).pipe(Effect.asVoid);
          const fiber = yield* commitOn(fixture, first, "hang").pipe(Effect.forkChild);
          yield* Deferred.await(started);
          assert.isUndefined((yield* first.readStatus(fixture.dir)).heldCommitCount);
          yield* Fiber.interrupt(fiber);

          const but = yield* fixture.restart;
          const cwd = fixture.dir;
          const hold = yield* refused(but.createPullRequest({ cwd, branch: "upper" }));
          assert.deepInclude(hold.holds[0], {
            branch: "feature",
            state: "interrupted",
            commitSha: null,
            found: false,
          });
          assert.strictEqual((yield* but.readStatus(cwd)).heldCommitCount, 1);
          // Unidentified, it could have been moved, so another stack isn't provably clear of it.
          yield* refused(but.push({ cwd, branch: "other" }));
          assert.deepStrictEqual(fixture.writes, ["commit"]);
          // Nothing else identifies what was reviewed, so a moved tip voids the approval.
          const before = fixture.git("rev-parse", "upper");
          fixture.git("commit", "--allow-empty", "-qm", "later");
          fixture.git("branch", "-f", "upper", "HEAD");
          const stale = yield* refused(
            but.createPullRequest({ cwd, branch: "upper", holdApproval: hold.approval }),
          );
          assert.isTrue(stale.staleApproval);
          fixture.git("branch", "-f", "upper", before);
          yield* but.createPullRequest({ cwd, branch: "upper", holdApproval: hold.approval });
          assert.strictEqual(holdRefs(fixture), "");
        }),
      ),
    );

    it.live("drops the hold when a failed commit left the branch alone, not otherwise", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          const failed = yield* commitOn(fixture, but, "fail");
          assert.isTrue(Exit.isFailure(failed));
          assert.strictEqual(holdRefs(fixture), "");

          const landed = yield* commitOn(fixture, but, "fail_after_landing");
          assert.isTrue(Exit.isFailure(landed));
          assert.include(String(Exit.isFailure(landed) ? landed.cause : ""), "moved meanwhile");
          yield* refused(but.push({ cwd: fixture.dir, branch: "feature" }));
        }),
      ),
    );

    it.live("clears a confirmed commit's hold, and keeps holding if clearing fails", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          const clean = yield* commitOn(fixture, but, "clean");
          assert.isTrue(Exit.isSuccess(clean) && !clean.value?.selectionMismatch);
          assert.strictEqual(holdRefs(fixture), "");
          yield* but.push({ cwd: fixture.dir, branch: "feature" });

          NodeFS.writeFileSync(NodePath.join(fixture.dir, "a.txt"), "chosen again\n");
          fixture.failGit = (args) => args[0] === "update-ref" && args[1] === "--stdin";
          const uncleared = yield* commitOn(fixture, but, "clean");
          assert.isTrue(Exit.isSuccess(uncleared));
          fixture.failGit = () => false;
          const hold = yield* refused(but.push({ cwd: fixture.dir, branch: "feature" }));
          assert.strictEqual(hold.holds[0]!.state, "interrupted");
        }),
      ),
    );

    it.live("keeps holding with no commit identity when recording the mismatch fails", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          fixture.failGit = (args) => args[0] === "update-ref" && args[1] === "--stdin";
          const exit = yield* commitOn(fixture, but, "mismatch");
          assert.isTrue(Exit.isSuccess(exit) && !!exit.value?.selectionMismatch);
          fixture.failGit = () => false;
          yield* refused(but.push({ cwd: fixture.dir, branch: "feature" }));
          // The commit ended and its outcome was recorded, so the marker left behind can end too.
          const { holds } = yield* but.readHolds(fixture.dir);
          assert.strictEqual(holds.length, 2);
          yield* but.resolveHolds({
            cwd: fixture.dir,
            resolutions: holds.map((hold) => hold.resolution!),
          });
          assert.strictEqual(holdRefs(fixture), "");
        }),
      ),
    );

    it.live("commits nothing when it can't record the commit first", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          fixture.failGit = (args) => args[0] === "update-ref";
          const exit = yield* commitOn(fixture, but, "clean");
          assert.isTrue(Exit.isFailure(exit));
          assert.deepStrictEqual(fixture.writes, []);
        }),
      ),
    );

    it.live("publishes nothing when holds can't be read or released", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          const cwd = fixture.dir;
          yield* commitOn(fixture, but, "mismatch");
          const hold = yield* refused(but.push({ cwd, branch: "feature" }));
          fixture.failGit = (args) => args[0] === "update-ref";
          const release = yield* but
            .push({ cwd, branch: "feature", holdApproval: hold.approval })
            .pipe(Effect.flip);
          assert.strictEqual(release._tag, "GitCommandError");
          fixture.failGit = (args) =>
            args[0] === "for-each-ref" && args.at(-1) === "refs/t3/gitbutler-holds/";
          for (const publish of [
            but.push({ cwd, branch: "other" }),
            but.createPullRequest({ cwd, branch: "other" }),
            but.publishOutsideWorkspace({ cwd, branch: "other" }, Effect.void),
          ]) {
            assert.strictEqual((yield* publish.pipe(Effect.flip))._tag, "GitCommandError");
          }
          assert.deepStrictEqual(fixture.writes, ["commit"]);
        }),
      ),
    );

    it.live("a push that starts during a commit never sends it", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          fixture.onCommitStart = Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
          );
          const commit = yield* commitOn(fixture, but, "mismatch").pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const push = yield* but
            .push({ cwd: fixture.dir, branch: "feature" })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          assert.deepStrictEqual(fixture.writes, ["commit"]);
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(commit);
          const exit = yield* Fiber.join(push);
          assert.isTrue(Exit.isFailure(exit));
          assert.deepStrictEqual(fixture.writes, ["commit"]);
        }),
      ),
    );

    it.live("any hold stops a push outside workspace mode until it's approved", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          const cwd = fixture.dir;
          const pushes = { count: 0 };
          const publish = Effect.sync(() => {
            pushes.count += 1;
          });
          yield* but.publishOutsideWorkspace({ cwd, branch: "other" }, publish);
          yield* commitOn(fixture, but, "mismatch");
          const hold = yield* refused(
            but.publishOutsideWorkspace({ cwd, branch: "other" }, publish),
          );
          assert.isTrue(hold.holds[0]!.found);
          assert.strictEqual(pushes.count, 1);
          yield* but.publishOutsideWorkspace(
            { cwd, branch: "other", holdApproval: hold.approval },
            publish,
          );
          assert.strictEqual(pushes.count, 2);
          assert.strictEqual(holdRefs(fixture), "");
        }),
      ),
    );

    it.live("rechecks the stack after the dry run, in case a held branch moved below", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          yield* commitOn(fixture, but, "mismatch", "other");
          fixture.onDryRun = () => {
            fixture.stacks = [["upper", "feature", "base", "other"]];
          };
          yield* refused(but.push({ cwd: fixture.dir, branch: "feature" }));
          assert.deepStrictEqual(fixture.writes, ["commit"]);
        }),
      ),
    );

    describe("a commit not known to have ended", () => {
      const GONE_PID = 2_147_483_646;
      // How earlier versions keyed this machine, under which a gone pid read as safe to end.
      const LEGACY_HOST_KEY = NodeCrypto.createHash("sha256")
        .update(
          [
            NodeOS.hostname(),
            NodeFS.existsSync("/etc/machine-id")
              ? NodeFS.readFileSync("/etc/machine-id", "utf8")
              : "",
            NodeFS.existsSync("/proc/self/ns/pid") ? NodeFS.readlinkSync("/proc/self/ns/pid") : "",
          ].join("\0"),
        )
        .digest("hex")
        .slice(0, 16);
      const pendingRef = (id: string, branch = "feature") =>
        `refs/t3/gitbutler-holds/pending/${id}/-/${branch}`;
      const refusesPublishing = (
        but: GitButlerWorkspace.GitButlerWorkspace["Service"],
        fixture: Fixture,
        ref: string,
      ) =>
        Effect.gen(function* () {
          const cwd = fixture.dir;
          const writesBefore = [...fixture.writes];
          // The approval another client would compute, to show it's refused, not just not offered.
          const tips = fixture.git(
            "rev-parse",
            "refs/heads/upper",
            "refs/heads/feature",
            "refs/heads/base",
          );
          const holdApproval = `${ref}@${fixture.git("rev-parse", ref)}@\n${tips}`;
          for (const publish of [
            but.push({ cwd, branch: "upper" }),
            but.push({ cwd, branch: "upper", holdApproval }),
            but.createPullRequest({ cwd, branch: "upper", holdApproval }),
            but.publishOutsideWorkspace(
              { cwd, branch: "upper", holdApproval: `${ref}@x@\nx` },
              Effect.void,
            ),
          ]) {
            const error = yield* publish.pipe(Effect.flip);
            assert.strictEqual(error._tag, "GitCommandError");
            assert.include(error.message, `git update-ref -d '${ref}'`);
          }
          assert.deepStrictEqual(fixture.writes, writesBefore);
          assert.strictEqual(holdRefs(fixture), ref);
        });

      it.live.each([
        ["no process", "9f1c2d"],
        // Earlier markers named `<uuid>.<host key>.<pid>`, which is no evidence of anything.
        ["a live process", `u.${LEGACY_HOST_KEY}.${process.ppid}`],
        ["a process that's gone", `u.${LEGACY_HOST_KEY}.${GONE_PID}`],
        ["a pid this server now has", `u.${LEGACY_HOST_KEY}.${process.pid}`],
        ["a process on another host", `u.ab12.${GONE_PID}`],
      ] as const)("can't be approved or resolved when it names %s", ([, id]) =>
        withFixture((fixture, but) =>
          Effect.gen(function* () {
            const ref = pendingRef(id);
            fixture.git("update-ref", ref, "HEAD");
            yield* refusesPublishing(but, fixture, ref);
            const { holds } = yield* but.readHolds(fixture.dir);
            assert.strictEqual(holds[0]!.possiblyRunningRef, ref);
            assert.isUndefined(holds[0]!.resolution);
            const resolve = yield* but
              .resolveHolds({ cwd: fixture.dir, resolutions: ["anything"] })
              .pipe(Effect.flip);
            assert.include(resolve.message, "has changed");
            assert.strictEqual(holdRefs(fixture), ref);
          }),
        ),
      );

      it.live("a name it can't read isn't deleted on anyone's say-so", () =>
        withFixture((fixture, but) =>
          Effect.gen(function* () {
            const ref = "refs/t3/gitbutler-holds/v2/whatever";
            fixture.git("update-ref", ref, "HEAD");
            yield* refusesPublishing(but, fixture, ref);
          }),
        ),
      );

      it.live("stays held across a crash while its `but commit` is still running", () =>
        withFixture((fixture, but) =>
          Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            const finish = yield* Deferred.make<void>();
            fixture.onCommitStart = Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
            );
            const orphan = yield* commitOn(fixture, but, "clean").pipe(Effect.forkChild);
            yield* Deferred.await(started);
            const ref = holdRefs(fixture);
            // An older server would read a named process that's gone as safe to end.
            assert.match(ref, /gitbutler-holds\/pending\/[^./]+\/-\/feature$/);
            const restarted = yield* fixture.restart;
            yield* refusesPublishing(restarted, fixture, ref);
            const { holds } = yield* restarted.readHolds(fixture.dir);
            assert.strictEqual(holds[0]!.possiblyRunningRef, ref);
            assert.isUndefined(holds[0]!.resolution);
            yield* Deferred.succeed(finish, undefined);
            yield* Fiber.join(orphan);
          }),
        ),
      );

      it.live(
        "once it lands unrecorded, only a terminal ends the hold, and publishing resumes",
        () =>
          withFixture((fixture, but) =>
            Effect.gen(function* () {
              const cwd = fixture.dir;
              const ref = pendingRef(`u.${LEGACY_HOST_KEY}.${GONE_PID}`);
              fixture.git("update-ref", ref, "HEAD");
              fixture.git("commit", "--allow-empty", "-qm", "landed after the crash");
              const { holds } = yield* but.readHolds(cwd);
              assert.isUndefined(holds[0]!.resolution);
              yield* refusesPublishing(but, fixture, ref);
              fixture.git("update-ref", "-d", ref);
              assert.deepStrictEqual((yield* but.readHolds(cwd)).holds, []);
              yield* but.push({ cwd, branch: "feature" });
            }),
          ),
      );

      describe("on Windows, where a failed taskkill goes unreported", () => {
        const onWindows = Effect.provideService(HostProcess.Platform, "win32");

        it.live("stays pending when a commit was stopped rather than seen to exit", () =>
          withFixture((fixture, but) =>
            Effect.gen(function* () {
              const started = yield* Deferred.make<void>();
              fixture.onCommitStart = Deferred.succeed(started, undefined).pipe(Effect.asVoid);
              const commit = yield* commitOn(fixture, but, "hang").pipe(
                onWindows,
                Effect.forkChild,
              );
              yield* Deferred.await(started);
              yield* Fiber.interrupt(commit);
              const ref = holdRefs(fixture);
              assert.match(ref, /gitbutler-holds\/pending\//);
              yield* refusesPublishing(but, fixture, ref);
            }),
          ),
        );

        it.live("stays pending when a commit couldn't be run to an exit", () =>
          withFixture((fixture, but) =>
            Effect.gen(function* () {
              assert.isTrue(Exit.isFailure(yield* commitOn(fixture, but, "fail").pipe(onWindows)));
              assert.match(holdRefs(fixture), /gitbutler-holds\/pending\//);
            }),
          ),
        );

        it.live("clears a commit seen to exit with nothing landed", () =>
          withFixture((fixture, but) =>
            Effect.gen(function* () {
              assert.isTrue(
                Exit.isFailure(yield* commitOn(fixture, but, "exit_1").pipe(onWindows)),
              );
              assert.strictEqual(holdRefs(fixture), "");
            }),
          ),
        );
      });

      it.live("a commit this server is running reads as running, not reviewable", () =>
        withFixture((fixture, but) =>
          Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            const finish = yield* Deferred.make<void>();
            fixture.onCommitStart = Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
            );
            const commit = yield* commitOn(fixture, but, "clean").pipe(Effect.forkChild);
            yield* Deferred.await(started);
            const { holds } = yield* but.readHolds(fixture.dir);
            assert.isString(holds[0]!.possiblyRunningRef);
            yield* Deferred.succeed(finish, undefined);
            yield* Fiber.join(commit);
            assert.strictEqual(holdRefs(fixture), "");
          }),
        ),
      );

      it.live("marks a commit that ended unknown as ended, for every other server", () =>
        withFixture((fixture, but) =>
          Effect.gen(function* () {
            const landed = yield* commitOn(fixture, but, "fail_after_landing");
            assert.isTrue(Exit.isFailure(landed));
            assert.match(holdRefs(fixture), /gitbutler-holds\/interrupted\/[^/]+\/-\/feature$/);
            const restarted = yield* fixture.restart;
            const { holds } = yield* restarted.readHolds(fixture.dir);
            assert.isString(holds[0]!.resolution);
          }),
        ),
      );

      it.live("marks a cancelled commit as ended, and held", () =>
        withFixture((fixture, but) =>
          Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            fixture.onCommitStart = Deferred.succeed(started, undefined);
            const commit = yield* commitOn(fixture, but, "hang").pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* Fiber.interrupt(commit);
            assert.match(holdRefs(fixture), /gitbutler-holds\/interrupted\//);
          }),
        ),
      );

      it.live("an unknown outcome is held even if its pending hold was removed meanwhile", () =>
        withFixture((fixture, but) =>
          Effect.gen(function* () {
            fixture.onCommitStart = Effect.sync(() => {
              fixture.git("update-ref", "-d", holdRefs(fixture));
            });
            yield* commitOn(fixture, but, "fail_after_landing");
            yield* refused(but.push({ cwd: fixture.dir, branch: "feature" }));
          }),
        ),
      );
    });

    describe("ending a hold without publishing", () => {
      it.live("ends just what was reviewed, publishes nothing, and leaves the commit", () =>
        withFixture((fixture, but) =>
          Effect.gen(function* () {
            const cwd = fixture.dir;
            yield* commitOn(fixture, but, "mismatch");
            const sha = fixture.git("rev-parse", "feature");
            const otherSha = fixture.git("rev-parse", "other");
            fixture.commits.set("other", [{ commitId: otherSha, changeId: "c2" }]);
            fixture.git("update-ref", "refs/t3/gitbutler-holds/unverified/u2/c2/other", otherSha);
            const { holds } = yield* (yield* fixture.restart).readHolds(cwd);
            assert.strictEqual(holds.length, 2);
            const feature = holds.find((hold) => hold.branch === "feature")!;
            yield* but.resolveHolds({ cwd, resolutions: [feature.resolution!] });

            assert.deepStrictEqual(fixture.writes, ["commit"]);
            assert.strictEqual(fixture.git("rev-parse", "feature"), sha);
            assert.strictEqual((yield* but.readStatus(cwd)).heldCommitCount, 1);
            yield* but.push({ cwd, branch: "feature" });
            yield* refused(but.push({ cwd, branch: "other" }));
          }),
        ),
      );

      it.live("refuses a decision about anything that has since changed, ending nothing", () =>
        withFixture((fixture, but) =>
          Effect.gen(function* () {
            const cwd = fixture.dir;
            yield* commitOn(fixture, but, "mismatch");
            const { holds } = yield* but.readHolds(cwd);
            const [{ commitId, changeId }] = fixture.commits.get("feature") as [Commit];
            // A reword: same change, new commit.
            fixture.commits.set("feature", [{ commitId: `${commitId}0`, changeId }]);
            const stale = yield* but
              .resolveHolds({ cwd, resolutions: [holds[0]!.resolution!] })
              .pipe(Effect.flip);
            assert.include(stale.message, "has changed");
            assert.strictEqual((yield* but.readStatus(cwd)).heldCommitCount, 1);
            // All or none: one good decision doesn't carry a stale one along.
            const current = yield* but.readHolds(cwd);
            yield* but
              .resolveHolds({ cwd, resolutions: [current.holds[0]!.resolution!, "stale"] })
              .pipe(Effect.flip);
            assert.isTrue(holdRefs(fixture) !== "");
            yield* but.resolveHolds({ cwd, resolutions: [current.holds[0]!.resolution!] });
            assert.strictEqual(holdRefs(fixture), "");
          }),
        ),
      );

      it.live("voids a review of a commit it can't locate once any branch moves", () =>
        withFixture((fixture, but) =>
          Effect.gen(function* () {
            const cwd = fixture.dir;
            yield* commitOn(fixture, but, "fail_after_landing");
            // Identified, but no applied branch has it, as on an unapplied branch.
            fixture.git(
              "update-ref",
              "refs/t3/gitbutler-holds/unverified/u2/-/parked",
              fixture.git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "parked"),
            );
            const { holds } = yield* but.readHolds(cwd);
            assert.strictEqual(holds.length, 2);
            fixture.git("commit", "--allow-empty", "-qm", "later");
            fixture.git("branch", "-f", "other", "HEAD");
            for (const hold of holds) {
              const stale = yield* but
                .resolveHolds({ cwd, resolutions: [hold.resolution!] })
                .pipe(Effect.flip);
              assert.include(stale.message, "has changed");
            }
          }),
        ),
      );

      it.live("a rewrite after the hold was shown voids what was offered with it", () =>
        withFixture((fixture, but) =>
          Effect.gen(function* () {
            const cwd = fixture.dir;
            yield* commitOn(fixture, but, "mismatch");
            const [{ commitId, changeId }] = fixture.commits.get("feature") as [Commit];
            // Reworded by another writer once the push has located it, before the dialog is built.
            const original = fixture.failGit;
            fixture.failGit = (args) => {
              if (args[0] === "for-each-ref" && args.at(-1) === "refs/heads/") {
                fixture.commits.set("feature", [{ commitId: `${commitId}0`, changeId }]);
              }
              return original(args);
            };
            const hold = yield* refused(but.push({ cwd, branch: "feature" }));
            fixture.failGit = original;
            const stale = yield* but
              .resolveHolds({ cwd, resolutions: [hold.holds[0]!.resolution!] })
              .pipe(Effect.flip);
            assert.include(stale.message, "has changed");
            assert.strictEqual((yield* but.readStatus(cwd)).heldCommitCount, 1);
          }),
        ),
      );

      it.live("keeps a publish approval and a resolution from standing in for each other", () =>
        withFixture((fixture, but) =>
          Effect.gen(function* () {
            const cwd = fixture.dir;
            yield* commitOn(fixture, but, "mismatch");
            const hold = yield* refused(but.push({ cwd, branch: "feature" }));
            const asPublish = yield* refused(
              but.push({ cwd, branch: "feature", holdApproval: hold.holds[0]!.resolution! }),
            );
            assert.isTrue(asPublish.staleApproval);
            yield* but.resolveHolds({ cwd, resolutions: [hold.approval] }).pipe(Effect.flip);
            assert.deepStrictEqual(fixture.writes, ["commit"]);
            assert.isTrue(holdRefs(fixture) !== "");
          }),
        ),
      );
    });

    it.live("a commit whose pending hold was removed meanwhile is still held", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          fixture.onCommitStart = Effect.sync(() => {
            const ref = holdRefs(fixture);
            fixture.git("update-ref", "-d", ref);
          });
          yield* commitOn(fixture, but, "mismatch");
          const hold = yield* refused(but.push({ cwd: fixture.dir, branch: "feature" }));
          assert.strictEqual(hold.holds[0]!.state, "unverified");
        }),
      ),
    );

    it.live("keeps the hold when a failed commit moved a different branch", () =>
      withFixture((fixture, but) =>
        Effect.gen(function* () {
          fixture.onCommitStart = Effect.sync(() => {
            fixture.git("commit", "--allow-empty", "-qm", "landed and moved");
            fixture.git("branch", "-f", "other", "HEAD");
          });
          const exit = yield* commitOn(fixture, but, "fail");
          assert.isTrue(Exit.isFailure(exit));
          yield* refused(but.push({ cwd: fixture.dir, branch: "feature" }));
        }),
      ),
    );

    describe.skipIf(!butInstalled)("real but", () => {
      it.live("a real commit's hold survives a reword, and an uncommit holds everything", () =>
        withRaceFixture(
          {
            name: "hold",
            path: "logo.bin",
            changeType: "modified",
            change: (dir) => write(dir, "logo.bin", binary("chosen")),
            race: (dir) => write(dir, "logo.bin", binary("racer")),
          },
          "server",
          ({ dir, git, but, runBut }) =>
            Effect.gen(function* () {
              const { files } = yield* but.readCommitChanges({ cwd: dir, branch: "feature" });
              const file = files.find((entry) => entry.path === "logo.bin")!;
              const committed = yield* but.commit({
                cwd: dir,
                branch: "feature",
                message: "Selected",
                changeIds: file.changeIds,
              });
              assert.isString(committed?.selectionMismatch);
              const sha = committed!.commitSha;

              runBut("reword", sha, "-m", "Reworded");
              const reworded = git("rev-parse", "refs/heads/feature");
              assert.notStrictEqual(reworded, sha);
              const hold = yield* refused(but.push({ cwd: dir, branch: "feature" }));
              assert.strictEqual(hold.holds[0]!.commitSha, reworded);
              assert.isTrue(hold.holds[0]!.found);

              runBut("branch", "new", "bystander");
              runBut("uncommit", reworded);
              const lost = yield* refused(but.push({ cwd: dir, branch: "bystander" }));
              assert.isFalse(lost.holds[0]!.found);
              assert.strictEqual(git("cat-file", "-t", sha), "commit");
            }),
        ),
      );

      it.live("an approved push reaches the remote", () =>
        withRaceFixture(
          {
            name: "hold push",
            path: "logo.bin",
            changeType: "modified",
            change: (dir) => write(dir, "logo.bin", binary("chosen")),
            race: (dir) => write(dir, "logo.bin", binary("racer")),
          },
          "server",
          ({ dir, git, but, runBut }) =>
            Effect.gen(function* () {
              git("branch", "--set-upstream-to=origin/main", "main");
              runBut("config", "push-remote", "origin");
              const { files } = yield* but.readCommitChanges({ cwd: dir, branch: "feature" });
              const file = files.find((entry) => entry.path === "logo.bin")!;
              const committed = yield* but.commit({
                cwd: dir,
                branch: "feature",
                message: "Selected",
                changeIds: file.changeIds,
              });
              const hold = yield* refused(but.push({ cwd: dir, branch: "feature" }));
              assert.throws(() => git("rev-parse", "--verify", "refs/remotes/origin/feature"));
              yield* but.push({ cwd: dir, branch: "feature", holdApproval: hold.approval });
              assert.strictEqual(
                git("rev-parse", "refs/remotes/origin/feature"),
                committed!.commitSha,
              );
              assert.strictEqual(
                git("for-each-ref", "--format=%(refname)", "refs/t3/gitbutler-holds/"),
                "",
              );
            }),
        ),
      );
    });
  });

  it.effect("recognizes a revision only from the branch's commits or its own upstream", () => {
    const { layer } = butLayer(
      () =>
        Effect.succeed(
          JSON.stringify({
            uncommittedChanges: [],
            stacks: [
              {
                assignedChanges: [],
                branches: [
                  { name: "api", commits: [{ commitId: "local" }] },
                  { name: "other", commits: [{ commitId: "elsewhere" }] },
                ],
              },
            ],
          }),
        ),
      undefined,
      {
        revParse: (ref) =>
          ref === "api@{upstream}"
            ? Effect.succeed("pushed\n")
            : Effect.fail(
                new VcsProcessExitError({
                  operation: "test",
                  command: "git",
                  cwd: "/repo",
                  exitCode: 1,
                  detail: "no upstream",
                }),
              ),
      },
    );
    return Effect.gen(function* () {
      const but = yield* GitButlerWorkspace.GitButlerWorkspace;
      const has = (branch: string, sha: string) =>
        but.branchHasRevision({ cwd: "/repo", branch, sha });
      assert.isTrue(yield* has("api", "local"));
      assert.isTrue(yield* has("api", "pushed"));
      assert.isFalse(yield* has("api", "elsewhere"));
      assert.isFalse(yield* has("other", "pushed"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses only selected GitButler hunks as commit-message context", () => {
    const { calls, layer } = butLayer(() =>
      Effect.succeed(
        JSON.stringify({
          changes: [
            ...JSON.parse(diffOutput("new")).changes,
            {
              id: "a:2",
              path: "a.ts",
              status: "modified",
              diff: { type: "patch", hunks: [{ diff: "@@ -9 +9 @@\n-old\n+someone-elses\n" }] },
            },
          ],
        }),
      ),
    );
    return Effect.gen(function* () {
      const but = yield* GitButlerWorkspace.GitButlerWorkspace;
      const selection = {
        changeIds: ["a:1"],
        cliIds: ["a:1"],
        filePaths: ["a.ts"],
        expected: [],
      };
      const context = yield* but.readCommitContext("/repo", selection, true);
      assert.include(context?.stagedPatch ?? "", "+new");
      assert.notInclude(context?.stagedPatch ?? "", "someone-elses");
      assert.notInclude(context?.stagedPatch ?? "", "b.ts");
      assert.isNull(
        yield* but.readCommitContext(
          "/repo",
          { changeIds: [], cliIds: [], filePaths: [], expected: [] },
          true,
        ),
      );
      yield* but.readCommitContext("/repo", selection, false);
      assert.deepStrictEqual(calls, [["diff", "--json"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces conflicted commits even when pull exits successfully", () => {
    const { layer } = butLayer(() => Effect.succeed(JSON.stringify(pullConflict)));
    return Effect.gen(function* () {
      const but = yield* GitButlerWorkspace.GitButlerWorkspace;
      const error = yield* but.pull("/repo").pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitCommandError");
      assert.include(error.message, "conflicted commits");
    }).pipe(Effect.provide(layer));
  });

  it.effect("shares one branch read between a preview and its file reads, briefly", () => {
    const { calls, layer } = butLayer(() => Effect.succeed(diffOutput("new")));
    return Effect.gen(function* () {
      const gitButler = yield* GitButlerWorkspace.GitButlerWorkspace;
      const read = (path?: string) =>
        gitButler.readBranchDiff({
          cwd: "/repo",
          branch: "feature/api",
          ...(path ? { file: { path, previousPath: null } } : {}),
        });

      const [whole, a, b] = yield* Effect.all([read(), read("a.ts"), read("b.ts")], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(
        [whole, a, b].map((diff) => diff.files.map((file) => file.path)),
        [["a.ts", "b.ts"], ["a.ts"], ["b.ts"]],
      );
      assert.strictEqual(calls.length, 1);

      yield* TestClock.adjust("1 second");
      yield* read("a.ts");
      assert.strictEqual(calls.length, 1);

      yield* TestClock.adjust("2 seconds");
      yield* read("a.ts");
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("invalidates cached workspace status and branch diffs after each mutation", () =>
    Effect.forEach(["commit", "push", "pr", "pull"] as const, (action) => {
      const { calls, layer } = butLayer((args) =>
        Effect.succeed(
          args[0] === "status"
            ? JSON.stringify({
                uncommittedChanges: [{ cliId: "file", filePath: "a.ts" }],
                stacks: [{ branches: [{ name: "api" }], assignedChanges: [] }],
              })
            : args[0] === "diff"
              ? diffOutput("new")
              : args[0] === "commit"
                ? JSON.stringify(commitOutput)
                : args[0] === "pr"
                  ? JSON.stringify({
                      published: [
                        {
                          sourceBranch: "api",
                          targetBranch: "main",
                          number: 1,
                          htmlUrl: "https://github.com/acme/repo/pull/1",
                          title: "API",
                        },
                      ],
                      alreadyExisting: [],
                    })
                  : JSON.stringify({
                      status: "completed",
                      conflicts: [],
                      summary: { branchesConflicted: 0 },
                    }),
        ),
      );
      return Effect.gen(function* () {
        const but = yield* GitButlerWorkspace.GitButlerWorkspace;
        yield* but.readStatus("/repo");
        yield* but.readBranchDiff({ cwd: "/repo", branch: "api" });
        if (action === "commit") {
          const { files } = yield* but.readCommitChanges({ cwd: "/repo", branch: "api" });
          yield* but.commit({
            cwd: "/repo",
            branch: "api",
            message: "API",
            changeIds: files[0]!.changeIds,
          });
        } else if (action === "push") yield* but.push({ cwd: "/repo", branch: "api" });
        else if (action === "pr") yield* but.createPullRequest({ cwd: "/repo", branch: "api" });
        else yield* but.pull("/repo");
        yield* but.readStatus("/repo");
        yield* but.readBranchDiff({ cwd: "/repo", branch: "api" });
        assert.strictEqual(
          calls.filter((args) => args[0] === "status").length,
          // A commit reads status again for each check its selection goes through.
          action === "pull" ? 2 : action === "commit" ? 4 : 3,
        );
        // The commit's own check reads uncommitted changes, apart from the two cached branch reads.
        assert.strictEqual(
          calls.filter((args) => args[0] === "diff" && args[1] === "api").length,
          2,
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("never keeps a failed branch read", () => {
    const { calls, layer } = butLayer((_, call) =>
      call === 1
        ? Effect.fail(exitError({ operation: "", command: "but", args: [], cwd: "" }))
        : Effect.succeed(diffOutput("new")),
    );
    return Effect.gen(function* () {
      const gitButler = yield* GitButlerWorkspace.GitButlerWorkspace;
      const read = gitButler.readBranchDiff({ cwd: "/repo", branch: "feature/api" });

      const failure = yield* read.pipe(Effect.flip);
      assert.strictEqual(failure._tag, "VcsProcessExitError");
      const success = yield* read;
      assert.strictEqual(success.files.length, 2);
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a read that started before an invalidation out of the cache", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { calls, layer } = butLayer((_, call) =>
        call === 1
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(diffOutput("before-edit")),
            )
          : Effect.succeed(diffOutput("after-edit")),
      );
      yield* Effect.gen(function* () {
        const gitButler = yield* GitButlerWorkspace.GitButlerWorkspace;
        const read = gitButler.readBranchDiff({ cwd: "/repo", branch: "feature/api" });

        const early = yield* Effect.forkChild(read);
        yield* Deferred.await(started);
        yield* gitButler.invalidate("/repo");
        const fresh = yield* read;
        yield* Deferred.succeed(release, undefined);
        const stale = yield* Fiber.join(early);
        const later = yield* read;

        assert.include(stale.patch, "+before-edit");
        assert.include(fresh.patch, "+after-edit");
        assert.include(later.patch, "+after-edit");
        assert.strictEqual(calls.length, 2);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reads each branch's own publication state and the push remote", () => {
    const { layer } = butLayer(() =>
      Effect.succeed(
        JSON.stringify({
          uncommittedChanges: [],
          stacks: [
            {
              assignedChanges: [],
              branches: [
                { name: "empty", branchStatus: "completelyUnpushed", commits: [] },
                { name: "new", branchStatus: "completelyUnpushed", commits: [{}] },
                { name: "ahead", branchStatus: "unpushedCommits", commits: [{}] },
              ],
            },
            {
              assignedChanges: [],
              branches: [
                { name: "rewritten", branchStatus: "unpushedCommitsRequiringForce", commits: [{}] },
                { name: "pushed", branchStatus: "nothingToPush", commits: [{}] },
                { name: "landed", branchStatus: "integrated", commits: [{}] },
                { name: "future", branchStatus: "somethingNew", commits: [{}] },
                { name: "older-cli" },
              ],
            },
          ],
        }),
      ),
    );
    return Effect.gen(function* () {
      const status = yield* (yield* GitButlerWorkspace.GitButlerWorkspace).readStatus("/repo");
      assert.equal(status.pushRemote, "fork");
      assert.deepStrictEqual(status.publications, {
        empty: "empty",
        new: "unpublished",
        ahead: "ahead",
        rewritten: "force_required",
        pushed: "up_to_date",
        landed: "integrated",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("reuses workspace status until it expires or is invalidated", () => {
    const { calls, layer } = butLayer((_, call) => Effect.succeed(statusOutput(`branch-${call}`)));
    return Effect.gen(function* () {
      const gitButler = yield* GitButlerWorkspace.GitButlerWorkspace;
      const branches = gitButler
        .readStatus("/repo")
        .pipe(Effect.map((status) => status.stacks.flatMap((stack) => stack.branches)));

      assert.deepStrictEqual(yield* branches, ["branch-1"]);
      assert.deepStrictEqual(yield* branches, ["branch-1"]);
      yield* gitButler.invalidate("/repo");
      assert.deepStrictEqual(yield* branches, ["branch-2"]);
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* branches, ["branch-3"]);
      assert.strictEqual(calls.length, 3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("caches status read with the older CLI syntax after a non-zero exit", () => {
    const { calls, layer } = butLayer((args) =>
      args[0] === "status"
        ? Effect.fail(exitError({ operation: "", command: "but", args, cwd: "/repo" }))
        : Effect.succeed(statusOutput("feature/api")),
    );
    return Effect.gen(function* () {
      const gitButler = yield* GitButlerWorkspace.GitButlerWorkspace;
      const status = yield* gitButler.readStatus("/repo");

      assert.deepStrictEqual(status.stacks, [
        { branches: ["feature/api"], assignedChangeCount: 0 },
      ]);
      assert.deepStrictEqual(yield* gitButler.readStatus("/repo"), status);
      assert.deepStrictEqual(calls, [
        ["status", "--json"],
        ["--format", "json", "status"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes git-style envelopes and keeps changes it cannot render", () => {
    const { layer } = butLayer(() =>
      Effect.succeed(
        JSON.stringify({
          changes: [
            {
              path: "new.ts",
              status: "added",
              diff: { type: "patch", hunks: [{ diff: "@@ -0,0 +1 @@\n+hello\n" }] },
            },
            {
              path: "gone.ts",
              status: "deleted",
              diff: { type: "patch", hunks: [{ diff: "@@ -1 +0,0 @@\n-bye\n" }] },
            },
            {
              path: "src/next.ts",
              previousPath: "src/prev.ts",
              status: "modified",
              diff: { type: "patch", hunks: [] },
            },
            { path: 'odd\tname"x.png', status: "modified", diff: { type: "binary" } },
            // Neither of these has a path to show, so only they are skipped.
            { status: "modified" },
            42,
          ],
        }),
      ),
    );
    return Effect.gen(function* () {
      const gitButler = yield* GitButlerWorkspace.GitButlerWorkspace;
      const diff = yield* gitButler.readBranchDiff({ cwd: "/repo", branch: "feature/api" });

      assert.strictEqual(
        diff.patch,
        [
          "diff --git a/new.ts b/new.ts",
          "--- /dev/null",
          "+++ b/new.ts",
          "@@ -0,0 +1 @@",
          "+hello",
          "diff --git a/gone.ts b/gone.ts",
          "--- a/gone.ts",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-bye",
          "diff --git a/src/prev.ts b/src/next.ts",
          "rename from src/prev.ts",
          "rename to src/next.ts",
          "--- a/src/prev.ts",
          "+++ b/src/next.ts",
          'diff --git "a/odd\\tname\\"x.png" "b/odd\\tname\\"x.png"',
          'Binary files "a/odd\\tname\\"x.png" and "b/odd\\tname\\"x.png" differ',
          "",
        ].join("\n"),
      );
      assert.notInclude(diff.patch, " mode ");
      assert.deepStrictEqual(diff.files, [
        { path: "new.ts", previousPath: null, additions: 1, deletions: 0 },
        { path: "gone.ts", previousPath: null, additions: 0, deletions: 1 },
        { path: "src/next.ts", previousPath: "src/prev.ts", additions: 0, deletions: 0 },
        { path: 'odd\tname"x.png', previousPath: null, additions: 0, deletions: 0 },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses branch names that `but` would read as options", () => {
    const { calls, layer } = butLayer(() => Effect.succeed(diffOutput("new")));
    return Effect.gen(function* () {
      const gitButler = yield* GitButlerWorkspace.GitButlerWorkspace;
      const error = yield* gitButler
        .readBranchDiff({ cwd: "/repo", branch: "--help" })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitCommandError");
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(layer));
  });
});
