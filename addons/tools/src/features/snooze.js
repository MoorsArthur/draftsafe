// SPDX-License-Identifier: MIT
// Snooze (user feature): park a message in the account's dedicated "Snoozed"
// folder and bring it back to the Inbox, unread, when it is due.
//
// Safety rules, checked immediately before every move:
//   - the only destinations are the validated Snoozed folder (a top-level,
//     plain folder named "Snoozed" with no special use) and the account's
//     Inbox (found by special use, never by name);
//   - messages in Trash, Junk, Outbox, Drafts, Templates or Sent are never
//     snoozed (a scheduled send-later draft must stay where it is);
//   - if the Inbox cannot be found, the message stays in Snoozed.
// Records are keyed by account + Message-ID because numeric message ids
// change on move and restart.

import { accountIdOf } from "../../../shared/lib/mail.js";
import { STORAGE_KEYS } from "../lib/constants.js";
import { recordKey } from "../lib/store.js";
import { ensureSnoozeFolder, findAllInFolder, findInbox, hasUnsafeUse, validateSnoozeFolder } from "../lib/folders.js";

const KEY = STORAGE_KEYS.snoozes;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
// If a snoozed message cannot be found for this long after it was due, the
// record is dropped (the user deleted or moved it by hand).
const ORPHAN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function validRecord(r) {
  return (
    r &&
    typeof r.key === "string" &&
    typeof r.accountId === "string" &&
    typeof r.headerMessageId === "string" &&
    typeof r.snoozeFolderId === "string" &&
    r.key === recordKey(r.accountId, r.headerMessageId) &&
    Number.isFinite(new Date(r.until).getTime())
  );
}

export function createSnooze({ api, store, notify = () => {}, now = () => new Date() }) {
  let waking = null;

  async function snoozeOne(messageId, until) {
    const header = await api.messages.get(messageId);
    if (!header || header.external || !header.folder) {
      throw new Error(`message ${messageId} cannot be snoozed`);
    }
    if (hasUnsafeUse(header.folder)) {
      throw new Error("messages in Trash, Junk, Outbox, Drafts, Templates or Sent cannot be snoozed");
    }
    const accountId = accountIdOf(header);
    const folder = await ensureSnoozeFolder(api, accountId);
    const key = recordKey(accountId, header.headerMessageId);
    const record = {
      key,
      accountId,
      headerMessageId: header.headerMessageId,
      subject: header.subject,
      author: header.author,
      until: until.toISOString(),
      snoozedAt: now().toISOString(),
      snoozeFolderId: folder.id,
    };
    // Store first: if the move fails we drop the record again, but if we
    // crashed after the move without a record, the message would be stranded.
    await store.put(KEY, key, record);
    if (header.folder.id !== folder.id) {
      try {
        await api.messages.move([messageId], folder.id);
      } catch (e) {
        await store.remove(KEY, key);
        throw e;
      }
    }
    return record;
  }

  async function snooze(messageIds, until) {
    const when = until instanceof Date ? until : new Date(until);
    const t = when.getTime();
    if (Number.isNaN(t) || t <= now().getTime() || t - now().getTime() > MAX_AHEAD_MS) {
      throw new Error("snooze time must be in the future and within one year");
    }
    const out = [];
    for (const id of messageIds) {
      out.push(await snoozeOne(id, when));
    }
    return out;
  }

  async function wakeRecord(record) {
    // Re-validate the source: it must still be this account's plain Snoozed folder.
    await validateSnoozeFolder(api, record.accountId, record.snoozeFolderId);
    const hits = await findAllInFolder(api, record.snoozeFolderId, record.headerMessageId);
    if (!hits.length) {
      if (now().getTime() - new Date(record.until).getTime() > ORPHAN_AFTER_MS) {
        await store.remove(KEY, record.key);
      }
      return false;
    }
    const inbox = await findInbox(api, record.accountId);
    if (!inbox) {
      notify("Snooze", `"${record.subject || "(no subject)"}" is due, but no Inbox was found. It stays in Snoozed.`);
      return false;
    }
    for (const msg of hits) {
      // Mark unread before the move: the flag travels with the message, and
      // the moved copy gets a new id we would otherwise have to look up again.
      await api.messages.update(msg.id, { read: false });
      await api.messages.move([msg.id], inbox.id);
    }
    await store.remove(KEY, record.key);
    return true;
  }

  async function wakeDue() {
    if (waking) {
      return waking;
    }
    waking = (async () => {
      const t = now().getTime();
      const due = [];
      for (const [mapKey, record] of Object.entries(await store.readMap(KEY))) {
        if (!validRecord(record) || record.key !== mapKey) {
          // Malformed or tampered record: drop it, never act on it.
          await store.remove(KEY, mapKey);
        } else if (new Date(record.until).getTime() <= t) {
          due.push(record);
        }
      }
      let woken = 0;
      for (const record of due) {
        try {
          if (await wakeRecord(record)) {
            woken++;
          }
        } catch (e) {
          console.error("draftsafe: waking snoozed message failed", e);
        }
      }
      return woken;
    })();
    try {
      return await waking;
    } finally {
      waking = null;
    }
  }

  async function list() {
    const all = (await store.list(KEY)).filter(validRecord);
    return all.sort((a, b) => new Date(a.until) - new Date(b.until));
  }

  async function unsnooze(key) {
    const record = await store.get(KEY, key);
    if (!validRecord(record) || record.key !== key) {
      return false;
    }
    return wakeRecord(record);
  }

  return { snooze, wakeDue, list, unsnooze };
}
