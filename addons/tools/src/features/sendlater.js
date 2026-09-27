// SPDX-License-Identifier: MIT
// Send later (user feature, draftsafe-tools only).
//
// draftsafe-tools has no bridge, no Experiment API and no network listener:
// the only way to schedule a send is the compose-window popup of this add-on.
//
// Integrity: a schedule is bound to the draft the user approved: its
// Message-ID, its Drafts folder, its recipients and subject, and a SHA-256
// fingerprint of its content (see lib/fingerprint.js). Before sending, the
// draft must be the only message with that Message-ID in that verified Drafts
// folder, its fingerprint must match, and the reopened compose window must
// show the same recipients and subject. Any mismatch fails closed: nothing is
// sent and the user is notified.
//
// State machine (every transition runs inside one serialized store.update, so
// claim and cancel can never interleave):
//
//   scheduled --claim (due)--> sending --sent--> (record removed)
//       |                          |----------> failed
//       |--cancel--> (removed)     `--restart--> unknown   (never retried)
//       |--too late--> missed
//   malformed record --> invalid   (never sent)
//
// cancel() succeeds only from scheduled (or a terminal state, which just
// dismisses the record) and refuses while sending. A claimed record cannot be
// cancelled, and a cancelled record cannot be claimed.

import { SEND_LATER_GRACE_MS, STORAGE_KEYS } from "../lib/constants.js";
import { recordKey } from "../lib/store.js";
import { findAllInFolder, findSpecialFolder } from "../lib/folders.js";
import { fingerprintMessage } from "../lib/fingerprint.js";

const KEY = STORAGE_KEYS.sendLater;
const MIN_LEAD_MS = 30 * 1000;
export const STATUSES = Object.freeze(["scheduled", "sending", "failed", "missed", "unknown", "invalid"]);
const TERMINAL = ["failed", "missed", "unknown", "invalid"];

function addressList(v) {
  return [v]
    .flat()
    .filter(x => x !== undefined && x !== null && x !== "")
    .map(x => (typeof x === "string" ? x.trim() : JSON.stringify(x)))
    .sort();
}

function sameList(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

const isStringList = v => Array.isArray(v) && v.length <= 500 && v.every(x => typeof x === "string");
const finiteTime = v => typeof v === "string" && Number.isFinite(new Date(v).getTime());

/** Strict shape check for a persisted record. Anything else is never sent. */
export function isValidRecord(r, mapKey) {
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.accountId === "string" &&
    typeof r.headerMessageId === "string" &&
    r.headerMessageId.length > 0 &&
    typeof r.draftFolderId === "string" &&
    r.key === mapKey &&
    r.key === recordKey(r.accountId, r.headerMessageId) &&
    (r.identityId === null || typeof r.identityId === "string") &&
    typeof r.subject === "string" &&
    isStringList(r.to) &&
    isStringList(r.cc) &&
    isStringList(r.bcc) &&
    typeof r.fingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(r.fingerprint) &&
    finiteTime(r.sendAt) &&
    finiteTime(r.createdAt) &&
    STATUSES.includes(r.status)
  );
}

