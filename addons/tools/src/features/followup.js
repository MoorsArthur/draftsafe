// SPDX-License-Identifier: MIT
// Follow-ups (user feature): the "Follow up" tag is the source of truth for
// "open" (draftsafe-bridge sets and clears the same tag); an optional due date
// is kept in this add-on's storage.local, keyed by account + Message-ID.

import { createFollowupTag } from "../../../shared/lib/followup-tag.js";
import { accountIdOf, summarizeHeader } from "../../../shared/lib/mail.js";
import { STORAGE_KEYS } from "../lib/constants.js";
import { recordKey } from "../lib/store.js";

const KEY = STORAGE_KEYS.followups;
const MAX_LISTED = 500;

export function createFollowups({ api, store, now = () => new Date() }) {
  const tag = createFollowupTag({ api });

  async function set(messageId, { due = null } = {}) {
    let dueIso = null;
    if (due) {
      const d = due instanceof Date ? due : new Date(due);
      if (Number.isNaN(d.getTime())) {
        throw new Error("invalid due date");
      }
      dueIso = d.toISOString();
    }
    const header = await tag.add(messageId);
    const key = recordKey(accountIdOf(header), header.headerMessageId);
    const record = {
      key,
      accountId: accountIdOf(header),
      headerMessageId: header.headerMessageId,
      due: dueIso,
      createdAt: now().toISOString(),
    };
    await store.put(KEY, key, record);
    return record;
  }

  async function clear(messageId) {
    const header = await tag.remove(messageId);
    await store.remove(KEY, recordKey(accountIdOf(header), header.headerMessageId));
    return true;
  }

  /** Open follow-ups: every message carrying the tag, with its stored due date. */
  async function list() {
    const { messages, truncated } = await tag.listTagged(MAX_LISTED);
    const records = await store.readMap(KEY);
    const t = now().getTime();
    const seen = new Set();
    const items = messages.map(m => {
      const key = recordKey(accountIdOf(m), m.headerMessageId);
      seen.add(key);
      const raw = records[key] ? records[key].due : null;
      const due = raw && Number.isFinite(new Date(raw).getTime()) ? raw : null;
      return { ...summarizeHeader(m), due, overdue: !!due && new Date(due).getTime() <= t };
    });
    // Drop due dates of messages that are no longer tagged (done elsewhere,
    // for example by the bridge), but only when we saw the complete list.
    if (!truncated) {
      const stale = Object.keys(records).filter(k => !seen.has(k));
      if (stale.length) {
        await store.update(KEY, map => stale.forEach(k => delete map[k]));
      }
    }
    items.sort((a, b) => {
      if (a.due && b.due) {
        return new Date(a.due) - new Date(b.due);
      }
      if (a.due || b.due) {
        return a.due ? -1 : 1;
      }
      return new Date(b.date) - new Date(a.date);
    });
    return { followups: items, truncated };
  }

  async function overdueCount() {
    const t = now().getTime();
    return (await store.list(KEY)).filter(r => r && r.due && new Date(r.due).getTime() <= t).length;
  }

  return { ensureTag: tag.ensureTag, set, clear, list, overdueCount };
}
