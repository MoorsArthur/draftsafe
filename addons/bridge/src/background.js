// SPDX-License-Identifier: MIT
// draftsafe-bridge background page: starts the loopback bridge and serves the
// fixed route table. This add-on has no user interface, no alarms and no
// messaging with other extensions. Its manifest holds no permission to send,
// move or delete mail, so neither this code nor anything that compromised it
// could do so through the MailExtension APIs.

import { createMailOps } from "./bridge/ops.js";
import { createRoutes } from "./bridge/routes.js";
import { createRequestHandler } from "./bridge/server.js";
import { generateToken } from "./bridge/security.js";

const api = globalThis.messenger;
const version = api.runtime.getManifest().version;

let secrets = null;
const handleRequest = createRequestHandler({
  getSecrets: () => secrets,
  routes: createRoutes({ ops: createMailOps({ api }), version }),
});
api.draftsafeBridge.onRequest.addListener(req => handleRequest(req));

export async function startBridge() {
  try {
    const token = generateToken();
    const { port } = await api.draftsafeBridge.start();
    secrets = { port, token };
    const { path } = await api.draftsafeBridge.publishConnection(token);
    console.info(`draftsafe: bridge listening on 127.0.0.1:${port}, connection file ${path}`);
  } catch (e) {
    secrets = null;
    console.error(`draftsafe: bridge failed to start: ${e && e.message}`);
  }
}

export const ready = startBridge();
