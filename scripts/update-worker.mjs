// SPDX-License-Identifier: MIT
import { safeUpdateError, stageRelease, writeUpdateStatus } from "./update-core.mjs";

const metadataUrl = process.env.DRAFTSAFE_UPDATE_URL;
const publicKeyDer = process.env.DRAFTSAFE_UPDATE_PUBLIC_KEY;
const bundledVersion = process.env.DRAFTSAFE_BUNDLED_VERSION;
if (process.env.DRAFTSAFE_AUTO_UPDATE === "1") {
  let status;
  if (!metadataUrl || !publicKeyDer || !bundledVersion) {
    status = { checkedAt: new Date().toISOString(), status: "failed", code: "configuration_missing" };
  } else {
    try {
      const result = await stageRelease({ metadataUrl, publicKeyDer, bundledVersion });
      status = { checkedAt: new Date().toISOString(), status: result.status,
        ...(result.version ? { version: result.version } : {}) };
    } catch (error) {
      // The current installation stays usable offline or after a bad release.
      status = { checkedAt: new Date().toISOString(), status: "failed", code: safeUpdateError(error) };
    }
  }
  try {
    await writeUpdateStatus(status);
  } catch {
    // The worker never blocks the MCP process or prints release URLs.
  }
}
