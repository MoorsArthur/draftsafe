// SPDX-License-Identifier: MIT
// Sign an already-reviewed release bundle. The private key is supplied only
// through the release operator's environment and is never written here.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBundle } from "./update-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const bundle = await readFile(path.join(root, "dist", `draftsafe-mcp-${pkg.version}.json`));
parseBundle(bundle, pkg.version);
const bundleUrl = process.env.DRAFTSAFE_RELEASE_BUNDLE_URL;
const keyDer = process.env.DRAFTSAFE_RELEASE_PRIVATE_KEY;
if (!bundleUrl || !keyDer || new URL(bundleUrl).protocol !== "https:")
  throw new Error("Set an HTTPS DRAFTSAFE_RELEASE_BUNDLE_URL and DRAFTSAFE_RELEASE_PRIVATE_KEY");
const key = createPrivateKey({ key: Buffer.from(keyDer, "base64"), format: "der", type: "pkcs8" });
if (key.asymmetricKeyType !== "ed25519") throw new Error("Release key must be Ed25519");
const payload = { schema: 1, version: pkg.version, bundleUrl,
  sha256: createHash("sha256").update(bundle).digest("hex") };
const signature = sign(null, Buffer.from(JSON.stringify(payload)), key).toString("base64");
const target = path.join(root, "dist", "update-manifest.json");
await writeFile(target, `${JSON.stringify({ ...payload, signature })}\n`, { mode: 0o600 });
console.log(`Wrote signed update metadata for Draftsafe MCP ${pkg.version} to dist/update-manifest.json`);
