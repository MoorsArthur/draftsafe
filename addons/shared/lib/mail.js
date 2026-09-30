// SPDX-License-Identifier: MIT
// Read-only helpers over the MailExtension APIs, shared inside one add-on.
// `api` is the `messenger` global (injected so tests can pass a fake).
// Nothing here moves, sends or deletes mail.

// Caps on mailbox-controlled metadata, so one message with thousands of
// recipients or a megabyte subject cannot blow up a response.
export const SUMMARY_LIMITS = Object.freeze({
  maxListEntries: 50,
  maxStringChars: 1000,
});

/**
 * Collects up to `max` messages from messages.query() / list(), following
 * continueList() and aborting the list when we stop early.
 */
export async function collect(api, firstPage, max = Infinity) {
  let page = await firstPage;
  const out = [];
  for (;;) {
    for (const m of page.messages || []) {
      if (out.length >= max) {
        break;
      }
      out.push(m);
    }
    if (!page.id) {
      return { messages: out, listId: null };
    }
    if (out.length >= max) {
      return { messages: out, listId: page.id };
    }
    page = await api.messages.continueList(page.id);
  }
}

export async function abortList(api, listId) {
  if (listId && api.messages.abortList) {
    try {
      await api.messages.abortList(listId);
    } catch {
      // Already finished.
    }
  }
}

export async function queryAll(api, queryInfo, max = 500) {
  const { messages, listId } = await collect(api, api.messages.query(queryInfo), max);
  await abortList(api, listId);
  return messages;
}

export function accountIdOf(message) {
  return message && message.folder ? message.folder.accountId : null;
}

function capString(v) {
  if (typeof v !== "string") {
    return v;
  }
  return v.length > SUMMARY_LIMITS.maxStringChars ? `${v.slice(0, SUMMARY_LIMITS.maxStringChars)}…` : v;
}

function capList(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = arr.slice(0, SUMMARY_LIMITS.maxListEntries).map(capString);
  if (arr.length > SUMMARY_LIMITS.maxListEntries) {
    out.push(`… and ${arr.length - SUMMARY_LIMITS.maxListEntries} more`);
  }
  return out;
}

export function summarizeFolder(folder) {
  if (!folder) {
    return null;
  }
  return {
    id: folder.id,
    accountId: folder.accountId,
    name: capString(folder.name),
    path: capString(folder.path),
    specialUse: folder.specialUse || [],
  };
}

export function summarizeHeader(m) {
  return {
    id: m.id,
    headerMessageId: capString(m.headerMessageId),
    date: m.date instanceof Date ? m.date.toISOString() : m.date,
    author: capString(m.author),
    recipients: capList(m.recipients),
    ccList: capList(m.ccList),
    subject: capString(m.subject),
    read: !!m.read,
    flagged: !!m.flagged,
    tags: capList(m.tags),
    folder: summarizeFolder(m.folder),
  };
}
