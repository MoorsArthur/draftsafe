// SPDX-License-Identifier: MIT
// Keep the stdio MCP server's advertised version equal to the package/XPI.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("package version must be semver");
writeFileSync(join(root, "mcp/src/version.ts"), `// Generated from package.json by scripts/sync-version.mjs.\nexport const PACKAGE_VERSION = ${JSON.stringify(version)};\n`);
