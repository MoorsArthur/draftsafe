// SPDX-License-Identifier: MIT
// Sign an already-reviewed release bundle. The private key is supplied only
// through the release operator's environment and is never written here.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBundle } from "./update-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const bundle = await readFile(path.join(root, "dist", `draftsafe-mcp-${pkg.version}.json`));
parseBundle(bundle, pkg.version);
const bundleUrl = process.env.DRAFTSAFE_RELEASE_BUNDLE_URL;
let keyDer = process.env.DRAFTSAFE_RELEASE_PRIVATE_KEY;
if (process.env.DRAFTSAFE_RELEASE_KEY_FILE) {
  if (keyDer) throw new Error("Supply the release key through one method only");
  const file = path.resolve(process.env.DRAFTSAFE_RELEASE_KEY_FILE);
  const secretDir = path.join(os.homedir(), ".config", "secrets");
  if (path.dirname(file) !== secretDir || !/^draftsafe-release-[0-9]+\.[0-9]+\.[0-9]+\.env$/.test(path.basename(file)))
    throw new Error("Release key file must be a versioned file in ~/.config/secrets");
  const info = await lstat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error("Release key file must be a private regular file");
  const match = /^DRAFTSAFE_RELEASE_PRIVATE_KEY=([A-Za-z0-9+/=]+)\n?$/.exec(await readFile(file, "utf8"));
  if (!match) throw new Error("Release key file has an unexpected format");
  keyDer = match[1];
}
if (!bundleUrl || !keyDer || new URL(bundleUrl).protocol !== "https:")
  throw new Error("Set an HTTPS bundle URL and a release key file or private key environment variable");
const key = createPrivateKey({ key: Buffer.from(keyDer, "base64"), format: "der", type: "pkcs8" });
if (key.asymmetricKeyType !== "ed25519") throw new Error("Release key must be Ed25519");
const payload = { schema: 1, version: pkg.version, bundleUrl,
  sha256: createHash("sha256").update(bundle).digest("hex") };
const signature = sign(null, Buffer.from(JSON.stringify(payload)), key).toString("base64");
const target = path.join(root, "dist", "update-manifest.json");
await writeFile(target, `${JSON.stringify({ ...payload, signature })}\n`, { mode: 0o600 });
console.log(`Wrote signed update metadata for Draftsafe MCP ${pkg.version} to dist/update-manifest.json`);
