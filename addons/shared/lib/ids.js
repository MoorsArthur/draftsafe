// SPDX-License-Identifier: MIT
// Extension ids of the two add-ons. The only cross-extension message in
// Draftsafe is draftsafe-bridge asking draftsafe-tools to SHOW an approval
// window; draftsafe-tools accepts it from this exact sender id only, and only
// a click in that window can make anything happen.

export const BRIDGE_ID = "draftsafe-bridge@draftsafe.dev";
export const TOOLS_ID = "draftsafe-tools@draftsafe.dev";

// Message types of that one channel (bridge -> tools).
export const APPROVAL_REQUEST = "draftsafe.approval.request";
export const APPROVAL_STATUS = "draftsafe.approval.status";
export const APPROVAL_HEALTH = "draftsafe.approval.health";
export const APPROVAL_PROTOCOL = 1;
