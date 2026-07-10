import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modes = new Set(["standalone", "export"]);
const mode = process.argv[2];

if (!modes.has(mode)) {
  console.error("Usage: node scripts/build.mjs <standalone|export>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const tsxBin = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const apiDir = path.join(root, "app", "api");
const exportApiBackup = path.join(root, ".nextchat-export-api");

class CommandError extends Error {
  constructor(exitCode) {
    super(`Command failed with exit code ${exitCode}`);
    this.exitCode = exitCode;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new CommandError(result.status ?? 1);
}

function readGit(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });

  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function recoverApiDirectory() {
  if (!existsSync(apiDir) && existsSync(exportApiBackup)) {
    renameSync(exportApiBackup, apiDir);
  }
}

function isolateApiDirectory() {
  recoverApiDirectory();
  if (existsSync(exportApiBackup)) {
    throw new Error(`Export API backup already exists: ${exportApiBackup}`);
  }
  renameSync(apiDir, exportApiBackup);
}

function restoreApiDirectory() {
  if (!existsSync(apiDir) && existsSync(exportApiBackup)) {
    renameSync(exportApiBackup, apiDir);
  }
}

recoverApiDirectory();

const env = {
  ...process.env,
  BUILD_MODE: mode,
  BUILD_APP: mode === "export" ? "1" : "",
  BUILD_COMMIT_DATE: readGit(["log", "-1", "--format=%at000"]),
  BUILD_COMMIT_HASH: readGit(["log", "-1", "--format=%H"]),
};
const builderFlag = mode === "export" ? "--webpack" : "--turbopack";

try {
  run(process.execPath, [tsxBin, "app/masks/build.ts"]);
  if (mode === "export") isolateApiDirectory();
  run(process.execPath, [nextBin, "build", builderFlag], { env });
} catch (error) {
  if (!(error instanceof CommandError)) console.error(error);
  process.exitCode = error instanceof CommandError ? error.exitCode : 1;
} finally {
  restoreApiDirectory();
}
