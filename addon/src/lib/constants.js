// SPDX-License-Identifier: MIT

export const SNOOZE_FOLDER_NAME = "Snoozed";

export const FOLLOWUP_TAG_KEY = "draftsafe_followup";
export const FOLLOWUP_TAG_LABEL = "Follow up";
export const FOLLOWUP_TAG_COLOR = "#d97706";

export const STORAGE_KEYS = Object.freeze({
  snoozes: "snoozes",
  followups: "followups",
  sendLater: "sendLater",
});

export const TICK_ALARM = "draftsafe-tick";

// A scheduled send that is more than this late (Thunderbird was closed) is not
// sent automatically; the user gets a notification and the draft stays put.
export const SEND_LATER_GRACE_MS = 12 * 60 * 60 * 1000;