export function createSendLater({ api, store, notify = () => {}, now = () => new Date() }) {
  const inFlight = new Set();
  let processing = null;

  /** Verifies the Drafts folder, uniqueness and fingerprint. Returns the draft header or a reason. */
  async function verifyDraft(record) {
    let folder = null;
    try {
      folder = await api.folders.get(record.draftFolderId, false);
    } catch {
      folder = null;
    }
    if (!folder || folder.accountId !== record.accountId || !(folder.specialUse || []).includes("drafts")) {
      return { reason: "the draft is no longer in a Drafts folder of its account" };
    }
    const hits = await findAllInFolder(api, record.draftFolderId, record.headerMessageId);
    if (hits.length !== 1) {
      return { reason: hits.length ? "more than one draft has this Message-ID" : "the draft was not found in Drafts" };
    }
    if ((await fingerprintMessage(api, hits[0].id)) !== record.fingerprint) {
      return { reason: "the draft was changed after it was scheduled" };
    }
    return { draft: hits[0] };
  }

  async function schedule(tabId, sendAt) {
    const when = sendAt instanceof Date ? sendAt : new Date(sendAt);
    if (Number.isNaN(when.getTime()) || when.getTime() < now().getTime() + MIN_LEAD_MS) {
      throw new Error("pick a time at least 30 seconds from now");
    }
    const details = await api.compose.getComposeDetails(tabId);
    const to = addressList(details.to);
    const cc = addressList(details.cc);
    const bcc = addressList(details.bcc);
    if (!to.length && !cc.length && !bcc.length) {
      throw new Error("add at least one recipient first");
    }
    const saved = await api.compose.saveMessage(tabId, { mode: "draft" });
    const draft = saved && saved.messages && saved.messages[0];
    if (!draft || !draft.folder || !draft.headerMessageId) {
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
      to,
      cc,
      bcc,
      fingerprint: "",
      sendAt: when.toISOString(),
      status: "scheduled",
      createdAt: now().toISOString(),
    };
    // Fingerprint what was just saved, then run the same checks the send will
    // run (verified Drafts folder, unique Message-ID, matching content).
    record.fingerprint = await fingerprintMessage(api, draft.id);
    const check = await verifyDraft(record);
    if (!check.draft || check.draft.id !== draft.id) {
      throw new Error(`cannot schedule: ${check.reason || "the saved draft could not be identified"}`);
    }
    await store.update(KEY, map => {
      if (map[key] && map[key].status === "sending") {
        throw new Error("this message is being sent right now");
      }
      map[key] = record;
    });
    await api.tabs.remove(tabId);
    return record;
  }

  /** Atomic: removes a scheduled (or finished) record; refuses while sending. */
  function cancel(key) {
    return store.update(KEY, map => {
      const r = map[key];
      if (!r) {
        return false;
      }
      if (r.status === "sending") {
        throw new Error("this message is being sent right now");
      }
      delete map[key];
      return true;
    });
  }

  async function list() {
    const map = await store.readMap(KEY);
    return Object.entries(map)
      .map(([k, r]) =>
        isValidRecord(r, k)
          ? r
          : { key: k, status: "invalid", subject: "(invalid record, never sent)", to: [], sendAt: new Date(0).toISOString() }
      )
      .sort((a, b) => new Date(a.sendAt) - new Date(b.sendAt));
  }

  /** Leaves "sending" for a final state. Throws if the claim was lost. */
  function finish(key, status, extra = {}) {
    return store.update(KEY, map => {
      const r = map[key];
      if (!r || r.status !== "sending") {
        throw new Error("send-later record changed while sending");
      }
      if (status === "sent") {
        delete map[key];
      } else {
        Object.assign(r, { status, ...extra });
      }
    });
  }

  /**
   * Claims one record for sending, atomically. Returns what to do:
   * {action: "send", record} or {action: "notify", title, text} or null.
   */
  function claim(key) {
    return store.update(KEY, map => {
      const r = map[key];
      if (!r || inFlight.has(key)) {
        return null;
      }
      if (typeof r !== "object") {
        delete map[key];
        return null;
      }
      if (r.status === "invalid" || TERMINAL.includes(r.status)) {
        return null;
      }
      if (!isValidRecord(r, key)) {
        map[key] = { key, status: "invalid", subject: "", sendAt: new Date(0).toISOString() };
        return { action: "notify", title: "Send later", text: "A scheduled send had invalid data and was not sent." };
      }
      if (r.status === "sending") {
        // Left over from a crash or restart mid-send: never resend blindly.
        r.status = "unknown";
        return {
          action: "notify",
          title: "Send later: check your Sent folder",
          text: `Thunderbird stopped while sending "${r.subject}". It was not retried.`,
        };
      }
      const t = now().getTime();
      const due = new Date(r.sendAt).getTime();
      if (due > t) {
        return null;
      }
      if (t - due > SEND_LATER_GRACE_MS) {
        r.status = "missed";
        return {
          action: "notify",
          title: "Send later missed",
          text: `"${r.subject}" was due while Thunderbird was closed. It is still in Drafts.`,
        };
      }
      r.status = "sending";
      r.claimedAt = new Date(t).toISOString();
      return { action: "send", record: { ...r } };
    });
  }

  async function sendOne(record) {
    const key = record.key;
    inFlight.add(key);
    try {
      const check = await verifyDraft(record);
      if (!check.draft) {
        await finish(key, "failed", { error: check.reason });
        notify("Send later failed", `"${record.subject}" was not sent: ${check.reason}.`);
        return;
      }
      // beginNew() on a draft opens it as "edit as new"; the original draft
      // stays in Drafts and is moved to Trash after a successful send.
      const tab = await api.compose.beginNew(check.draft.id, record.identityId ? { identityId: record.identityId } : {});
      const details = await api.compose.getComposeDetails(tab.id);
      const matches =
        sameList(addressList(details.to), record.to) &&
        sameList(addressList(details.cc), record.cc) &&
        sameList(addressList(details.bcc), record.bcc) &&
        (details.subject || "") === record.subject;
      if (!matches) {
        await api.tabs.remove(tab.id).catch(() => {});
        await finish(key, "failed", { error: "recipients or subject differ from the scheduled message" });
        notify("Send later failed", `"${record.subject}" was not sent: the reopened draft did not match.`);
        return;
      }
      try {
        await api.compose.sendMessage(tab.id, { mode: "sendNow" });
      } catch (e) {
        await finish(key, "failed", { error: String((e && e.message) || e).slice(0, 300) });
        notify("Send later failed", `"${record.subject}" was not sent. The compose window is left open.`);
        return;
      }
      await finish(key, "sent");
      const trash = await findSpecialFolder(api, record.accountId, "trash");
      if (trash) {
        try {
          await api.messages.move([check.draft.id], trash.id);
        } catch (e) {
          console.warn("draftsafe: could not move sent draft to Trash", e);
        }
      }
      notify("Sent", `"${record.subject}" was sent as scheduled.`);
    } finally {
      inFlight.delete(key);
    }
  }

  async function processDue() {
    if (processing) {
      return processing;
    }
    processing = (async () => {
      // Keys only: each record is re-read and claimed atomically, never taken
      // from a snapshot, so a record cancelled meanwhile is simply skipped.
      for (const key of Object.keys(await store.readMap(KEY))) {
        let step = null;
        try {
          step = await claim(key);
          if (!step) {
            continue;
          }
          if (step.action === "notify") {
            notify(step.title, step.text);
          } else if (step.action === "send") {
            await sendOne(step.record);
          }
        } catch (e) {
          console.error("draftsafe: send later failed", e);
          if (step && step.action === "send") {
            await finish(key, "failed", { error: "internal error" }).catch(() => {});
          }
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
