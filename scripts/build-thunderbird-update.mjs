// SPDX-License-Identifier: MIT
// Build the self-hosted Thunderbird update manifest from the exact XPI bytes.
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(root, "addons", "app", "manifest.json"), "utf8"));
const id = manifest.browser_specific_settings?.gecko?.id;
const updateUrl = "https://raw.githubusercontent.com/MoorsArthur/draftsafe-updates/main/thunderbird-updates.json";
if (manifest.version !== pkg.version || id !== "draftsafe-tools@armain.be" ||
    manifest.browser_specific_settings.gecko.update_url !== updateUrl)
  throw new Error("Thunderbird version, ID or update URL differs from the release contract");
const versionedName = `draftsafe-${pkg.version}.xpi`;
const xpi = await readFile(path.join(dist, "draftsafe.xpi"));
const digest = createHash("sha256").update(xpi).digest("hex");
await copyFile(path.join(dist, "draftsafe.xpi"), path.join(dist, versionedName));
const updates = { addons: { [id]: { updates: [{
  version: pkg.version,
  update_link: `https://github.com/MoorsArthur/draftsafe-updates/releases/download/v${pkg.version}/${versionedName}`,
  update_hash: `sha256:${digest}`,
  applications: { gecko: { strict_min_version: manifest.browser_specific_settings.gecko.strict_min_version } },
}] } } };
await writeFile(path.join(dist, "thunderbird-updates.json"), `${JSON.stringify(updates, null, 2)}\n`);
console.log(`Built Thunderbird ${pkg.version} update manifest and ${versionedName} (sha256 ${digest})`);
