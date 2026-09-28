// SPDX-License-Identifier: MIT
// Approved cleanup batches: move messages to the account's Trash, to its
// Archives folder, or to a user folder (optionally creating it).
//
//   trash    -> the account's one special-use "trash" folder (recoverable;
//               this add-on has no messagesDelete permission and never
//               deletes or empties anything)
//   archive  -> the account's one special-use "archives" folder
//   move     -> a user folder or the account's Inbox; never another
//               special folder, a parent of one, or anything inside Trash,
//               Junk, Outbox, Drafts, Templates or Sent (see tree.js).
//               createFolder may create at most the missing tail of the
//               path, at most two levels below the account root.
//
// plan() only reads. execute() runs after a click and re-checks every
// message and destination right before moving.

import { APPROVAL_LIMITS, isValidFolderName } from "../../../shared/lib/approval-schema.js";
import { chunks, decisionList, DecisionError, groupBySender, snapshotMessage, stillSame } from "./common.js";
import {
  FolderRuleError,
  childNamed,
  creatableParentProblem,
  loadTree,
  pathLabel,
  protectionOf,
  resolvePath,
  specialFolderOf,
} from "./tree.js";

const SPECIAL_FOR = { trash: "trash", archive: "archives" };
const MAX_VIEW_ITEMS = APPROVAL_LIMITS.maxMessages;

function moveDestinationProblem(tree, folder) {
  const problem = protectionOf(tree, folder);
  // A top-level, dedicated Inbox can restore mail. All other protection rules remain.
  const inbox = tree.byId.get(folder.id)?.depth === 1 &&
    Array.isArray(folder.specialUse) && folder.specialUse.length === 1 && folder.specialUse[0] === "inbox" &&
    !folder.isVirtual && !folder.isUnified && !folder.isTag;
  return inbox && problem === "a special folder (inbox)" ? null : problem;
}

async function planDestination(api, batch, accountId) {
  const tree = await loadTree(api, accountId);
  const acct = tree.account.name || accountId;
  if (batch.action !== "move") {
    const use = SPECIAL_FOR[batch.action];
    const folder = await specialFolderOf(api, accountId, use);
    if (!folder) {
      throw new FolderRuleError(
        batch.action === "trash" ? "no_trash_folder" : "no_archive_folder",
        `account has no single ${use} folder`
      );
    }
    return { accountId, folderId: folder.id, create: null, label: `${pathLabel(tree, folder)} (${use})`, account: acct };
  }
  const r = resolvePath(tree, batch.folder);
  if (r.folder) {
    const problem = moveDestinationProblem(tree, r.folder);
    if (problem) {
      throw new FolderRuleError("forbidden_folder", `destination is ${problem}`);
    }
    if (tree.byId.get(r.folder.id)?.depth > 2) throw new FolderRuleError("too_deep", "destination is deeper than two levels");
    return { accountId, folderId: r.folder.id, create: null, label: pathLabel(tree, r.folder), account: acct };
  }
  if (!batch.createFolder) {
    throw new FolderRuleError("folder_not_found", "destination folder does not exist (set create_folder to create it)");
  }
  if (batch.folder.length > APPROVAL_LIMITS.maxCreateDepth) {
    throw new FolderRuleError("too_deep", `new folders may be at most ${APPROVAL_LIMITS.maxCreateDepth} levels below the account root`);
  }
  if (!r.create.every(isValidFolderName)) {
    throw new FolderRuleError("invalid_name", "a new folder name is not allowed");
  }
  const problem = creatableParentProblem(tree, r.parent);
  if (problem) {
    throw new FolderRuleError("forbidden_folder", `cannot create a folder in ${problem}`);
  }
  const base = r.parent.id === tree.root.id ? acct : pathLabel(tree, r.parent);
  return {
    accountId,
    folderId: null,
    create: { parentId: r.parent.id, names: r.create },
    label: [base, ...r.create].join(" › "),
    account: acct,
  };
}

