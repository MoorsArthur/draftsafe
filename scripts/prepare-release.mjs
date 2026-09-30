// SPDX-License-Identifier: MIT
// Local release gate. Never signs, uploads or publishes artifacts.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!path.isAbsolute(process.env.THUNDERBIRD || ""))
  throw new Error("Set THUNDERBIRD to an absolute standalone Thunderbird binary for isolated smoke");
for (const args of [["test"], ["run", "build"], ["run", "smoke"], ["run", "build:update"], ["run", "build:thunderbird-update"]]) {
  const result = spawnSync("npm", args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Release gate failed: npm ${args.join(" ")}`);
}
const report = JSON.parse(readFileSync(path.join(root, "dist", "smoke-report.json"), "utf8"));
if (!Array.isArray(report.results) || report.results.length < 50 || report.results.some(result => !result.ok))
  throw new Error("Isolated Thunderbird smoke report is incomplete or failed");
console.log(`Release candidate staged after ${report.results.length} isolated Thunderbird checks.`);
