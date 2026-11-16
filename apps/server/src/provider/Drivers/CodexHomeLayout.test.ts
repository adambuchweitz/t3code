import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
import {
  applyCodexSqliteHomeEnvironment,
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePathConflictError,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
const decodeCodexSettingsValue = Schema.decodeSync(CodexSettings);

const decodeCodexSettings = (input: {
  readonly enabled?: boolean;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly customModels?: readonly string[];
  readonly binaryPath?: string;
}): CodexSettings => decodeCodexSettingsValue(input);

const makeTempDir = Effect.fn("CodexHomeLayout.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("CodexHomeLayout.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("CodexHomeLayout", (it) => {
  describe("resolveCodexHomeLayout", () => {
    it.effect("uses the shared home for continuation and the shadow home for runtime", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        expect(layout).toMatchObject({
          mode: "authOverlay",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
          continuationKey: `codex:home:${sharedHome}`,
        });
      }),
    );

    it.effect("defaults CODEX_SQLITE_HOME only for auth overlays without an explicit value", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");
        const overlayLayout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );
        const directLayout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
          }),
        );

        expect(yield* applyCodexSqliteHomeEnvironment(overlayLayout, {})).toMatchObject({
          CODEX_SQLITE_HOME: sharedHome,
        });
        expect(
          yield* applyCodexSqliteHomeEnvironment(overlayLayout, {
            CODEX_SQLITE_HOME: "/configured/sqlite",
          }),
        ).toMatchObject({ CODEX_SQLITE_HOME: "/configured/sqlite" });
        expect(
          yield* applyCodexSqliteHomeEnvironment(overlayLayout, { CODEX_SQLITE_HOME: "  " }),
        ).toMatchObject({ CODEX_SQLITE_HOME: sharedHome });
        expect(
          yield* applyCodexSqliteHomeEnvironment(
            overlayLayout,
            { CODEX_SQLITE_HOME: "  " },
            { CODEX_SQLITE_HOME: "/inherited/sqlite" },
          ),
        ).toMatchObject({ CODEX_SQLITE_HOME: sharedHome });
        const customHome = yield* applyCodexSqliteHomeEnvironment(overlayLayout, {
          CODEX_SQLITE_HOME: "~/sqlite-custom",
          OTHER: "~/unchanged",
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, sharedHome));
        expect(customHome).toEqual({
          CODEX_SQLITE_HOME: path.join(sharedHome, "sqlite-custom"),
          OTHER: "~/unchanged",
        });
        expect(yield* applyCodexSqliteHomeEnvironment(directLayout, {})).not.toHaveProperty(
          "CODEX_SQLITE_HOME",
        );
      }),
    );
  });

  it.effect.each([
    { env: { Codex_Sqlite_Home: "~/sqlite" }, inherited: {}, expected: "~/sqlite" },
    {
      env: { CODEX_SQLITE_HOME: "/inherited/sqlite", Codex_Sqlite_Home: "~/sqlite" },
      inherited: {},
      expected: "~/sqlite",
    },
    {
      env: { Codex_Sqlite_Home: "/inherited/sqlite", CODEX_SQLITE_HOME: "~/sqlite" },
      inherited: {},
      expected: "~/sqlite",
    },
    { env: {}, inherited: { Codex_Sqlite_Home: "/inherited/sqlite" }, expected: undefined },
    {
      env: { codex_sqlite_home: "" },
      inherited: { CODEX_SQLITE_HOME: "/inherited/sqlite" },
      expected: "shared",
    },
  ])("honors Windows SQLite environment key casing: $env", ({ env, inherited, expected }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* HostProcess.HomeDirectory;
      const layout = yield* resolveCodexHomeLayout(
        decodeCodexSettings({
          homePath: "/shared",
          shadowHomePath: "/shadow",
        }),
      );
      const result = yield* applyCodexSqliteHomeEnvironment(layout, env, inherited);
      const entries = Object.entries(result).filter(
        ([key]) => key.toUpperCase() === "CODEX_SQLITE_HOME",
      );
      expect(entries.map(([, value]) => value)).toEqual(
        expected === undefined
          ? []
          : [expected === "shared" ? layout.sharedHomePath : path.join(home, "sqlite")],
      );
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );

  describe("materializeCodexShadowHome", () => {
    it.effect.skipIf(!symlinksSupported)(
      "keeps Finder metadata local across repeated shadow home setup",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const sharedMetadata = path.join(sharedHome, ".DS_Store");
          const shadowMetadata = path.join(shadowHome, ".DS_Store");

          yield* writeTextFile(sharedMetadata, "shared Finder metadata");
          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          yield* fileSystem.remove(shadowMetadata);
          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.exists(shadowMetadata)).toBe(false);

          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* materializeCodexShadowHome(layout);
          yield* materializeCodexShadowHome(layout);

          expect(yield* fileSystem.readFileString(sharedMetadata)).toBe("shared Finder metadata");
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"))).toBe(
            '{"shadow":true}\n',
          );
          expect(yield* fileSystem.readLink(path.join(shadowHome, "sessions"))).toBe(
            path.join(sharedHome, "sessions"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "materializes a shadow home with shared state links and private auth",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "sessions"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(
            path.join(sharedHome, "models_cache.json"),
            '{"models":["shared"]}\n',
          );
          yield* writeTextFile(path.join(sharedHome, "auth.json"), '{"shared":true}\n');
          yield* writeTextFile(path.join(sharedHome, "auth.lock"), "");
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* writeTextFile(path.join(shadowHome, "auth.lock"), "");
          yield* fileSystem.symlink(
            path.join(sharedHome, "models_cache.json"),
            path.join(shadowHome, "models_cache.json"),
          );

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const sessionsTarget = yield* fileSystem.readLink(path.join(shadowHome, "sessions"));
          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const mcpOauthLocksTarget = yield* fileSystem.readLink(
            path.join(shadowHome, "mcp-oauth-locks"),
          );
          const modelsCacheExists = yield* fileSystem.exists(
            path.join(shadowHome, "models_cache.json"),
          );
          const authLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "auth.json"))
            .pipe(Effect.result);
          const authContents = yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"));
          const authLockLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "auth.lock"))
            .pipe(Effect.result);

          expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(mcpOauthLocksTarget).toBe(path.join(sharedHome, "mcp-oauth-locks"));
          expect(modelsCacheExists).toBe(false);
          expect(authLinkResult._tag).toBe("Failure");
          expect(authContents).toContain("shadow");
          expect(authLockLinkResult._tag).toBe("Failure");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces a Codex-created local sqlite maintenance lock with the shared lock",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedLock = path.join(sharedHome, ".sqlite-maintenance.lock");
          const shadowLock = path.join(shadowHome, ".sqlite-maintenance.lock");

          yield* writeTextFile(sharedLock, "");
          yield* writeTextFile(shadowLock, "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          expect(yield* fileSystem.readLink(shadowLock)).toBe(sharedLock);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces Codex-created local MCP OAuth locks with the shared lock directory",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedLocks = path.join(sharedHome, "mcp-oauth-locks");
          const shadowLocks = path.join(shadowHome, "mcp-oauth-locks");

          yield* writeTextFile(path.join(sharedLocks, "file-store.lock"), "");
          yield* writeTextFile(path.join(shadowLocks, "file-store.lock"), "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const locksTarget = yield* fileSystem.readLink(shadowLocks);
          const sharedLockExists = yield* fileSystem.exists(
            path.join(sharedLocks, "file-store.lock"),
          );

          expect(locksTarget).toBe(sharedLocks);
          expect(sharedLockExists).toBe(true);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "shares local thread writer locks once no writer still holds one",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const shadowLocks = path.join(shadowHome, "thread-writer-locks");
          const threadLock = path.join(shadowLocks, "019a0000-0000-7000-8000-000000000000.lock");

          yield* writeTextFile(path.join(shadowLocks, ".coordination.lock"), "");
          yield* writeTextFile(path.join(shadowLocks, ".DS_Store"), "");
          yield* writeTextFile(threadLock, "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.exists(threadLock)).toBe(true);

          yield* fileSystem.remove(threadLock);
          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.readLink(shadowLocks)).toBe(
            path.join(sharedHome, "thread-writer-locks"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "preserves shadow-local root sqlite databases and open WAL connections during materialization",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* fileSystem.makeDirectory(sharedHome, { recursive: true });
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });

          const sharedDbPath = path.join(sharedHome, "queue.sqlite");
          const shadowDbPath = path.join(shadowHome, "queue.sqlite");
          const unknownShadowDbPath = path.join(shadowHome, "unknown.sqlite");
          const sharedDb = new NodeSqlite.DatabaseSync(sharedDbPath);
          const shadowDb = new NodeSqlite.DatabaseSync(shadowDbPath);
          const unknownShadowDb = new NodeSqlite.DatabaseSync(unknownShadowDbPath);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              sharedDb.close();
              shadowDb.close();
              unknownShadowDb.close();
            }),
          );

          sharedDb.exec("CREATE TABLE entries (value TEXT NOT NULL)");
          sharedDb.exec("INSERT INTO entries (value) VALUES ('shared')");
          shadowDb.exec("PRAGMA journal_mode = WAL");
          shadowDb.exec("CREATE TABLE entries (value TEXT NOT NULL)");
          shadowDb.exec("INSERT INTO entries (value) VALUES ('shadow-before')");
          unknownShadowDb.exec("CREATE TABLE entries (value TEXT NOT NULL)");
          unknownShadowDb.exec("INSERT INTO entries (value) VALUES ('unknown-shadow')");
          yield* writeTextFile(path.join(sharedHome, "queue.sqlite-journal"), "");
          for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            yield* writeTextFile(path.join(sharedHome, `shared-only.sqlite${suffix}`), "shared");
          }
          yield* writeTextFile(path.join(sharedHome, "unknown.sqlite"), "shared-unknown");
          expect(yield* fileSystem.exists(`${sharedDbPath}-wal`)).toBe(false);
          expect(yield* fileSystem.exists(`${shadowDbPath}-wal`)).toBe(true);

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);
          shadowDb.exec("INSERT INTO entries (value) VALUES ('shadow-after-first')");
          yield* materializeCodexShadowHome(layout);
          shadowDb.exec("INSERT INTO entries (value) VALUES ('shadow-after-second')");

          const shadowLink = yield* fileSystem.readLink(shadowDbPath).pipe(Effect.result);
          const sharedWalLink = yield* fileSystem
            .readLink(path.join(shadowHome, "queue.sqlite-wal"))
            .pipe(Effect.result);
          const sharedShmLink = yield* fileSystem
            .readLink(path.join(shadowHome, "queue.sqlite-shm"))
            .pipe(Effect.result);
          const sharedJournalLink = yield* fileSystem
            .readLink(path.join(shadowHome, "queue.sqlite-journal"))
            .pipe(Effect.result);
          const unknownLink = yield* fileSystem.readLink(unknownShadowDbPath).pipe(Effect.result);

          expect(shadowLink._tag).toBe("Failure");
          expect(sharedWalLink._tag).toBe("Failure");
          expect(sharedShmLink._tag).toBe("Failure");
          expect(sharedJournalLink._tag).toBe("Failure");
          expect(unknownLink._tag).toBe("Failure");
          for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            expect(
              yield* fileSystem.exists(path.join(shadowHome, `shared-only.sqlite${suffix}`)),
            ).toBe(false);
          }
          expect(
            shadowDb.prepare("SELECT group_concat(value, ',') AS values_text FROM entries").get(),
          ).toMatchObject({
            values_text: "shadow-before,shadow-after-first,shadow-after-second",
          });
          expect(
            sharedDb.prepare("SELECT group_concat(value, ',') AS values_text FROM entries").get(),
          ).toMatchObject({ values_text: "shared" });
          expect(
            unknownShadowDb
              .prepare("SELECT group_concat(value, ',') AS values_text FROM entries")
              .get(),
          ).toMatchObject({ values_text: "unknown-shadow" });
        }),
    );
    it.effect.skipIf(!symlinksSupported)(
      "accepts Codex-created shadow-local runtime directories",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "log"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "memories"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "tmp"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* fileSystem.makeDirectory(path.join(shadowHome, "log"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "memories"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "tmp"), { recursive: true });

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const logLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "log"))
            .pipe(Effect.result);
          const memoriesLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "memories"))
            .pipe(Effect.result);
          const tmpLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "tmp"))
            .pipe(Effect.result);

          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(logLinkResult._tag).toBe("Failure");
          expect(memoriesLinkResult._tag).toBe("Failure");
          expect(tmpLinkResult._tag).toBe("Failure");
        }),
    );

    it.effect("rejects shadow homes that point at the shared home", () =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: sharedHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CodexShadowHomePathConflictError);
        expect(error).toMatchObject({
          sharedHomePath: sharedHome,
          effectiveHomePath: sharedHome,
        });
        expect(error.message).toBe(
          `Codex shadow home path '${sharedHome}' must be different from the shared home path '${sharedHome}'.`,
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects shared entries that already exist in the shadow home as real files",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "config.toml"), 'model = "local"\n');

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomeEntryConflictError);
          expect(error).toMatchObject({
            sharedHomePath: sharedHome,
            effectiveHomePath: shadowHome,
            entryName: "config.toml",
            linkPath: path.join(shadowHome, "config.toml"),
            targetPath: path.join(sharedHome, "config.toml"),
          });
          expect(error.message).toBe(
            `Cannot create Codex shadow home entry 'config.toml' because '${path.join(shadowHome, "config.toml")}' already exists and is not a symlink.`,
          );
        }),
    );
  });
});
