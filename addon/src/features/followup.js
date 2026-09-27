// SPDX-License-Identifier: MIT
// Follow-ups: the "Follow up" tag is the source of truth for "open"; an
// optional due date is kept in storage.local, keyed by account + Message-ID.

import { FOLLOWUP_TAG_COLOR, FOLLOWUP_TAG_KEY, FOLLOWUP_TAG_LABEL, STORAGE_KEYS } from "../lib/constants.js";
import { recordKey } from "../lib/store.js";
import { accountIdOf, collect, abortList, summarizeHeader } from "../lib/mail.js";

const KEY = STORAGE_KEYS.followups;
const MAX_LISTED = 500;

export function createFollowups({ api, store, now = () => new Date() }) {
  let tagReady = null;

  function ensureTag() {
    if (!tagReady) {
      tagReady = (async () => {
        const tags = await api.messages.tags.list();
        if (!tags.some(t => t.key === FOLLOWUP_TAG_KEY)) {
          await api.messages.tags.create(FOLLOWUP_TAG_KEY, FOLLOWUP_TAG_LABEL, FOLLOWUP_TAG_COLOR);
        }
      })().catch(e => {
        tagReady = null;
        throw e;
      });
    }
    return tagReady;
  }

  async function set(messageId, { due = null } = {}) {
    await ensureTag();
    const header = await api.messages.get(messageId);
    if (!header || header.external) {
      throw new Error(`message ${messageId} cannot be tagged`);
    }
    let dueIso = null;
    if (due) {
      const d = due instanceof Date ? due : new Date(due);
      if (Number.isNaN(d.getTime())) {
        throw new Error("invalid due date");
      }
      dueIso = d.toISOString();
    }
    const tags = new Set(header.tags || []);
    tags.add(FOLLOWUP_TAG_KEY);
    await api.messages.update(messageId, { tags: [...tags] });
    const key = recordKey(accountIdOf(header), header.headerMessageId);
    const record = {
      key,
      accountId: accountIdOf(header),
      headerMessageId: header.headerMessageId,
      subject: header.subject,
      author: header.author,
      due: dueIso,
      createdAt: now().toISOString(),
    };
    await store.put(KEY, key, record);
    return record;
  }

  async function clear(messageId) {
    const header = await api.messages.get(messageId);
    if (!header) {
      throw new Error(`message ${messageId} not found`);
    }
    const tags = (header.tags || []).filter(t => t !== FOLLOWUP_TAG_KEY);
    await api.messages.update(messageId, { tags });
    await store.remove(KEY, recordKey(accountIdOf(header), header.headerMessageId));
    return true;
  }

  /** Open follow-ups: every message carrying the tag, with its stored due date. */
  async function list() {
    const { messages, listId } = await collect(
      api,
      api.messages.query({ tags: { mode: "all", tags: { [FOLLOWUP_TAG_KEY]: true } } }),
      MAX_LISTED
    );
    await abortList(api, listId);
    const records = await store.readMap(KEY);
    const t = now().getTime();
    const seen = new Set();
    const items = messages.map(m => {
      const key = recordKey(accountIdOf(m), m.headerMessageId);
      seen.add(key);
      const due = records[key] ? records[key].due : null;
      return { ...summarizeHeader(m), due, overdue: !!due && new Date(due).getTime() <= t };
    });
    // Drop due dates of messages that are no longer tagged (done elsewhere),
    // but only when we saw the complete list.
    if (!listId) {
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
    return { followups: items, truncated: !!listId };
  }

  async function overdueCount() {
    const t = now().getTime();
    return (await store.list(KEY)).filter(r => r.due && new Date(r.due).getTime() <= t).length;
  }

  return { ensureTag, set, clear, list, overdueCount };
}
