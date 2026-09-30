// SPDX-License-Identifier: MIT
// Produces an unsigned, reviewable MCP release artifact. Signing and
// publishing are separate release steps.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBundle } from "./update-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(root, "addons/app/manifest.json"), "utf8"));
if (pkg.version !== manifest.version) throw new Error("MCP and XPI versions differ");
const names = ["package.json", "package-lock.json",
  ...(await readdir(path.join(root, "dist"))).filter(name => name.endsWith(".js")).sort().map(name => `dist/${name}`)];
const files = Object.fromEntries(await Promise.all(names.map(async name =>
  [name, (await readFile(path.join(root, name))).toString("base64")])));
const bytes = Buffer.from(JSON.stringify({ schema: 1, version: pkg.version, files }));
parseBundle(bytes, pkg.version);
const target = path.join(root, "dist", `draftsafe-mcp-${pkg.version}.json`);
await writeFile(target, bytes);
console.log(JSON.stringify({ artifact: target, sha256: createHash("sha256").update(bytes).digest("hex") }));
