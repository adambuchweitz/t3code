import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

const fs = NodeFS;
const path = NodePath;
const { spawn } = NodeChildProcess;
const { setTimeout: delay } = NodeTimersPromises;
const { DatabaseSync, backup } = NodeSqlite;
const { fileURLToPath } = NodeURL;

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
const unifiedInputPath = process.env.T3CODE_FORK_UNIFIED_INPUT;
if (!unifiedInputPath) throw new Error("Unified source metadata is required");
const unifiedInput = JSON.parse(fs.readFileSync(unifiedInputPath, "utf8"));
{
  const source = path.resolve(unifiedInput.sourceDirectory);
  const sourcesRoot = path.join(root, "sources");
  if (
    path.dirname(source).toLowerCase() !== sourcesRoot.toLowerCase() ||
    !/^[a-f0-9]{40,64}$/i.test(unifiedInput.sourceTree) ||
    !/^[a-f0-9]{40,64}$/i.test(unifiedInput.sourceCommit) ||
    !/^[0-9A-Za-z.-]+$/.test(unifiedInput.version)
  )
    throw new Error("Invalid unified source metadata");
  if (!fs.existsSync(path.join(source, "package.json")) || fs.existsSync(path.join(source, ".git")))
    throw new Error("Unified source must be an extracted archive");
  config.repo = source;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.mkdirSync(path.join(root, "logs"), { recursive: true });
const logPath = path.join(root, "logs", `${stamp}.log`);
const log = (message) => {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.appendFileSync(logPath, line);
  process.stdout.write(line);
};
const env = {
  ...process.env,
  ...config.publicBuildEnvironment,
  CI: "true",
  GIT_TERMINAL_PROMPT: "0",
  T3CODE_DISABLE_AUTO_UPDATE: "true",
  T3CODE_PORT: String(config.port),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_HTTP_URL;
delete env.VITE_WS_URL;
const inheritedPathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
const inheritedPath = inheritedPathKey ? env[inheritedPathKey] : "";
if (inheritedPathKey) delete env[inheritedPathKey];
env.Path = [
  config.nodeDirectory,
  path.join(root, "tools", "bin"),
  ...config.buildPaths,
  inheritedPath,
].join(path.delimiter);

function run(command, args, options = {}) {
  log(`Run: ${path.basename(command)} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: config.repo, env, windowsHide: true, ...options });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      fs.appendFileSync(logPath, chunk);
    });
    child.stderr?.on("data", (chunk) => fs.appendFileSync(logPath, chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(`${command} exited ${code ?? signal}; see ${logPath}`)),
    );
  });
}
const powershell = (script) =>
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(
      `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`,
      "utf16le",
    ).toString("base64"),
  ]);
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const node = path.join(config.nodeDirectory, "node.exe");
const vp = (args) => {
  const local = path.join(config.repo, "node_modules", "vite-plus", "bin", "vp");
  return run(node, [
    fs.existsSync(local)
      ? local
      : path.join(root, "tools", "vite", "node_modules", "vite-plus", "bin", "vp"),
    ...args,
  ]);
};
const readJson = (name) =>
  fs.existsSync(path.join(root, name))
    ? JSON.parse(fs.readFileSync(path.join(root, name), "utf8"))
    : null;
const writeJson = (name, data) => {
  const target = path.join(root, name);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${target}.tmp`, target);
};
function asarContains(archive, marker) {
  const fd = fs.openSync(archive, "r");
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);
    const header = Buffer.alloc(prefix.readUInt32LE(12));
    fs.readSync(fd, header, 0, header.length, 16);
    const tree = JSON.parse(header).files.apps.files.server.files.dist.files;
    for (const [name, entry] of Object.entries(tree)) {
      if (!/[.](?:mjs|cjs|js)$/.test(name) || !entry.size) continue;
      const source = Buffer.alloc(entry.size);
      fs.readSync(fd, source, 0, source.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
      if (source.includes(marker)) return true;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}
async function probe(origin) {
  const response = await fetch(`${origin}/api/speech/audio`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Connection test", verbatim: true }),
    signal: AbortSignal.timeout(5000),
  });
  await response.body?.cancel();
  return response.status;
}
async function waitForSpeech(origin, child) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error(`Server exited ${child.exitCode}`);
    try {
      const status = await probe(origin);
      if (status === 401 || status === 403) return status;
    } catch {}
    await delay(1000);
  }
  throw new Error(`Speech endpoint did not become available on ${origin}`);
}
async function smoke(executable, release) {
  const smokeHome = path.join(root, "smoke", stamp);
  fs.mkdirSync(smokeHome, { recursive: true });
  const output = fs.openSync(path.join(smokeHome, "server.log"), "a");
  const child = spawn(
    executable,
    [
      path.join(release, "resources", "server.asar", "apps", "server", "dist", "bin.mjs"),
      "serve",
      "--base-dir",
      smokeHome,
      "--host",
      "127.0.0.1",
      "--port",
      String(config.smokePort),
    ],
    {
      cwd: release,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", output, output],
    },
  );
  fs.closeSync(output);
  log(`Smoke server PID=${child.pid}, isolated home=${smokeHome}`);
  try {
    await waitForSpeech(`http://127.0.0.1:${config.smokePort}`, child);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}
// Some relative dependency symlinks are unreadable in native Windows sessions.
// Repair only broken links whose existing directory target is verifiable.
function repairDependencyLinks() {
  const repaired = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const link = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          fs.statSync(link);
        } catch {
          const target = fs.readlinkSync(link);
          const resolved = path.resolve(directory, target);
          let targetIsDirectory = false;
          try {
            targetIsDirectory = fs.statSync(resolved).isDirectory();
          } catch {}
          if (!targetIsDirectory) continue;
          fs.unlinkSync(link);
          try {
            fs.symlinkSync(resolved, link, "junction");
          } catch (error) {
            fs.symlinkSync(target, link, "dir");
            throw error;
          }
          repaired.push({ link, target, resolved });
        }
      } else if (entry.isDirectory()) walk(link);
    }
  };
  const moduleRoots = [path.join(config.repo, "node_modules")];
  for (const group of ["apps", "infra", "packages"]) {
    const directory = path.join(config.repo, group);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) moduleRoots.push(path.join(directory, entry.name, "node_modules"));
    }
  }
  for (const name of ["evals", "oxlint-plugin-t3code", "scripts"])
    moduleRoots.push(path.join(config.repo, name, "node_modules"));
  for (const modules of moduleRoots) if (fs.existsSync(modules)) walk(modules);
  if (repaired.length) {
    writeJson(`backups/dependency-links-${stamp}.json`, repaired);
    log(`Repaired ${repaired.length} unreadable dependency directory links`);
  }
}
async function build() {
  const sourceTree = unifiedInput.sourceTree;
  const current = readJson("current.json");
  if (current?.sourceTree === sourceTree && !process.argv.includes("--force")) {
    log("Already running this source tree; no rebuild needed.");
    return null;
  }
  const sourceCommit = unifiedInput.sourceCommit;
  const version = unifiedInput.version;
  repairDependencyLinks();
  await vp(["install", "--frozen-lockfile"]);
  repairDependencyLinks();
  const sqliteResults = await vp([
    "test",
    "run",
    "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts",
    "-t",
    "SQLite home",
    "--maxWorkers=2",
  ]);
  const plainSqliteResults = sqliteResults.replace(/\u001b\[[0-9;]*m/g, "");
  if (!/Tests\s+[1-9]\d* passed\b/.test(plainSqliteResults))
    throw new Error("The SQLite home test did not run; refusing deployment.");
  await vp([
    "test",
    "run",
    "packages/contracts/src/threadMetadataMcp.test.ts",
    "apps/web/src/hooks/useClearTheDecks.test.ts",
    "apps/web/src/lib/readAloudMessages.test.ts",
    "packages/provider-core/src/server/textGenerationUtils.test.ts",
    "packages/shared/src/threadLinks.test.ts",
    "apps/server/src/mcp/OrchestratorMcpService.test.ts",
    "apps/server/src/home/HomeService.test.ts",
    "apps/server/src/tots/TotService.test.ts",
    "apps/server/src/tots/TotWakes.test.ts",
    "apps/web/src/components/GitActionsControl.logic.test.ts",
    "apps/server/src/home/FleetBroker.test.ts",
    "apps/server/src/home/FleetService.test.ts",
    "apps/server/src/hooks/HookEvents.test.ts",
    "apps/server/src/readAloud/ReadAloud.test.ts",
    "apps/server/src/review/ReviewService.test.ts",
    "packages/source-control-github/src/server/GitHubPullRequestProvider.test.ts",
    "packages/source-control-github/src/server/gitHubGraphQlClient.test.ts",
    "--maxWorkers=2",
    "--project",
    "root",
    "--project",
    "t3",
    "--project",
    "@t3tools/web (unit)",
  ]);
  await vp([
    "test",
    "run",
    "apps/server/src/orchestration-v2/runtimeLayer.test.ts",
    "-t",
    "holds the queue so no queued run starts|restarts a continuation that failed before its prompt|preserves and holds queued messages",
    "--maxWorkers=2",
    "--project",
    "root",
    "--project",
    "t3",
    "--project",
    "@t3tools/web (unit)",
  ]);
  const output = path.join(root, "artifacts", `${stamp}-${sourceTree.slice(0, 12)}`);
  await vp([
    "run",
    "dist:desktop:artifact",
    "--platform",
    "win",
    "--arch",
    "x64",
    "--target",
    "zip",
    "--build-version",
    version,
    "--output-dir",
    output,
    "--verbose",
  ]);
  const archive = fs.readdirSync(output).find((name) => name.endsWith(".zip"));
  if (!archive) throw new Error("No Windows ZIP was produced.");
  const release = path.join(root, "releases", `${stamp}-${sourceTree.slice(0, 12)}`);
  await powershell(
    `Expand-Archive -LiteralPath ${psQuote(path.join(output, archive))} -DestinationPath ${psQuote(release)}`,
  );
  const executable = fs
    .readdirSync(release)
    .find((name) => name.endsWith(".exe") && name.startsWith("T3 Code"));
  if (!executable) throw new Error("Packaged desktop executable is missing.");
  if (!asarContains(path.join(release, "resources", "server.asar"), "ReadAloud.audio"))
    throw new Error("Packaged server is missing the speech implementation.");
  await smoke(path.join(release, executable), release);
  const candidate = {
    sourceTree,
    sourceCommit,
    version,
    release,
    executable: path.join(release, executable),
    builtAt: new Date().toISOString(),
    logPath,
  };
  writeJson("candidate.json", candidate);
  log(`Build and isolated speech-route smoke check passed: ${release}`);
  return candidate;
}
function activeRunCount() {
  const file = path.join(process.env.USERPROFILE, ".t3", "userdata", "statev2.sqlite");
  if (!fs.existsSync(file))
    throw new Error("Cannot verify agent activity: the live database is missing.");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number(
      db
        .prepare(
          "SELECT count(*) AS count FROM orchestration_v2_projection_runs WHERE status NOT IN ('completed','failed','cancelled','interrupted','rolled_back')",
        )
        .get().count,
    );
  } finally {
    db.close();
  }
}
async function waitForIdle() {
  let quietSince = null;
  let previousCount = null;
  for (;;) {
    const count = activeRunCount();
    if (count !== previousCount) {
      log(`Waiting for idle activation: ${count} active agent runs`);
      previousCount = count;
    }
    if (count) quietSince = null;
    else if (quietSince === null) quietSince = Date.now();
    if (quietSince !== null && Date.now() - quietSince >= 30000) return;
    await delay(5000);
  }
}
async function deploy(candidate) {
  await waitForIdle();
  const previous = readJson("current.json");
  const userData = path.join(process.env.USERPROFILE, ".t3", "userdata");
  const sourceDb = path.join(userData, "statev2.sqlite");
  if (fs.existsSync(sourceDb)) {
    const destination = path.join(root, "backups", stamp);
    fs.mkdirSync(destination, { recursive: true });
    const database = new DatabaseSync(sourceDb, { readOnly: true });
    try {
      // A pinned read snapshot prevents a busy WAL writer from restarting the backup.
      database.exec("BEGIN");
      const pages = database.prepare("PRAGMA page_count").get().page_count;
      await backup(database, path.join(destination, "statev2.sqlite"), { rate: pages });
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
    log(`Read-only database backup saved to ${destination}`);
  }
  if (activeRunCount() !== 0) await waitForIdle();
  await powershell(`
    $listener = Get-NetTCPConnection -LocalPort ${config.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;
    if ($listener) {
      $server = Get-CimInstance Win32_Process -Filter ('ProcessId='+$listener.OwningProcess);
      $app = Get-CimInstance Win32_Process -Filter ('ProcessId='+$server.ParentProcessId);
      if ($server.CommandLine -notmatch 'server.asar' -or $app.ExecutablePath -notin @(${psQuote(config.originalExecutable)}, ${psQuote(previous?.executable ?? "")})) { throw 'Port owner does not match the expected T3 desktop/server pair. Refusing to stop it.' };
      $process = Get-Process -Id $app.ProcessId;
      if (!$process.CloseMainWindow()) { throw 'Could not request a graceful T3 desktop quit. Current application remains installed.' };
      if (!$process.WaitForExit(60000)) { throw 'T3 did not quit within 60 seconds. No processes were force-stopped.' };
    }
  `);
  const output = fs.openSync(path.join(root, "logs", `desktop-${stamp}.log`), "a");
  const desktopEnv = {
    ...process.env,
    ...config.publicBuildEnvironment,
    T3CODE_DISABLE_AUTO_UPDATE: "true",
    T3CODE_PORT: String(config.port),
  };
  for (const key of Object.keys(desktopEnv))
    if (key.toLowerCase() === "path") delete desktopEnv[key];
  desktopEnv.Path = process.env.T3CODE_FORK_ORIGINAL_PATH || inheritedPath;
  for (const key of [
    "CI",
    "GIT_TERMINAL_PROMPT",
    "ELECTRON_RUN_AS_NODE",
    "T3CODE_FORK_ORIGINAL_PATH",
    "INCLUDE",
    "LIB",
    "LIBPATH",
  ])
    delete desktopEnv[key];
  const child = spawn(candidate.executable, [], {
    cwd: candidate.release,
    env: desktopEnv,
    detached: true,
    stdio: ["ignore", output, output],
  });
  fs.closeSync(output);
  child.unref();
  log(`Started custom desktop PID=${child.pid}`);
  try {
    await waitForSpeech(`http://127.0.0.1:${config.port}`, child);
    const owner = await powershell(
      `$listener=Get-NetTCPConnection -LocalPort ${config.port} -State Listen | Select-Object -First 1; (Get-CimInstance Win32_Process -Filter ('ProcessId='+$listener.OwningProcess)).ExecutablePath`,
    );
    if (owner.toLowerCase() !== candidate.executable.toLowerCase())
      throw new Error(`Unexpected production server executable: ${owner}`);
    if (previous) writeJson("previous.json", previous);
    writeJson("current.json", {
      ...candidate,
      desktopPid: child.pid,
      deployedAt: new Date().toISOString(),
    });
    log(
      "Deployment verified: expected executable owns the port and speech route returns an authentication response.",
    );
  } catch (error) {
    writeJson("failed-deployment.json", {
      candidate,
      previous,
      desktopPid: child.pid,
      error: String(error),
      logPath,
    });
    throw error;
  }
}

function cleanup() {
  const protectedReleases = new Set(
    ["current.json", "previous.json", "candidate.json"]
      .map(readJson)
      .filter(Boolean)
      .map((value) => value.release),
  );
  for (const [directory, keep] of [
    ["releases", 3],
    ["artifacts", 2],
    ["backups", 3],
    ["smoke", 3],
  ]) {
    const parent = path.join(root, directory);
    if (!fs.existsSync(parent)) continue;
    const entries = fs
      .readdirSync(parent)
      .filter((name) => fs.statSync(path.join(parent, name)).isDirectory())
      .sort()
      .reverse();
    for (const name of entries.slice(keep)) {
      const target = path.join(parent, name);
      if (!protectedReleases.has(target)) fs.rmSync(target, { recursive: true, force: true });
    }
  }
  for (const name of fs.readdirSync(path.join(root, "logs"))) {
    const target = path.join(root, "logs", name);
    if (fs.statSync(target).isFile() && Date.now() - fs.statSync(target).mtimeMs > 30 * 86400000)
      fs.unlinkSync(target);
  }
}

const lockPath = path.join(root, "update.lock");
let lock;
try {
  if (fs.existsSync(lockPath)) {
    const owner = Number(fs.readFileSync(lockPath, "utf8"));
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
      } catch (error) {
        if (error.code === "ESRCH") fs.unlinkSync(lockPath);
        else throw error;
      }
    }
  }
  lock = fs.openSync(lockPath, "wx");
  fs.writeSync(lock, String(process.pid));
} catch {
  log("Another update is running or left update.lock behind. Refusing an overlapping run.");
  process.exit(1);
}
try {
  log(`Update started; checkout=${config.repo}`);
  const candidate = process.argv.includes("--deploy-only")
    ? readJson("candidate.json")
    : await build();
  if (process.argv.includes("--deploy-only") && !candidate)
    throw new Error("No smoke-tested candidate is available to deploy.");
  if (candidate && candidate.sourceTree !== unifiedInput.sourceTree)
    throw new Error("The prepared candidate does not match the selected source tree.");
  if (candidate && !process.argv.includes("--build-only")) await deploy(candidate);
  cleanup();
  writeJson("last-result.json", {
    success: true,
    finishedAt: new Date().toISOString(),
    logPath,
    current: readJson("current.json"),
    candidate: readJson("candidate.json"),
  });
  log("Update completed successfully.");
} catch (error) {
  log(error.stack ?? String(error));
  writeJson("last-result.json", {
    success: false,
    finishedAt: new Date().toISOString(),
    logPath,
    error: String(error),
  });
  process.exitCode = 1;
} finally {
  fs.closeSync(lock);
  fs.unlinkSync(lockPath);
}
