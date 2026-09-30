// SPDX-License-Identifier: MIT
// The agent-facing bridge may request a plan or read its status. The approval
// manager never exposes a decision method here; only its own trusted click
// handler can execute a plan.
import { BridgeError } from "../../shared/lib/validate.js";

export function createLocalRelay(approvals) {
  const relay = async (kind, payload) => {
    const response = await approvals.request(kind, payload);
    if (response?.code === "busy") {
      throw new BridgeError("pending_elsewhere", "Another approval is pending in Thunderbird.", 409);
    }
    if (!response?.ok) return { status: "refused", code: response?.code || "not_ready" };
    return { requestId: response.requestId };
  };
  relay.status = async requestId => {
    const response = approvals.status(requestId);
    if (!response?.ok) {
      throw new BridgeError("approval_interrupted", "Approval is no longer available. Check Thunderbird history.", 503);
    }
    return response;
  };
  relay.health = async () => ({ ready: true });
  return relay;
}
