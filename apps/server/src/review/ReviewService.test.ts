import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ChildProcessSpawner } from "effect/process";
import {
  ProjectId,
  VcsProcessExitError,
  type ReviewDiffPreviewResult,
  type ReviewDiffPreviewSource,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitButlerWorkspace from "../vcs/GitButlerWorkspace.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as ReviewService from "./ReviewService.ts";

function layer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly worktreesDirectory?: string;
  readonly previousWorktreesDirectories?: ReadonlyArray<string>;
  readonly projectRoots?: ReadonlyArray<string> | "unavailable";
  /** Tracked by the first project. */
  readonly trackedFolders?: ReadonlyArray<string>;
  readonly threadWorktrees?: ReadonlyArray<{ worktreePath: string; deleted?: boolean }>;
  readonly gitWorktrees?: ReadonlyArray<string>;
  /** Detects a Git repository whose review preview is this result. */
  readonly gitPreview?: ReviewDiffPreviewResult;
  /** Answers `but` invocations by argv; a missing answer exits non-zero. */
  readonly but?: Readonly<Record<string, string>>;
  readonly butCalls?: Array<ReadonlyArray<string>>;
}) {
  const projectRoots = input.projectRoots ?? [];
  const butProcess = VcsProcess.VcsProcess.of({
    run: (request) =>
      Effect.suspend(() => {
        input.butCalls?.push(request.args);
        const stdout = input.but?.[request.args.join(" ")];
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
  return ReviewService.layer.pipe(
    Layer.provide(
      GitButlerWorkspace.layer.pipe(
        Layer.provide(Layer.succeed(VcsProcess.VcsProcess, butProcess)),
      ),
    ),
    Layer.provide(KnownWorkspaces.layer),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [index, thread] of (input.threadWorktrees ?? []).entries()) {
            yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
                created_at, updated_at, deleted_at, payload_json
              ) VALUES (
                ${`thread-${index}`}, 'project-0', 'Thread', 'codex', 'full-access', 'default',
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                ${thread.deleted ? "2026-01-02T00:00:00.000Z" : null},
                ${JSON.stringify({ worktreePath: thread.worktreePath })}
              )
            `;
          }
        }),
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          projectRoots === "unavailable"
            ? Effect.fail(
                new ProjectStore.ProjectStoreV2Error({ operation: "list", cause: "offline" }),
              )
            : Effect.succeed(
                projectRoots.map((workspaceRoot, index) => ({
                  id: ProjectId.make(`project-${index}`),
                  title: `Project ${index}`,
                  workspaceRoot,
                  ...(index === 0 && input.trackedFolders !== undefined
                    ? {
                        trackedFolders: input.trackedFolders.map((path) => ({
                          path,
                          name: path,
                        })),
                      }
                    : {}),
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                })),
              ),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return input.gitPreview
              ? ({ kind: "git", driver: {} } as VcsDriverRegistry.VcsDriverHandle)
              : null;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        listWorktreePaths: () => Effect.succeed([...(input.gitWorktrees ?? [])]),
        getReviewDiffPreview: () =>
          input.gitPreview
            ? Effect.succeed(input.gitPreview)
            : Effect.die("unexpected Git review preview"),
      }),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        worktreesDirectory: input.worktreesDirectory ?? "",
        previousWorktreesDirectories: [...(input.previousWorktreesDirectories ?? [])],
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
}

const gitSource = (
  kind: "working-tree" | "branch-range",
  headRef: string | null,
): ReviewDiffPreviewSource => ({
  id: kind,
  kind,
  title: kind === "working-tree" ? "Uncommitted" : "Changes",
  baseRef: kind === "working-tree" ? "HEAD" : "origin/main",
  headRef,
  diff: "",
  diffHash: `${kind}-hash`,
  truncated: false,
  files: [],
});

const gitPreview = (cwd: string, headRef: string): ReviewDiffPreviewResult => ({
  cwd,
  generatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
  sources: [gitSource("working-tree", null), gitSource("branch-range", headRef)],
});

const butChange = (path: string, body: string, extra: Record<string, unknown> = {}) => ({
  path,
  status: "modified",
  diff: { type: "patch", hunks: [{ diff: `@@ -1,1 +1,2 @@\n${body}\n` }] },
  ...extra,
});

const butDiff = (changes: ReadonlyArray<ReturnType<typeof butChange>>) =>
  JSON.stringify({ changes });

describe("ReviewService", () => {
  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows previous custom worktree locations but never a filesystem root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const previous = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-old-worktrees-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: previous });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: "/",
            previousWorktreesDirectories: [previous],
          }),
        ),
      );
      assert.strictEqual(result.cwd, previous);

      const rootLink = `${baseDir}/root-link`;
      yield* fs.symlink("/", rootLink);
      for (const worktreesDirectory of ["/", rootLink]) {
        const error = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, worktreesDirectory })));
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows registered project roots outside the server cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const projectChild = `${projectRoot}/packages/app`;
      yield* fs.makeDirectory(projectChild, { recursive: true });
      const sibling = `${projectRoot}-sibling`;
      yield* fs.makeDirectory(sibling);
      yield* Effect.addFinalizer(() => fs.remove(sibling, { recursive: true }).pipe(Effect.ignore));

      const review = (cwd: string, projectRoots: ReadonlyArray<string> | "unavailable") =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, projectRoots })));

      assert.strictEqual((yield* review(projectRoot, [projectRoot])).cwd, projectRoot);
      assert.strictEqual((yield* review(projectChild, [projectRoot])).cwd, projectChild);
      const dottedChild = `${projectRoot}/..feature`;
      yield* fs.makeDirectory(dottedChild);
      assert.strictEqual((yield* review(dottedChild, [projectRoot])).cwd, dottedChild);
      for (const [cwd, projectRoots] of [
        [sibling, [projectRoot]],
        [projectRoot, []],
        [projectRoot, "unavailable"],
      ] as const) {
        const error = yield* review(cwd, projectRoots).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a project's tracked folders outside the project folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-tracked-" });
      const repository = `${outside}/api`;
      const nested = `${repository}/src`;
      const untracked = `${outside}/web`;
      const linked = `${outside}/api-link`;
      const missing = `${outside}/gone`;
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* fs.makeDirectory(untracked);
      yield* fs.symlink(repository, linked);

      const review = (
        cwd: string,
        trackedFolders: ReadonlyArray<string>,
        projectRoots: ReadonlyArray<string> = [projectRoot],
      ) =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, projectRoots, trackedFolders })));

      assert.strictEqual((yield* review(repository, [repository])).cwd, repository);
      assert.strictEqual((yield* review(nested, [repository])).cwd, nested);
      // Tracked under a symlink's name, reached by the real path, and the reverse.
      assert.strictEqual((yield* review(repository, [linked])).cwd, repository);
      assert.strictEqual((yield* review(linked, [repository])).cwd, linked);
      // A tracked folder that is gone stays known, as a missing project folder does.
      assert.strictEqual((yield* review(missing, [missing])).cwd, missing);
      for (const [cwd, trackedFolders, projectRoots] of [
        [untracked, [repository], [projectRoot]],
        [outside, [repository], [projectRoot]],
        [repository, [], [projectRoot]],
        // A deleted project is no longer listed, and its tracked folders go with it.
        [repository, [repository], []],
      ] as const) {
        const error = yield* review(cwd, trackedFolders, projectRoots).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows the worktree a thread is bound to, and nothing else outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const bound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-bound-" });
      const deleted = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-deleted-" });
      const unbound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-unbound-" });
      const claimed = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-claimed-" });
      yield* fs.makeDirectory(`${bound}/sub`);

      const review = (cwd: string) =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(
          Effect.provide(
            layer({
              workspaceRoot,
              baseDir,
              projectRoots: [project],
              gitWorktrees: [project, bound, deleted],
              threadWorktrees: [
                { worktreePath: bound },
                { worktreePath: claimed },
                { worktreePath: deleted, deleted: true },
                { worktreePath: "t3-review-relative" },
                { worktreePath: "/" },
              ],
            }),
          ),
        );

      for (const cwd of [bound, `${bound}/sub`]) {
        assert.strictEqual((yield* review(cwd)).cwd, cwd);
      }
      for (const cwd of [deleted, unbound, claimed, `${process.cwd()}/t3-review-relative`]) {
        const error = yield* review(cwd).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a thread's worktree linked from a managed folder to a checkout elsewhere", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const managed = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-worktrees-" }),
      );
      const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-checkout-" });
      yield* fs.symlink(checkout, `${managed}/feature`);

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: checkout });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: managed,
            threadWorktrees: [{ worktreePath: `${managed}/feature` }],
          }),
        ),
      );
      assert.strictEqual(result.cwd, checkout);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the default review to Git sections on a GitButler checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const butCalls: Array<ReadonlyArray<string>> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            gitPreview: gitPreview(workspaceRoot, "gitbutler/workspace"),
            butCalls,
          }),
        ),
      );

      assert.deepStrictEqual(
        result.sources.map((source) => source.id),
        ["working-tree", "branch-range"],
      );
      assert.deepStrictEqual(butCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reviews one applied branch with one `but diff` shared by its file reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const butCalls: Array<ReadonlyArray<string>> = [];

      const [preview, filePatches, missing] = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const preview = yield* review.getDiffPreview({
          cwd: workspaceRoot,
          gitbutlerBranch: "feature/api",
        });
        const filePatches = yield* Effect.forEach(
          ["src/api.ts", "src/view.tsx"],
          (path) =>
            review.getDiffPreview({
              cwd: workspaceRoot,
              gitbutlerBranch: "feature/api",
              file: { path, previousPath: null, sourceKind: "gitbutler-branch" },
            }),
          { concurrency: "unbounded" },
        );
        const missing = yield* review
          .getDiffPreview({ cwd: workspaceRoot, gitbutlerBranch: "gone" })
          .pipe(Effect.flip);
        return [preview, filePatches, missing] as const;
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            butCalls,
            but: {
              "diff feature/api --json": butDiff([
                butChange("src/api.ts", " kept\n+api"),
                butChange("src/view.tsx", "-old\n+new"),
              ]),
            },
          }),
        ),
      );

      assert.deepStrictEqual(butCalls, [
        ["diff", "feature/api", "--json"],
        ["diff", "gone", "--json"],
      ]);
      assert.strictEqual(preview.sources.length, 1);
      const [source] = preview.sources;
      assert.strictEqual(source?.id, "gitbutler-branch:feature/api");
      assert.strictEqual(source?.kind, "gitbutler-branch");
      assert.strictEqual(source?.headRef, "feature/api");
      assert.strictEqual(source?.baseRef, null);
      assert.deepStrictEqual(
        filePatches.map((patch) => patch.sources[0]?.files?.map((file) => file.path)),
        [["src/api.ts"], ["src/view.tsx"]],
      );
      // A branch the CLI cannot diff fails the request instead of rendering as empty.
      assert.strictEqual(missing._tag, "VcsProcessExitError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to expand unchanged lines of a GitButler branch diff", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .getDiffFileContents({
            cwd: workspaceRoot,
            sourceKind: "gitbutler-branch",
            changeType: "change",
            baseRef: null,
            headRef: "feature/api",
            oldPath: "src/api.ts",
            newPath: "src/api.ts",
          })
          .pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            detectCalls,
            gitPreview: gitPreview(workspaceRoot, "gitbutler/workspace"),
          }),
        ),
      );

      assert.strictEqual(error._tag, "VcsUnsupportedOperationError");
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads one file of one GitButler branch without consulting Git", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({
          cwd: workspaceRoot,
          gitbutlerBranch: "feature/api",
          file: { path: "src/b.ts", previousPath: null, sourceKind: "gitbutler-branch" },
        });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            detectCalls,
            but: {
              "diff feature/api --json": butDiff([
                butChange("src/a.ts", "+a"),
                butChange("src/b.ts", "+b"),
              ]),
            },
          }),
        ),
      );

      assert.deepStrictEqual(detectCalls, []);
      assert.strictEqual(result.sources.length, 1);
      const [source] = result.sources;
      assert.strictEqual(source?.id, "gitbutler-branch:feature/api");
      assert.deepStrictEqual(
        source?.files?.map((file) => file.path),
        ["src/b.ts"],
      );
      assert.notInclude(source?.diff ?? "", "src/a.ts");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("caps a large GitButler branch patch but keeps every file's counts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const largeBody = Array.from(
        { length: 5_000 },
        (_, index) => `+line ${index} ${"x".repeat(40)}`,
      );

      const { result, metadata } = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return {
          result: yield* review.getDiffPreview({ cwd: workspaceRoot, gitbutlerBranch: "big" }),
          metadata: yield* review.getDiffPreview({
            cwd: workspaceRoot,
            gitbutlerBranch: "big",
            metadataOnly: true,
          }),
        };
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            but: {
              "diff big --json": butDiff([
                butChange("big.txt", largeBody.join("\n")),
                butChange("small.txt", "+small"),
              ]),
            },
          }),
        ),
      );

      const [source] = result.sources;
      assert.strictEqual(source?.truncated, true);
      assert.isTrue(source?.diff.endsWith("[truncated]"));
      assert.isBelow(source?.diff.length ?? Infinity, 121_000);
      assert.deepStrictEqual(source?.files, [
        { path: "big.txt", previousPath: null, additions: 5_000, deletions: 0 },
        { path: "small.txt", previousPath: null, additions: 1, deletions: 0 },
      ]);

      const [metadataSource] = metadata.sources;
      assert.strictEqual(metadataSource?.diff, "");
      assert.strictEqual(metadataSource?.truncated, false);
      assert.strictEqual(metadataSource?.patchesDeferred, true);
      assert.deepStrictEqual(metadataSource?.files, source?.files);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
