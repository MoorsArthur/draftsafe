// SPDX-License-Identifier: MIT
import { TOOLS_ID, APPROVAL_PROTOCOL, APPROVAL_HEALTH, APPROVAL_REQUEST, APPROVAL_STATUS } from "../../../shared/lib/ids.js";
import { BridgeError } from "./validate.js";

export const RELAY_TIMEOUT_MS = 11 * 60 * 1000;
export const READY_TIMEOUT_MS = 8_000;
export function createRelay({ api, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = RELAY_TIMEOUT_MS, readyTimeoutMs = READY_TIMEOUT_MS }) {
  const send = async (message, timeout) => {
    let timer;
    try {
      return await Promise.race([
        api.runtime.sendMessage(TOOLS_ID, { v: APPROVAL_PROTOCOL, ...message }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), Math.max(1, timeout)); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const health = async () => {
    try {
      const response = await send({ type: APPROVAL_HEALTH }, 1_000);
      return response?.ok && response.ready === true
        ? { ready: true }
        : { ready: false, code: response?.ok ? "not_ready" : "unavailable" };
    } catch {
      return { ready: false, code: "unavailable" };
    }
  };
  const waitReady = async deadline => {
    const until = Math.min(deadline, now() + readyTimeoutMs);
    let delay = 100;
    for (;;) {
      const state = await health();
      if (state.ready) return;
      if (now() >= until) {
        throw new BridgeError("tools_unavailable", "Draftsafe Tools is not answering health checks. Check that it is enabled and inspect Thunderbird's error console.", 503);
      }
      await sleep(Math.min(delay, Math.max(1, until - now())));
      delay = Math.min(delay * 2, 1_000);
    }
  };
  const relay = async (kind, payload) => {
    const deadline = now() + timeoutMs;
      await waitReady(deadline);
      let response;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Never replay after a transport failure: Tools may have received
          // the request before its response was lost.
          response = await send({ type: APPROVAL_REQUEST, kind, payload }, Math.min(10_000, deadline - now()));
        } catch {
          throw new BridgeError("delivery_unknown", "Could not confirm whether Tools received the request. Check approval history before retrying.", 503);
        }
        if (response?.code !== "not_ready" || attempt === 1) break;
        // This explicit reply says the receiver rejected the request before
        // planning; retrying once cannot create a second approval.
        await waitReady(deadline);
      }
      if (response?.code === "busy") throw new BridgeError("pending_elsewhere", "Another approval is pending in Thunderbird.", 409);
      if (!response?.ok) return { status: "refused", code: response?.code || "tools_unavailable" };
      return { requestId: response.requestId };
  };
  relay.status = async requestId => {
    try {
      const state = await send({ type: APPROVAL_STATUS, requestId }, 5_000);
      if (!state?.ok) throw new BridgeError("approval_interrupted", "Approval is no longer available. Check Thunderbird history.", 503);
      return state;
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      throw new BridgeError("tools_unavailable", "Tools stopped responding while approval was pending. Check approval history.", 503);
    }
  };
  relay.health = health;
  return relay;
}
