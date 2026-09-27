// SPDX-License-Identifier: MIT
// Snooze: park a message in a per-account "Snoozed" folder and bring it back
// to the Inbox, unread, when it is due. Records are keyed by account +
// Message-ID because numeric message ids change on move and restart.

import { STORAGE_KEYS } from "../lib/constants.js";
import { recordKey } from "../lib/store.js";
import { accountIdOf, ensureSnoozeFolder, findInFolder, findSpecialFolder } from "../lib/mail.js";

const KEY = STORAGE_KEYS.snoozes;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
// If a snoozed message cannot be found for this long after it was due, the
// record is dropped (the user deleted or moved it by hand).
const ORPHAN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function createSnooze({ api, store, now = () => new Date() }) {
  let waking = null;

  async function snoozeOne(messageId, until) {
    const header = await api.messages.get(messageId);
    if (!header || header.external || !header.folder) {
      throw new Error(`message ${messageId} cannot be snoozed`);
    }
    const accountId = accountIdOf(header);
    const folder = await ensureSnoozeFolder(api, accountId);
    const key = recordKey(accountId, header.headerMessageId);
    const existing = await store.get(KEY, key);
    const record = {
      key,
      accountId,
      headerMessageId: header.headerMessageId,
      subject: header.subject,
      author: header.author,
      until: until.toISOString(),
      snoozedAt: now().toISOString(),
      snoozeFolderId: folder.id,
      // Keep the first origin if a snoozed message is re-snoozed.
      originalFolderId:
        existing && header.folder.id === folder.id ? existing.originalFolderId : header.folder.id,
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
    const msg = await findInFolder(api, record.snoozeFolderId, record.headerMessageId);
    if (!msg) {
      if (now().getTime() - new Date(record.until).getTime() > ORPHAN_AFTER_MS) {
        await store.remove(KEY, record.key);
      }
      return false;
    }
    const inbox = await findSpecialFolder(api, record.accountId, "inbox");
    const destination = inbox ? inbox.id : record.originalFolderId;
    // Mark unread before the move: the flag travels with the message, and the
    // moved copy gets a new id we would otherwise have to look up again.
    await api.messages.update(msg.id, { read: false });
    await api.messages.move([msg.id], destination);
    await store.remove(KEY, record.key);
    return true;
  }

  async function wakeDue() {
    if (waking) {
      return waking;
    }
    waking = (async () => {
      const due = (await store.list(KEY)).filter(r => new Date(r.until).getTime() <= now().getTime());
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
    const all = await store.list(KEY);
    return all.sort((a, b) => new Date(a.until) - new Date(b.until));
  }

  async function unsnooze(key) {
    const record = await store.get(KEY, key);
    if (!record) {
      return false;
    }
    return wakeRecord(record);
  }

  return { snooze, wakeDue, list, unsnooze };
}
