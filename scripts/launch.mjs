#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Stable MCP entry point. The updater cannot read the bridge connection.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newer, readActive, readUpdateStatus, rollback, DATA_DIR } from "./update-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (process.argv[2] === "--rollback") {
  writeSync(1, `Restored Draftsafe MCP ${await rollback()}\n`);
  process.exit(0);
}
if (process.argv[2] === "--update-status") {
  writeSync(1, `${JSON.stringify((await readUpdateStatus()) ?? { status: "never_checked" })}\n`);
  process.exit(0);
}

let entry = path.join(root, "dist", "index.js");
try {
  const active = await readActive();
  if (active && newer(active, pkg.version)) {
    const candidate = path.join(DATA_DIR, "versions", active, "dist", "index.js");
    if ((await stat(candidate)).isFile()) entry = candidate;
  }
} catch (error) {
  console.error(`Draftsafe update fallback: ${error.message}`);
}

if (process.env.DRAFTSAFE_AUTO_UPDATE === "1") {
  const pinnedKey = process.env.DRAFTSAFE_UPDATE_PUBLIC_KEY ||
    await readFile(path.join(root, "updates", "public-key.txt"), "utf8").then(value => value.trim(), () => "");
  const env = {
    HOME: os.homedir(), PATH: process.env.PATH || "/usr/bin:/bin",
    XDG_DATA_HOME: process.env.XDG_DATA_HOME || "",
    DRAFTSAFE_AUTO_UPDATE: "1",
    DRAFTSAFE_UPDATE_URL: process.env.DRAFTSAFE_UPDATE_URL ||
      "https://github.com/MoorsArthur/draftsafe/releases/latest/download/update-manifest.json",
    DRAFTSAFE_UPDATE_PUBLIC_KEY: pinnedKey,
    DRAFTSAFE_BUNDLED_VERSION: pkg.version,
  };
  const updater = spawn(process.execPath, [path.join(root, "scripts", "update-worker.mjs")],
    { detached: true, stdio: "ignore", env });
  updater.on("error", error => console.error(`Draftsafe update check could not start: ${error.message}`));
  updater.unref();
}

const child = spawn(process.execPath, [entry], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(`Draftsafe MCP failed to start: ${error.message}`); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
