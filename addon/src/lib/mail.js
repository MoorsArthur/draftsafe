// SPDX-License-Identifier: MIT
// Small helpers over the MailExtension APIs. `api` is the `messenger` global
// (injected so tests can pass a fake).

import { SNOOZE_FOLDER_NAME } from "./constants.js";

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

export async function findSpecialFolder(api, accountId, use) {
  const found = await api.folders.query({ accountId, specialUse: [use] });
  return (found && found[0]) || null;
}

const snoozeFolderCache = new Map();

export async function ensureSnoozeFolder(api, accountId) {
  const cached = snoozeFolderCache.get(accountId);
  if (cached) {
    return cached;
  }
  const account = await api.accounts.get(accountId, false);
  if (!account || !account.rootFolder) {
    throw new Error(`account ${accountId} not found`);
  }
  const children = await api.folders.getSubFolders(account.rootFolder.id, false);
  let folder = (children || []).find(f => f.name === SNOOZE_FOLDER_NAME);
  if (!folder) {
    folder = await api.folders.create(account.rootFolder.id, SNOOZE_FOLDER_NAME);
  }
  snoozeFolderCache.set(accountId, folder);
  return folder;
}

/** Finds the current MessageHeader for a Message-ID within one folder, newest first. */
export async function findInFolder(api, folderId, headerMessageId) {
  const hits = await queryAll(api, { folderId, headerMessageId }, 20);
  hits.sort((a, b) => new Date(b.date) - new Date(a.date));
  return hits[0] || null;
}

export async function findByHeaderMessageId(api, headerMessageId, accountId) {
  const query = { headerMessageId };
  if (accountId) {
    query.accountId = accountId;
  }
  return queryAll(api, query, 20);
}

export function summarizeFolder(folder) {
  if (!folder) {
    return null;
  }
  return {
    id: folder.id,
    accountId: folder.accountId,
    name: folder.name,
    path: folder.path,
    specialUse: folder.specialUse || [],
  };
}

export function summarizeHeader(m) {
  return {
    id: m.id,
    headerMessageId: m.headerMessageId,
    date: m.date instanceof Date ? m.date.toISOString() : m.date,
    author: m.author,
    recipients: m.recipients || [],
    ccList: m.ccList || [],
    subject: m.subject,
    read: !!m.read,
    flagged: !!m.flagged,
    tags: m.tags || [],
    folder: summarizeFolder(m.folder),
  };
}
