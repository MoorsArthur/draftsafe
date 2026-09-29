// SPDX-License-Identifier: MIT
// Extension ids of the two add-ons. The only cross-extension message in
// Draftsafe is draftsafe-bridge asking draftsafe-tools to SHOW an approval
// window; draftsafe-tools accepts it from this exact sender id only, and only
// a click in that window can make anything happen.

import "./ids-global.js";

export const BRIDGE_ID = globalThis.draftsafeIds.bridge;
export const TOOLS_ID = globalThis.draftsafeIds.tools;

// Message types of that one channel (bridge -> tools).
export const APPROVAL_REQUEST = "draftsafe.approval.request";
export const APPROVAL_STATUS = "draftsafe.approval.status";
export const APPROVAL_HEALTH = "draftsafe.approval.health";
export const APPROVAL_PROTOCOL = 1;
