// SPDX-License-Identifier: MIT
// Folder lookups with identity checks. Every move the tools add-on makes goes
// to a folder that was validated immediately before the move, never to a
// cached or name-matched folder.

import { queryAll } from "../../../shared/lib/mail.js";
import { SNOOZE_FOLDER_NAME, UNSAFE_SPECIAL_USES } from "./constants.js";

export class UnsafeFolderError extends Error {}

function uses(folder) {
  return (folder && folder.specialUse) || [];
}

export function hasUnsafeUse(folder) {
  return uses(folder).some(u => UNSAFE_SPECIAL_USES.includes(u));
}

async function getFolder(api, folderId) {
  try {
    return await api.folders.get(folderId, false);
  } catch {
    return null;
  }
}

/**
 * The account's Inbox, identified by special use only, and only if it has no
 * other (unsafe) special use.
 */
export async function findInbox(api, accountId) {
  const found = (await api.folders.query({ accountId, specialUse: ["inbox"] })) || [];
  const inbox = found.find(f => f.accountId === accountId && uses(f).includes("inbox") && !hasUnsafeUse(f));
  return inbox || null;
}

export async function findSpecialFolder(api, accountId, use) {
  const found = (await api.folders.query({ accountId, specialUse: [use] })) || [];
  return found.find(f => f.accountId === accountId && uses(f).includes(use)) || null;
}

/**
 * Checks that `folderId` is this account's dedicated Snoozed folder: a direct
 * child of the account root, named "Snoozed", with no special use at all.
 * Throws UnsafeFolderError otherwise. Called before every move into or out of it.
 */
export async function validateSnoozeFolder(api, accountId, folderId) {
  const folder = await getFolder(api, folderId);
  if (!folder) {
    throw new UnsafeFolderError("the Snoozed folder no longer exists");
  }
  if (folder.accountId !== accountId) {
    throw new UnsafeFolderError("the Snoozed folder belongs to another account");
  }
  if (folder.name !== SNOOZE_FOLDER_NAME || uses(folder).length || folder.isVirtual || folder.isTag || folder.isUnified) {
    throw new UnsafeFolderError(`folder "${folder.name}" is not a plain Snoozed folder`);
  }
  const account = await api.accounts.get(accountId, false);
  const rootId = account && account.rootFolder && account.rootFolder.id;
  const topLevel = rootId ? (await api.folders.getSubFolders(rootId, false)) || [] : [];
  if (!topLevel.some(f => f.id === folder.id)) {
    throw new UnsafeFolderError("the Snoozed folder is not at the top of its account");
  }
  return folder;
}

/**
 * Finds or creates the account's Snoozed folder and validates it. A folder
 * called "Snoozed" that has a special use (for example a Trash folder someone
 * renamed) is never used; snoozing fails instead.
 */
export async function ensureSnoozeFolder(api, accountId) {
  const account = await api.accounts.get(accountId, false);
  if (!account || !account.rootFolder) {
    throw new Error(`account ${accountId} not found`);
  }
  const children = (await api.folders.getSubFolders(account.rootFolder.id, false)) || [];
  let folder = children.find(f => f.name === SNOOZE_FOLDER_NAME);
  if (!folder) {
    folder = await api.folders.create(account.rootFolder.id, SNOOZE_FOLDER_NAME);
  }
  return validateSnoozeFolder(api, accountId, folder.id);
}

/** All messages with this Message-ID in one folder (0, 1 or, rarely, more). */
export async function findAllInFolder(api, folderId, headerMessageId, max = 5) {
  return queryAll(api, { folderId, headerMessageId }, max);
}
