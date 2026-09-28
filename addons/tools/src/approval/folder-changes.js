// SPDX-License-Identifier: MIT
// Approved folder changes: create, rename, merge (move all messages of A
// into B, then remove A if it is empty), delete_empty.
//
// "Remove" always means folders.move(folder, <the account's Trash>), which is
// recoverable and exactly what Thunderbird's own Delete does. folders.delete
// is never used: it needs the messagesDelete permission, which this add-on
// does not hold.
//
// Special folders and their parents are never touched (tree.js). Every
// change is re-validated right before it runs; delete_empty and the removal
// step of merge re-check "no messages and no subfolders" after the click.

import { APPROVAL_LIMITS, isValidFolderName } from "../../../shared/lib/approval-schema.js";
import { abortList, collect } from "../../../shared/lib/mail.js";
import { chunks, decisionList, DecisionError, snapshotMessage, stillSame, groupBySender } from "./common.js";
import {
  FolderRuleError,
  childNamed,
  creatableParentProblem,
  freshFolder,
  hasChildren,
  loadTree,
  pathLabel,
  protectionOf,
  specialFolderOf,
} from "./tree.js";

export const MERGE_MAX_MESSAGES = APPROVAL_LIMITS.maxMessages;
const MAX_PREVIEW_LINES = 400;

async function folderById(api, id) {
  const f = await freshFolder(api, id);
  if (f) return f;
  // Account roots are not always returned by folders.get().
  try {
    const accounts = (await api.accounts.list(false)) || [];
    const a = accounts.find(x => x.rootFolder && x.rootFolder.id === id);
    return a ? a.rootFolder : null;
  } catch {
    return null;
  }
}

async function countOf(api, folderId) {
  try {
    const info = await api.folders.getFolderInfo(folderId);
    return info && Number.isInteger(info.totalMessageCount) ? info.totalMessageCount : null;
  } catch {
    return null;
  }
}

