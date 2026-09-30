// SPDX-License-Identifier: MIT
// Start the local approval manager before accepting loopback requests. User
// feature startup may take time; it must not delay read access through MCP.
import { approvals, ready as userFeaturesReady } from "../../tools/src/background.js";
import { configureBridge } from "../../bridge/src/background.js";
import { createLocalRelay } from "./relay.js";

export const ready = configureBridge(createLocalRelay(approvals));
userFeaturesReady.catch(e => console.error("draftsafe: user features failed to start", e));
