// SPDX-License-Identifier: MIT
// Folder rules for approved agent requests. Every destination or folder an
// approved action touches is looked up and checked here immediately before
// the action runs, never taken from a cache or matched by name alone.
//
// Protected (never renamed, merged or removed; only Inbox can be a move destination):
//   - special-use folders (Inbox, Drafts, Sent, Trash, Junk, Archives,
//     Templates, Outbox) and every ANCESTOR of one (e.g. "[Gmail]");
//   - everything inside Trash, Junk, Outbox, Drafts, Templates or Sent;
//   - the account root, virtual, unified and tag folders;
//   - the tools add-on's own top-level "Snoozed" folder.

import { SNOOZE_FOLDER_NAME, UNSAFE_SPECIAL_USES } from "../lib/constants.js";

export class FolderRuleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const uses = f => (f && Array.isArray(f.specialUse) ? f.specialUse : []);
const isWithin = (path, parentPath) => parentPath !== "/" && path.startsWith(`${parentPath}/`);

/** The account's folders as a flat list: {folder, parentId, depth}. Root has depth 0. */
export async function loadTree(api, accountId) {
  const account = await api.accounts.get(accountId, true);
  if (!account || !account.rootFolder) {
    throw new FolderRuleError("folder_not_found", "account not found");
  }
  const nodes = [];
  const walk = (folder, parentId, depth) => {
    nodes.push({ folder, parentId, depth });
    for (const sub of folder.subFolders || []) {
      walk(sub, folder.id, depth + 1);
    }
  };
  walk(account.rootFolder, null, 0);
  const byId = new Map(nodes.map(n => [n.folder.id, n]));
  return { accountId, account, nodes, byId, root: account.rootFolder };
}

/** Why `folder` may not be changed or used as a destination, or null if it may. */
export function protectionOf(tree, folder) {
  if (!folder || folder.accountId !== tree.accountId) return "another account";
  if (folder.isRoot || folder.id === tree.root.id || folder.path === "/") return "the account root";
  if (folder.isVirtual || folder.isUnified || folder.isTag) return "a virtual folder";
  if (uses(folder).length) return `a special folder (${uses(folder).join(", ")})`;
  for (const { folder: other } of tree.nodes) {
    const u = uses(other);
    if (!u.length) continue;
    if (isWithin(other.path, folder.path)) return "a parent of a special folder";
    if (u.some(x => UNSAFE_SPECIAL_USES.includes(x)) && isWithin(folder.path, other.path)) {
      return `inside a special folder (${u.join(", ")})`;
    }
  }
  const node = tree.byId.get(folder.id);
  if (folder.name === SNOOZE_FOLDER_NAME && node && node.depth === 1) return "Draftsafe's Snoozed folder";
  return null;
}

/** A parent a new folder may be created in: the root or an unprotected folder. */
export function creatableParentProblem(tree, parent) {
  if (!parent || parent.accountId !== tree.accountId) return "another account";
  if (parent.id === tree.root.id) return null;
  return protectionOf(tree, parent);
}

export function childNamed(tree, parentId, name) {
  return tree.nodes.find(n => n.parentId === parentId && n.folder.name.toLowerCase() === name.toLowerCase()) || null;
}

export function depthOf(tree, folderId) {
  const n = tree.byId.get(folderId);
  return n ? n.depth : -1;
}

export function hasChildren(tree, folderId) {
  return tree.nodes.some(n => n.parentId === folderId);
}

/**
 * Resolves an account-relative path ["Clients", "Acme"] for a "move". Returns
 * {folder} when it exists, or {parent, create: [names]} for the missing tail.
 */
export function resolvePath(tree, segments) {
  let parent = tree.root;
  for (let i = 0; i < segments.length; i++) {
    const child = childNamed(tree, parent.id, segments[i]);
    if (!child) {
      return { folder: null, parent, create: segments.slice(i) };
    }
    parent = child.folder;
  }
  return { folder: parent, parent: null, create: [] };
}

/**
 * The account's one folder with this special use ("trash", "archives"),
 * checked for identity. Several candidates, or none, fail closed.
 */
export async function specialFolderOf(api, accountId, use) {
  const found = ((await api.folders.query({ accountId, specialUse: [use] })) || []).filter(
    f => f.accountId === accountId && uses(f).includes(use) && !f.isVirtual && !f.isUnified && !f.isTag
  );
  if (found.length !== 1) {
    return null;
  }
  return found[0];
}

/** Re-reads a folder by id right before acting on it. */
export async function freshFolder(api, folderId) {
  try {
    return (await api.folders.get(folderId, false)) || null;
  } catch {
    return null;
  }
}

/** Last path segment, for display. */
export function labelOf(folder) {
  return folder ? folder.name || folder.path : "?";
}

/** "Work › Clients › Acme" style label from the tree. */
export function pathLabel(tree, folder) {
  const names = [];
  let node = folder && tree.byId.get(folder.id);
  while (node && node.parentId) {
    names.unshift(node.folder.name);
    node = tree.byId.get(node.parentId);
  }
  return [tree.account.name || tree.accountId, ...names].join(" › ");
}
