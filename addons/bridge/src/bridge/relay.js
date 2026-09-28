// SPDX-License-Identifier: MIT
import { TOOLS_ID, APPROVAL_PROTOCOL, APPROVAL_REQUEST, APPROVAL_STATUS } from "../../../shared/lib/ids.js";
import { BridgeError } from "./validate.js";

export const RELAY_TIMEOUT_MS = 11 * 60 * 1000;
export function createRelay({ api, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = RELAY_TIMEOUT_MS }) {
  let busy = false;
  return async (kind, payload) => {
    if (busy) throw new BridgeError("busy", "An approval request is already pending.");
    busy = true;
    const deadline = now() + timeoutMs;
    const send = async message => {
      let timer;
      try {
        return await Promise.race([
          api.runtime.sendMessage(TOOLS_ID, { v: APPROVAL_PROTOCOL, ...message }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), Math.max(1, deadline - now())); }),
        ]);
      } catch {
        throw new BridgeError("unavailable", "Draftsafe Tools did not answer. Install and enable it in Thunderbird.");
      } finally { clearTimeout(timer); }
    };
    try {
      const response = await send({ type: APPROVAL_REQUEST, kind, payload });
      if (!response?.ok) return { status: "refused", code: response?.code || "unavailable" };
      for (;;) {
        if (now() >= deadline) throw new BridgeError("timeout", "Approval timed out. Check Thunderbird history before retrying.");
        const state = await send({ type: APPROVAL_STATUS, requestId: response.requestId });
        if (!state?.ok) throw new BridgeError("unavailable", "Approval is no longer available. Check Thunderbird history.");
        if (state.status === "done") return state.outcome;
        await sleep(500);
      }
    } finally { busy = false; }
  };
}
