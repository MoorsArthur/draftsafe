// SPDX-License-Identifier: MIT
// The "Follow up" tag: the shared source of truth for "this message needs a
// follow-up". Both add-ons use it; only draftsafe-tools keeps due dates.

import { FOLLOWUP_TAG_COLOR, FOLLOWUP_TAG_KEY, FOLLOWUP_TAG_LABEL } from "./constants.js";
import { abortList, collect } from "./mail.js";

export function createFollowupTag({ api }) {
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

  /** Adds the tag. Returns the message header as it was before the update. */
  async function add(messageId) {
    await ensureTag();
    const header = await api.messages.get(messageId);
    if (!header || header.external) {
      throw new Error(`message ${messageId} cannot be tagged`);
    }
    const tags = new Set(header.tags || []);
    tags.add(FOLLOWUP_TAG_KEY);
    await api.messages.update(messageId, { tags: [...tags] });
    return header;
  }

  async function remove(messageId) {
    const header = await api.messages.get(messageId);
    if (!header || header.external) {
      throw new Error(`message ${messageId} cannot be tagged`);
    }
    const tags = (header.tags || []).filter(t => t !== FOLLOWUP_TAG_KEY);
    await api.messages.update(messageId, { tags });
    return header;
  }

  /** Messages carrying the tag, up to `max`. `truncated` when there were more. */
  async function listTagged(max) {
    const { messages, listId } = await collect(
      api,
      api.messages.query({ tags: { mode: "all", tags: { [FOLLOWUP_TAG_KEY]: true } } }),
      max
    );
    await abortList(api, listId);
    return { messages, truncated: !!listId };
  }

  return { ensureTag, add, remove, listTagged };
}
