// SPDX-License-Identifier: MIT
// Loopback bridge with a fixed read/request route table. Mailbox changes
// are relayed to Tools for trusted-click approval. No send/move/delete permission.

import { createMailOps } from "./bridge/ops.js";
import { createRoutes } from "./bridge/routes.js";
import { createRequestHandler } from "./bridge/server.js";
import { generateToken } from "./bridge/security.js";
import { createRelay } from "./bridge/relay.js";

const api = globalThis.messenger;
const version = api.runtime.getManifest().version;

let secrets = null;
let retryDelay = 1_000;
const handleRequest = createRequestHandler({
  getSecrets: () => secrets,
  routes: createRoutes({ ops: createMailOps({ api }), version, relay: createRelay({ api }) }),
});
api.draftsafeBridge.onRequest.addListener(req => handleRequest(req));

export async function startBridge() {
  try {
    const token = generateToken();
    const { port } = await api.draftsafeBridge.start();
    const { path } = await api.draftsafeBridge.publishConnection(token);
    secrets = { port, token };
    retryDelay = 1_000;
    console.info(`draftsafe: bridge listening on 127.0.0.1:${port}, connection file ${path}`);
  } catch (e) {
    secrets = null;
    console.error(`draftsafe: bridge failed to start: ${e && e.message}`);
    // A profile or snap path can be temporarily unavailable during startup.
    // Keep trying on this persistent page; start() is idempotent after binding.
    setTimeout(() => { startBridge(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60_000);
  }
}

export const ready = startBridge();
