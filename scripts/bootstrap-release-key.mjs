#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// One-time local release key setup. The private key never enters the repository.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBundle, verifyMetadata } from "./update-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const bundle = await readFile(path.join(root, "dist", `draftsafe-mcp-${pkg.version}.json`));
parseBundle(bundle, pkg.version);
const bundleUrl = `https://github.com/MoorsArthur/draftsafe/releases/download/v${pkg.version}/draftsafe-mcp-${pkg.version}.json`;
const secretsDir = path.join(os.homedir(), ".config", "secrets");
const secretPath = path.join(secretsDir, `draftsafe-release-${pkg.version}.env`);
const publicPath = path.join(root, "updates", "public-key.txt");
const replacingPublicKey = process.env.DRAFTSAFE_REKEY === "1";
const secretDir = await stat(secretsDir);
if (!secretDir.isDirectory() || (secretDir.mode & 0o077) !== 0)
  throw new Error("Release secret directory must be private");
for (const target of [secretPath, ...(replacingPublicKey ? [] : [publicPath])]) {
  if (await stat(target).then(() => true, error => error?.code === "ENOENT" ? false : Promise.reject(error)))
    throw new Error("Release key already exists; refusing to replace it");
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicDer = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const privateDer = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const payload = { schema: 1, version: pkg.version, bundleUrl,
  sha256: createHash("sha256").update(bundle).digest("hex") };
const metadata = { ...payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString("base64") };
verifyMetadata(metadata, publicDer);

await mkdir(path.dirname(publicPath), { recursive: true });
await writeFile(secretPath, `DRAFTSAFE_RELEASE_PRIVATE_KEY=${privateDer}\n`, { flag: "wx", mode: 0o600 });
await writeFile(publicPath, `${publicDer}\n`, { flag: replacingPublicKey ? "w" : "wx", mode: 0o644 });
await writeFile(path.join(root, "dist", "update-manifest.json"), `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
console.log(`Created local signing key, public key and signed metadata for Draftsafe ${pkg.version}.`);