export async function planCleanup(api, input) {
  const batches = [];
  for (const b of input.batches) {
    const snaps = [];
    for (const id of b.messageIds) {
      snaps.push(await snapshotMessage(api, id));
    }
    const accounts = [...new Set(snaps.map(s => s.accountId))];
    if (b.action === "move" && accounts.length !== 1) {
      throw new FolderRuleError("mixed_accounts", "a move batch must contain messages of one account only");
    }
    const dests = {};
    for (const acct of accounts) {
      dests[acct] = await planDestination(api, b, acct, snaps);
    }
    for (const s of snaps) {
      const d = dests[s.accountId];
      s.skip = d.folderId && s.folderId === d.folderId ? "already there" : null;
    }
    batches.push({ action: b.action, reason: b.reason, snaps, dests });
  }

  const binding = batches.map(b => ({
    action: b.action,
    items: b.snaps.map(s => [s.id, s.key, s.folderId]),
    dests: Object.values(b.dests).map(d => [d.accountId, d.folderId, d.create]),
  }));

  const view = {
    kind: "cleanup",
    batches: batches.map((b, index) => ({
      index,
      action: b.action,
      reason: b.reason,
      total: b.snaps.length,
      skipped: b.snaps.filter(s => s.skip).length,
      destinations: Object.values(b.dests).map(d => ({ account: d.account, label: d.label, creates: d.create ? d.create.names : [] })),
      groups: groupBySender(b.snaps.slice(0, MAX_VIEW_ITEMS)).map(g => ({
        sender: g.sender,
        count: g.items.length,
        items: g.items.map(s => ({
          id: s.id,
          subject: s.subject,
          date: s.date,
          where: s.folderName,
          skip: s.skip,
        })),
      })),
    })),
  };

  function readDecision(decision) {
    const list = decisionList(decision, "batches", batches.length);
    return list.map((d, i) => {
      const ids = new Set(batches[i].snaps.filter(s => !s.skip).map(s => s.id));
      const excluded = d.excluded === undefined ? [] : d.excluded;
      if (!Array.isArray(excluded) || excluded.length > ids.size || new Set(excluded).size !== excluded.length) {
        throw new DecisionError("decision does not match the request");
      }
      for (const id of excluded) {
        if (!ids.has(id)) throw new DecisionError("decision does not match the request");
      }
      return { approved: d.approved, excluded: new Set(excluded) };
    });
  }

  /** Creates the planned folders (after the click) and returns a validated destination id. */
  async function destinationNow(batch, d, created) {
    if (batch.action !== "move") {
      const folder = await specialFolderOf(api, d.accountId, SPECIAL_FOR[batch.action]);
      return folder && folder.id === d.folderId ? folder.id : null;
    }

    let tree = await loadTree(api, d.accountId);
    let targetId = d.folderId;
    if (d.create) {
      const parentNode = tree.byId.get(d.create.parentId);
      if (!parentNode || parentNode.depth + d.create.names.length > 2 || creatableParentProblem(tree, parentNode.folder)) {
        return null;
      }
      let parent = parentNode.folder;
      for (const name of d.create.names) {
        const existing = childNamed(tree, parent.id, name);
        if (creatableParentProblem(tree, parent)) return null;
        if (existing && moveDestinationProblem(tree, existing.folder)) return null;
        parent = existing ? existing.folder : await api.folders.create(parent.id, name);
        if (!parent) return null;
        tree = await loadTree(api, d.accountId);
      }
      targetId = parent.id;
    }
    const target = tree.byId.get(targetId);
    const ok = target && target.depth <= 2 && !moveDestinationProblem(tree, target.folder) ? target.folder.id : null;
    created.set(d.accountId, ok);
    return ok;
  }

  async function execute(decision) {
    const choices = readDecision(decision);
    const results = [];
    for (const [i, b] of batches.entries()) {
      const c = choices[i];
      const r = { action: b.action, approved: c.approved, moved: 0, excluded: 0, skipped: 0, failed: 0 };
      results.push(r);
      if (!c.approved) continue;
      r.excluded = c.excluded.size;
      r.skipped = b.snaps.filter(s => s.skip).length;
      const todo = b.snaps.filter(s => !s.skip && !c.excluded.has(s.id));
      const created = new Map();
      for (const d of Object.values(b.dests)) {
        const mine = todo.filter(s => s.accountId === d.accountId);
        if (!mine.length) continue;
        let destId = null;
        try {
          destId = await destinationNow(b, d, created);
        } catch (e) {
          console.error("draftsafe: approved destination could not be prepared", e);
          destId = null;
        }
        if (!destId) {
          r.failed += mine.length;
          continue;
        }
        const verified = [];
        for (const s of mine) {
          if (s.folderId !== destId && (await stillSame(api, s))) verified.push(s.id);
          else r.failed++;
        }
        for (const part of chunks(verified)) {
          try {
            if (await destinationNow(b, d, created) !== destId) throw new Error("destination changed");
            for (const id of part) if (!(await stillSame(api, b.snaps.find(s => s.id === id)))) throw new Error("message changed");
            await api.messages.move(part, destId);
            r.moved += part.length;
          } catch (e) {
            console.error("draftsafe: approved move failed", e);
            r.failed += part.length;
          }
        }
      }
    }
    return { batches: results };
  }

  return { binding, view, execute, readDecision };
}
