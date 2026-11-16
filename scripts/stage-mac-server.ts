import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { stageRuntimeExternals } from "./build-cli-archive.ts";

const Manifest = Schema.Struct({
  version: Schema.String,
  dependencies: Schema.Record(Schema.String, Schema.String),
});
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(Manifest));

export const stageMacServer = Effect.fn("stageMacServer")(function* (input: {
  readonly sourceDir: string;
  readonly destinationDir: string;
  readonly protocol: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fs.realPath(input.sourceDir);
  const destination = path.resolve(input.destinationDir);
  if (source === destination || destination.startsWith(source + path.sep)) {
    return yield* Effect.die(new Error("Runtime destination must be outside the build workspace."));
  }
  if ((yield* fs.exists(destination)) && (yield* fs.readDirectory(destination)).length > 0) {
    return yield* Effect.die(new Error("Runtime destination must be empty."));
  }
  const server = yield* decodeManifest(
    yield* fs.readFileString(path.join(source, "apps/server/package.json")),
  );
  yield* fs.makeDirectory(path.join(destination, "apps/server"), { recursive: true });
  yield* fs.copy(path.join(source, "apps/server/dist"), path.join(destination, "apps/server/dist"));
  yield* fs.copyFile(
    path.join(source, "apps/server/package.json"),
    path.join(destination, "apps/server/package.json"),
  );
  yield* stageRuntimeExternals({
    repoRoot: source,
    stageDir: destination,
    platform: "mac",
    arch: "x64",
    version: server.version,
  });
  for (const name of ["BUILD_REVISION", "BUILD_TREE", "UPSTREAM_REVISION"]) {
    yield* fs.copyFile(path.join(source, name), path.join(destination, name));
  }
  yield* fs.writeFileString(
    path.join(destination, "ORCHESTRATION_PROTOCOL"),
    `${input.protocol}\n`,
  );
  yield* fs.makeDirectory(path.join(destination, "scripts"), { recursive: true });
  const scripts = yield* path.fromFileUrl(new URL(".", import.meta.url));
  for (const name of ["deploy-mac-server.sh", "deploy-mac-storage.py", "wait-for-t3-idle.py"]) {
    yield* fs.copyFile(path.join(scripts, name), path.join(destination, "scripts", name));
  }
  yield* fs.writeFileString(path.join(destination, "PRODUCTION_RUNTIME"), "1\n");
});

const command = Command.make(
  "stage-mac-server",
  {
    sourceDir: Flag.String("source-dir"),
    destinationDir: Flag.String("destination-dir"),
    protocol: Flag.Int("protocol"),
  },
  (input) => stageMacServer(input).pipe(Effect.scoped),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
    NodeRuntime.runMain,
  );
}
