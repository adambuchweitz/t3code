#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - This is a host-side build and install script.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { loadFleetBuildEnv } from "./lib/public-config.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const buildEnv = process.env.T3CODE_BUILD_COMMIT?.trim()
  ? loadFleetBuildEnv({ repoRoot })
  : process.env;
// Outside ~/Applications, which AppImageLauncher watches and would list a second time.
const installDirectory = NodePath.join(NodeOS.homedir(), ".local", "opt", "t3code");
const appImagePath = NodePath.join(installDirectory, "T3-Code-local.AppImage");
const legacyAppImagePath = NodePath.join(
  NodeOS.homedir(),
  "Applications",
  "T3-Code-local.AppImage",
);
const xdgDataHome =
  process.env.XDG_DATA_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".local", "share");
const desktopEntryPath = NodePath.join(xdgDataHome, "applications", "t3-code-local.desktop");
const iconInstallPath = NodePath.join(
  xdgDataHome,
  "icons",
  "hicolor",
  "256x256",
  "apps",
  "com.t3tools.t3code.png",
);
// The deploy build uses the nightly tag, so it stages the nightly brand icon.
const iconSourcePath = NodePath.join(repoRoot, "assets", "nightly", "nightly-universal-1024.png");

const run = async (command: string, args: readonly string[]) => {
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: repoRoot,
      env: buildEnv,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? `code ${code}`}.`));
    });
  });
};

const currentNightlyVersion = async () => {
  const configured = process.env.T3CODE_BUILD_VERSION?.trim();
  if (configured) {
    if (!/^[0-9A-Za-z.-]+$/.test(configured)) {
      throw new Error("Invalid T3CODE_BUILD_VERSION.");
    }
    return configured;
  }
  const { stdout } = await execFile(
    "git",
    ["describe", "--tags", "--match", "v*-nightly.*", "--abbrev=0"],
    { cwd: repoRoot },
  );
  const tag = stdout.trim();
  if (!tag.startsWith("v")) {
    throw new Error(`Expected a Nightly version tag, received "${tag}".`);
  }
  return tag.slice(1);
};

const desktopEntry = `[Desktop Entry]
Type=Application
Name=T3 Code (local build)
Comment=Local build of T3 Code Nightly
Exec=/usr/bin/env -u ELECTRON_RUN_AS_NODE ${appImagePath}
Terminal=false
Categories=Development;
Icon=com.t3tools.t3code
StartupWMClass=t3code
`;

// AppImageLauncher names its entries and icons after the MD5 of the AppImage's file URI.
const removeLegacyInstall = async () => {
  await NodeFSP.rm(legacyAppImagePath, { force: true });
  const integrationId = `appimagekit_${NodeCrypto.createHash("md5")
    .update(`file://${legacyAppImagePath}`)
    .digest("hex")}`;
  const applicationsDirectory = NodePath.join(xdgDataHome, "applications");
  const entries = await NodeFSP.readdir(applicationsDirectory).catch(() => []);
  await Promise.all(
    entries
      .filter((name) => name.startsWith(`${integrationId}-`))
      .map((name) => NodeFSP.rm(NodePath.join(applicationsDirectory, name), { force: true })),
  );
  const icons = await NodeFSP.readdir(NodePath.join(xdgDataHome, "icons"), {
    recursive: true,
  }).catch(() => []);
  await Promise.all(
    icons
      .filter((path) => NodePath.basename(path).startsWith(`${integrationId}_`))
      .map((path) => NodeFSP.rm(NodePath.join(xdgDataHome, "icons", path), { force: true })),
  );
};

const main = async () => {
  const version = await currentNightlyVersion();
  const artifactDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3code-linux-deploy-"),
  );

  try {
    await run("vp", [
      "run",
      "dist:desktop:linux",
      "--build-version",
      version,
      "--output-dir",
      artifactDirectory,
    ]);

    const artifactName = (await NodeFSP.readdir(artifactDirectory)).find((name) =>
      name.endsWith(".AppImage"),
    );
    if (!artifactName) {
      throw new Error(`No AppImage was produced in ${artifactDirectory}.`);
    }

    await NodeFSP.mkdir(installDirectory, { recursive: true });
    const temporaryAppImagePath = NodePath.join(
      installDirectory,
      `.T3-Code-local.${process.pid}.AppImage`,
    );
    await NodeFSP.copyFile(NodePath.join(artifactDirectory, artifactName), temporaryAppImagePath);
    await NodeFSP.chmod(temporaryAppImagePath, 0o755);

    await NodeFSP.mkdir(NodePath.dirname(iconInstallPath), { recursive: true });
    await execFile("magick", [iconSourcePath, "-resize", "256x256", iconInstallPath], {
      cwd: repoRoot,
    });

    await NodeFSP.mkdir(NodePath.dirname(desktopEntryPath), { recursive: true });
    await NodeFSP.writeFile(desktopEntryPath, desktopEntry, "utf8");
    await removeLegacyInstall();
    await NodeFSP.rename(temporaryAppImagePath, appImagePath);

    console.log(`Installed ${version} at ${appImagePath}`);
    console.log(`Open “T3 Code (local build)” from your app launcher after closing T3 Code.`);
  } finally {
    await NodeFSP.rm(artifactDirectory, { recursive: true, force: true });
  }
};

await main();