function sameName(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

export async function planFolderChanges(api, input) {
  const trees = new Map();
  const treeOf = async accountId => {
    if (!trees.has(accountId)) trees.set(accountId, await loadTree(api, accountId));
    return trees.get(accountId);
  };
  const reject = (code, msg) => {
    throw new FolderRuleError(code, msg);
  };

  const planned = [];
  let totalMessages = 0;
  for (const c of input.changes) {
    const folder = await folderById(api, c.folder);
    if (!folder || !folder.accountId) reject("folder_not_found", "a folder id is unknown; list the folders again");
    const tree = await treeOf(folder.accountId);
    const node = tree.byId.get(folder.id);
    if (!node) reject("folder_not_found", "a folder id is unknown; list the folders again");
    const p = { action: c.action, accountId: folder.accountId, folderId: folder.id, path: folder.path };

    if (c.action === "create") {
      const problem = creatableParentProblem(tree, node.folder);
      if (problem) reject("forbidden_folder", `cannot create a folder in ${problem}`);
      if (node.depth + 1 > APPROVAL_LIMITS.maxCreateDepth) {
        reject("too_deep", `new folders may be at most ${APPROVAL_LIMITS.maxCreateDepth} levels below the account root`);
      }
      if (tree.nodes.some(n => n.parentId === node.folder.id && sameName(n.folder.name, c.newName))) {
        reject("already_exists", "a folder with that name already exists there");
      }
      p.newName = c.newName;
      p.label = `Create “${c.newName}” in ${pathLabel(tree, node.folder)}`;
    } else {
      const problem = protectionOf(tree, node.folder);
      if (problem) reject("forbidden_folder", `a folder to change is ${problem}`);
      if (node.depth > 2 || tree.nodes.some(n => n.folder.path.startsWith(`${folder.path}/`) && n.depth > 2)) reject("too_deep", "folder changes are limited to depth two");
      p.count = await countOf(api, folder.id);
      if (c.action === "rename") {
        if (tree.nodes.some(n => n.parentId === node.parentId && n.folder.id !== folder.id && sameName(n.folder.name, c.newName))) {
          reject("already_exists", "a sibling folder already has that name");
        }
        p.newName = c.newName;
        p.label = `Rename ${pathLabel(tree, folder)} to “${c.newName}”`;
      } else if (c.action === "merge") {
        const into = await folderById(api, c.into);
        if (!into || into.accountId !== folder.accountId) reject("mixed_accounts", "merge only works within one account");
        const intoNode = tree.byId.get(into.id);
        if (!intoNode) reject("folder_not_found", "a folder id is unknown; list the folders again");
        const intoProblem = protectionOf(tree, intoNode.folder);
        if (intoProblem) reject("forbidden_folder", `the merge target is ${intoProblem}`);
        if (p.count === null) reject("failed", "could not count the messages to merge");
        if (p.count > MERGE_MAX_MESSAGES) reject("too_many", `a merge may move at most ${MERGE_MAX_MESSAGES} messages`);
        if (!isValidFolderName(folder.name) || !isValidFolderName(into.name)) reject("invalid_name", "merge requires ordinary folder names");
        if (intoNode.depth > 2 || into.path.startsWith(`${folder.path}/`)) reject("too_deep", "invalid merge destination");
        const listed = await collect(api, api.messages.list(folder.id), MERGE_MAX_MESSAGES + 1);
        await abortList(api, listed.listId);
        totalMessages += listed.messages.length;
        if (totalMessages > MERGE_MAX_MESSAGES || listed.listId) reject("too_many", "at most 2000 messages per request");
        p.snaps = [];
        for (const m of listed.messages) p.snaps.push(await snapshotMessage(api, m.id));
        p.count = p.snaps.length;
        p.into = into.id;
        p.intoPath = into.path;
        p.keepsChildren = hasChildren(tree, folder.id);
        p.label = `Merge ${pathLabel(tree, folder)} (${p.count} messages) into ${pathLabel(tree, into)}` +
          (p.keepsChildren ? "; it has subfolders, so it is kept" : ", then move the empty folder to Trash");
      } else if (c.action === "delete_empty") {
        if (p.count !== 0 || hasChildren(tree, folder.id)) reject("not_empty", "only folders without messages and subfolders can be removed");
        p.label = `Move the empty folder ${pathLabel(tree, folder)} to Trash`;
      }
    }
    planned.push(p);
  }

  // A change may not act on a folder inside one that another change renames,
  // merges or removes (its id would change or it would move to Trash).
  for (const a of planned) {
    for (const b of planned) {
      if (a === b || b.action === "create" || a.accountId !== b.accountId) continue;
      const inside = path => path && b.path && path.startsWith(`${b.path}/`);
      if (inside(a.path) || inside(a.intoPath)) {
        reject("conflict", "one change acts inside a folder that another change modifies; split the work into several requests");
      }
    }
  }

  const binding = planned.map(p => [p.action, p.accountId, p.folderId, p.newName || null, p.into || null, p.count ?? null, p.snaps || []]);
  const view = { kind: "folders", changes: planned.map((p, index) => ({ index, action: p.action, label: p.label, groups: groupBySender(p.snaps || []) })), previews: [] };
  for (const [accountId, tree] of trees) {
    view.previews.push(await preview(api, tree, planned.filter(p => p.accountId === accountId)));
  }

  function readDecision(decision) {
    return decisionList(decision, "changes", planned.length).map((d, i) => {
      const ids = new Set((planned[i].snaps || []).map(s => s.id));
      const excluded = d.excluded || [];
      if (!Array.isArray(excluded) || new Set(excluded).size !== excluded.length || excluded.some(id => !ids.has(id))) throw new DecisionError("invalid exclusion");
      return { approved: d.approved, excluded: new Set(excluded) };
    });
  }

  async function removeToTrash(accountId, folderId) {
    const tree = await loadTree(api, accountId);
    const node = tree.byId.get(folderId);
    if (!node || protectionOf(tree, node.folder) || hasChildren(tree, folderId)) return false;
    if ((await countOf(api, folderId)) !== 0) return false;
    const trash = await specialFolderOf(api, accountId, "trash");
    if (!trash) return false;
    await api.folders.move(folderId, trash.id);
    return true;
  }

  async function run(p, choice) {
    const tree = await loadTree(api, p.accountId);
    const node = tree.byId.get(p.folderId);
    if (!node || node.folder.path !== p.path) return "refused";
    if (p.action === "create") {
      if (creatableParentProblem(tree, node.folder) || node.depth + 1 > APPROVAL_LIMITS.maxCreateDepth) return "refused";
      if (childNamed(tree, node.folder.id, p.newName)) return "refused";
      await api.folders.create(node.folder.id, p.newName);
      return "done";
    }
    if (node.depth > 2 || tree.nodes.some(n => n.folder.path.startsWith(`${node.folder.path}/`) && n.depth > 2) || protectionOf(tree, node.folder)) return "refused";
    if (p.action === "rename") {
      if (tree.nodes.some(n => n.parentId === node.parentId && n.folder.id !== p.folderId && sameName(n.folder.name, p.newName))) {
        return "refused";
      }
      await api.folders.rename(p.folderId, p.newName);
      return "done";
    }
    if (p.action === "delete_empty") {
      return (await removeToTrash(p.accountId, p.folderId)) ? "done" : "refused";
    }
    // merge
    const into = tree.byId.get(p.into);
    if (!into || into.depth > 2 || into.folder.path !== p.intoPath || protectionOf(tree, into.folder)) return "refused";
    const selected = p.snaps.filter(s => !choice.excluded.has(s.id));
    for (const s of selected) if (!(await stillSame(api, s))) return "refused";
    for (const part of chunks(selected)) {
      const fresh = await loadTree(api, p.accountId);
      if (protectionOf(fresh, fresh.byId.get(p.folderId)?.folder) || protectionOf(fresh, fresh.byId.get(p.into)?.folder)) return "refused";
      for (const s of part) if (!(await stillSame(api, s))) return "refused";
      await api.messages.move(part.map(s => s.id), p.into);
    }
    return (await removeToTrash(p.accountId, p.folderId)) ? "done" : "kept_not_empty";
  }

  async function execute(decision) {
    const choices = readDecision(decision);
    const changes = [];
    for (const [i, p] of planned.entries()) {
      if (!choices[i].approved) {
        changes.push({ action: p.action, approved: false, result: "denied" });
        continue;
      }
      let result;
      try {
        result = await run(p, choices[i]);
      } catch (e) {
        console.error("draftsafe: approved folder change failed", e);
        result = "failed";
      }
      changes.push({ action: p.action, approved: true, result });
    }
    return { changes };
  }

  return { binding, view, execute, readDecision };
}

/** Before/after outline of one account's folders with the planned changes marked. */
async function preview(api, tree, changes) {
  const nodes = tree.nodes.filter(n => n.depth > 0).slice(0, MAX_PREVIEW_LINES);
  const counts = new Map();
  for (const n of nodes) counts.set(n.folder.id, await countOf(api, n.folder.id));
  const before = nodes.map(n => ({
    depth: n.depth,
    name: n.folder.name,
    count: counts.get(n.folder.id),
    special: (n.folder.specialUse || []).join(", "),
    mark: null,
  }));
  const virtual = tree.nodes.map(n => ({ id: n.folder.id, parentId: n.parentId, name: n.folder.name,
    count: counts.get(n.folder.id) ?? null, special: (n.folder.specialUse || []).join(", "), mark: null }));
  const byId = new Map(virtual.map(n => [n.id, n]));
  const trash = tree.nodes.find(n => n.folder.specialUse?.includes("trash"))?.folder.id;
  for (const [i, c] of changes.entries()) {
    const n = byId.get(c.folderId);
    if (c.action === "create") {
      virtual.push({ id: `preview-new-${i}`, parentId: c.folderId, name: c.newName, count: 0, special: "", mark: "new" });
    } else if (c.action === "rename") {
      n.mark = `renamed from “${n.name}”`; n.name = c.newName;
    } else if (c.action === "delete_empty") {
      if (trash) { n.parentId = trash; n.mark = "empty folder moved here"; }
      else n.mark = "refused: no Trash destination";
    } else if (c.action === "merge") {
      const target = byId.get(c.into);
      target.count = target.count === null ? null : target.count + c.count;
      target.mark = `+${c.count} merged in`;
      n.count = 0;
      if (!c.keepsChildren && trash) { n.parentId = trash; n.mark = "merged; empty folder moved here"; }
      else n.mark = "merged; source kept";
    }
  }
  const after = [];
  function walk(parentId, depth) {
    for (const n of virtual.filter(n => n.parentId === parentId)) {
      if (after.length >= MAX_PREVIEW_LINES) return;
      after.push({ depth, name: n.name, count: n.count, special: n.special, mark: n.mark });
      walk(n.id, depth + 1);
    }
  }
  walk(tree.root.id, 1);
  return { account: tree.account.name || tree.accountId, before, after, truncated: virtual.length - 1 > MAX_PREVIEW_LINES };
}
