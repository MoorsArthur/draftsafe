// SPDX-License-Identifier: MIT
// Helpers shared by the approval planners.

import { FolderRuleError } from "./tree.js";

export const MOVE_CHUNK = 100;
const MAX_SUBJECT = 300;

/** "Alice <a@x.test>" -> "a@x.test"; falls back to the whole (trimmed) author. */
export function senderAddress(author) {
  const s = String(author || "").trim();
  const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(s) || /^([^\s<>]+@[^\s<>]+)$/.exec(s);
  return (m ? m[1] : s || "(unknown sender)").toLowerCase().slice(0, 320);
}

export function iso(d) {
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Snapshot of a message as the user will see it in the approval window.
 * Everything that is executed later is re-checked against this snapshot.
 */
export async function snapshotMessage(api, id) {
  let h = null;
  try {
    h = await api.messages.get(id);
  } catch {
    h = null;
  }
  if (!h || !h.folder || !h.folder.id || !h.folder.accountId || !h.headerMessageId) {
    throw new FolderRuleError("not_found", "a message id is unknown; ids change after a move or restart, search again");
  }
  return {
    id,
    headerMessageId: h.headerMessageId,
    key: `${h.folder.accountId}|${h.headerMessageId}`,
    folderId: h.folder.id,
    folderPath: h.folder.path || "",
    folderName: h.folder.name || "",
    folderUses: Array.isArray(h.folder.specialUse) ? h.folder.specialUse : [],
    accountId: h.folder.accountId,
    author: String(h.author || "").slice(0, 320),
    sender: senderAddress(h.author),
    subject: String(h.subject || "").slice(0, MAX_SUBJECT),
    date: iso(h.date),
    junk: h.junk === true,
  };
}

/** True if the message is still the one that was shown, in the same folder. */
export async function stillSame(api, snap) {
  try {
    const h = await api.messages.get(snap.id);
    return !!h && h.headerMessageId === snap.headerMessageId && !!h.folder && h.folder.id === snap.folderId && h.folder.accountId === snap.accountId &&
      String(h.author || "").slice(0, 320) === snap.author && String(h.subject || "").slice(0, MAX_SUBJECT) === snap.subject;
  } catch {
    return false;
  }
}

/** Groups snapshots by sender address, largest group first. */
export function groupBySender(snaps) {
  const groups = new Map();
  for (const s of snaps) {
    if (!groups.has(s.sender)) groups.set(s.sender, []);
    groups.get(s.sender).push(s);
  }
  return [...groups.entries()]
    .map(([sender, items]) => ({ sender, items: items.sort((a, b) => String(b.date).localeCompare(String(a.date))) }))
    .sort((a, b) => b.items.length - a.items.length || a.sender.localeCompare(b.sender));
}

export function chunks(list, size = MOVE_CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export class DecisionError extends Error {}

export function decisionList(decision, key, length) {
  if (!decision || typeof decision !== "object" || !Array.isArray(decision[key]) || decision[key].length !== length) {
    throw new DecisionError("decision does not match the request");
  }
  return decision[key].map(d => {
    if (!d || typeof d !== "object" || typeof d.approved !== "boolean") {
      throw new DecisionError("decision does not match the request");
    }
    return d;
  });
}
