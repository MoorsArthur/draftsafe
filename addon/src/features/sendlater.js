// SPDX-License-Identifier: MIT
// Send later. USER FEATURE ONLY.
//
// This is the only module in the add-on that sends mail. It is imported by
// background.js for the compose-action popup and the alarm tick, and must
// never be imported by anything under src/bridge/ (a test enforces this).
// Scheduling requires an explicit click in the compose window's popup.

import { SEND_LATER_GRACE_MS, STORAGE_KEYS } from "../lib/constants.js";
import { recordKey } from "../lib/store.js";
import { findInFolder, findSpecialFolder } from "../lib/mail.js";

const KEY = STORAGE_KEYS.sendLater;
const MIN_LEAD_MS = 30 * 1000;

export function createSendLater({ api, store, notify = () => {}, now = () => new Date() }) {
  const inFlight = new Set();
  let processing = null;

  async function schedule(tabId, sendAt) {
    const when = sendAt instanceof Date ? sendAt : new Date(sendAt);
    if (Number.isNaN(when.getTime()) || when.getTime() < now().getTime() + MIN_LEAD_MS) {
      throw new Error("pick a time at least 30 seconds from now");
    }
    const details = await api.compose.getComposeDetails(tabId);
    const recipients = [details.to, details.cc, details.bcc].flat().filter(Boolean);
    if (!recipients.length) {
      throw new Error("add at least one recipient first");
    }
    const saved = await api.compose.saveMessage(tabId, { mode: "draft" });
    const draft = saved && saved.messages && saved.messages[0];
    if (!draft || !draft.folder) {
      throw new Error("the draft could not be saved");
    }
    const key = recordKey(draft.folder.accountId, draft.headerMessageId);
    const record = {
      key,
      accountId: draft.folder.accountId,
      headerMessageId: draft.headerMessageId,
      draftFolderId: draft.folder.id,
      identityId: details.identityId || null,
      subject: details.subject || "",
      to: [details.to].flat().filter(Boolean).map(String),
      sendAt: when.toISOString(),
      status: "scheduled",
      createdAt: now().toISOString(),
    };
    await store.put(KEY, key, record);
    await api.tabs.remove(tabId);
    return record;
  }

  async function cancel(key) {
    if (inFlight.has(key)) {
      throw new Error("this message is being sent right now");
    }
    return store.remove(KEY, key);
  }

  async function list() {
    const all = await store.list(KEY);
    return all.sort((a, b) => new Date(a.sendAt) - new Date(b.sendAt));
  }

  async function setStatus(key, status, extra = {}) {
    await store.update(KEY, map => {
      if (map[key]) {
        Object.assign(map[key], { status, ...extra });
      }
    });
  }

  async function sendOne(record) {
    inFlight.add(record.key);
    try {
      // Persist "sending" first: if Thunderbird dies mid-send we never retry
      // automatically (that could double-send); the user is told instead.
      await setStatus(record.key, "sending");
      const draft = await findInFolder(api, record.draftFolderId, record.headerMessageId);
      if (!draft) {
        await setStatus(record.key, "failed", { error: "draft not found in Drafts" });
        notify("Send later failed", `Draft "${record.subject}" was not found. Nothing was sent.`);
        return;
      }
      // beginNew() on a draft opens it as "edit as new"; the original draft
      // stays in Drafts and is moved to Trash after a successful send.
      const tab = await api.compose.beginNew(draft.id, record.identityId ? { identityId: record.identityId } : {});
      try {
        await api.compose.sendMessage(tab.id, { mode: "sendNow" });
      } catch (e) {
        await setStatus(record.key, "failed", { error: String((e && e.message) || e) });
        notify("Send later failed", `"${record.subject}" was not sent. The compose window is left open.`);
        return;
      }
      await store.remove(KEY, record.key);
      const trash = await findSpecialFolder(api, record.accountId, "trash");
      if (trash) {
        try {
          await api.messages.move([draft.id], trash.id);
        } catch (e) {
          console.warn("draftsafe: could not move sent draft to Trash", e);
        }
      }
      notify("Sent", `"${record.subject}" was sent as scheduled.`);
    } finally {
      inFlight.delete(record.key);
    }
  }

  async function processDue() {
    if (processing) {
      return processing;
    }
    processing = (async () => {
      const t = now().getTime();
      for (const record of await store.list(KEY)) {
        if (inFlight.has(record.key)) {
          continue;
        }
        if (record.status === "sending") {
          // Left over from a crash or restart mid-send: never resend blindly.
          await setStatus(record.key, "unknown");
          notify(
            "Send later: check your Sent folder",
            `Thunderbird stopped while sending "${record.subject}". It was not retried.`
          );
          continue;
        }
        if (record.status !== "scheduled" || new Date(record.sendAt).getTime() > t) {
          continue;
        }
        if (t - new Date(record.sendAt).getTime() > SEND_LATER_GRACE_MS) {
          await setStatus(record.key, "missed");
          notify("Send later missed", `"${record.subject}" was due while Thunderbird was closed. It is still in Drafts.`);
          continue;
        }
        try {
          await sendOne(record);
        } catch (e) {
          console.error("draftsafe: send later failed", e);
          await setStatus(record.key, "failed", { error: String((e && e.message) || e) });
        }
      }
    })();
    try {
      return await processing;
    } finally {
      processing = null;
    }
  }

  return { schedule, cancel, list, processDue };
}
