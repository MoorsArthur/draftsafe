// SPDX-License-Identifier: MIT
import { createRoutes } from "./mail-routes.js";
import { ApprovalInputError } from "./approval-schema.js";

export const STATE_ROUTES = Object.freeze(["messages.setTags", "messages.markRead", "followups.set", "drafts.create"]);
// Run the existing strict validators without invoking a mailbox API.
export async function validateStateRequest(payload) {
  if (!payload || !STATE_ROUTES.includes(payload.route) || Object.keys(payload).some(k => !["route", "params"].includes(k))) {
    throw new ApprovalInputError("Invalid state request");
  }
  const ops = { setTags() {}, markRead() {}, setFollowup() {}, createDraft() {} };
  await createRoutes({ ops, version: "validation" })[payload.route](payload.params);
  return structuredClone(payload);
}
