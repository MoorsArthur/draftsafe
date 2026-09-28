// SPDX-License-Identifier: MIT
// Shape of the approval requests an agent can make (via draftsafe-bridge) and
// of the outcomes it gets back. Pure functions, packed into both add-ons: the
// bridge validates before relaying, draftsafe-tools validates again on
// receipt (it is the authority; the bridge copy only fails fast).
//
// A request can only ever DESCRIBE work. There is no field that approves,
// schedules or starts trust, and unknown keys are rejected, so
// e.g. an agent-supplied unsubscribe URL or an "approved: true" flag fails
// validation instead of being ignored.

export const APPROVAL_LIMITS = Object.freeze({
  maxMessages: 2000, // per request, all batches together
  maxBatches: 10,
  maxReasonChars: 500,
  maxUnsubscribeItems: 200,
  maxFolderChanges: 50,
  maxFolderIdChars: 1000,
  maxPathChars: 300,
  maxPathSegments: 8,
  maxCreateDepth: 2,
});

export const CLEANUP_ACTIONS = Object.freeze(["trash", "archive", "move"]);
export const FOLDER_ACTIONS = Object.freeze(["create", "rename", "merge", "delete_empty"]);
export const APPROVAL_KINDS = Object.freeze(["cleanup", "unsubscribe", "folders"]);

// Outcome vocabulary (tools -> bridge -> agent). Everything else is dropped.
export const OUTCOME_STATUSES = Object.freeze(["approved", "denied", "expired", "closed", "failed"]);
export const UNSUBSCRIBE_RESULTS = Object.freeze([
  "unsubscribed", // RFC 8058 POST answered 2xx
  "failed", // POST attempted, no 2xx (or network error)
  "permission_denied", // the user declined the host permission prompt
  "manual", // no one-click unsubscribe; nothing was done
  "excluded", // unticked or denied by the user
]);
export const FOLDER_RESULTS = Object.freeze([
  "done",
  "denied",
  "failed",
  "refused", // re-validation right before acting failed (e.g. no longer empty)
  "kept_not_empty", // merge moved the messages, source kept (subfolders or new mail)
]);

/**
 * Names Draftsafe will create or rename to: letters, digits, space and a few
 * punctuation marks, no slash, no leading dot or space, at most 64 chars.
 */
export const FOLDER_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.,&()+'-]{0,63}$/u;

// Names that look like a special folder. Refused for created or renamed
// folders so nothing can impersonate Trash, Inbox, Junk and so on.
const RESERVED_NAMES = new Set([
  "inbox", "trash", "bin", "deleted items", "deleted messages", "junk", "spam", "sent", "sent items",
  "sent messages", "sent mail", "drafts", "templates", "archive", "archives", "all mail", "outbox",
  "unsent messages", "snoozed", "starred", "important",
]);

export class ApprovalInputError extends Error {
  constructor(message, code = "invalid_params") {
    super(message);
    this.code = code;
  }
}

const bad = message => new ApprovalInputError(message);

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function onlyKeys(obj, allowed, where) {
  if (!isPlainObject(obj)) {
    throw bad(`${where} must be an object`);
  }
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw bad(`unknown parameter "${String(k).slice(0, 40)}" in ${where}`);
    }
  }
}

function reason(v, where, required = true) {
  if (v === undefined || v === null || v === "") {
    if (required) throw bad(`${where}.reason is required`);
    return "";
  }
  if (typeof v !== "string" || v.length > APPROVAL_LIMITS.maxReasonChars) {
    throw bad(`${where}.reason must be a string of at most ${APPROVAL_LIMITS.maxReasonChars} characters`);
  }
  // Control characters (except newlines and tabs) are stripped for display.
  return v.replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "");
}

function positiveInt(v, where) {
  if (!Number.isSafeInteger(v) || v < 1) {
    throw bad(`${where} must be a positive integer message id`);
  }
  return v;
}

export function isValidFolderName(name) {
  return typeof name === "string" && FOLDER_NAME_RE.test(name) && !name.endsWith(" ") && !RESERVED_NAMES.has(name.toLowerCase());
}

function folderName(v, where) {
  if (!isValidFolderName(v)) {
    throw bad(`${where} must be 1-64 letters, digits, spaces or . , _ & ( ) + ' - , must not start with a dot or space, and must not be a special folder name`);
  }
  return v;
}

function folderId(v, where) {
  if (typeof v !== "string" || !v || v.length > APPROVAL_LIMITS.maxFolderIdChars || /[\u0000-\u001f]/.test(v)) {
    throw bad(`${where} must be a folder id from list_folders_detailed or list_accounts`);
  }
  return v;
}

/** "Clients/Acme" -> ["Clients", "Acme"]. Account-relative, no "." or "..". */
export function parseFolderPath(v, where = "folder") {
  if (typeof v !== "string" || !v.trim() || v.length > APPROVAL_LIMITS.maxPathChars) {
    throw bad(`${where} must be an account-relative folder path such as "Newsletters" or "Clients/Acme"`);
  }
  const segments = v.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length > APPROVAL_LIMITS.maxPathSegments) {
    throw bad(`${where} is nested too deeply`);
  }
  for (const s of segments) {
    if (!s || s === "." || s === ".." || s.length > 100 || /[\u0000-\u001f]/.test(s)) {
      throw bad(`${where} contains an invalid path segment`);
    }
  }
  return segments;
}

/**
 * {batches: [{messageIds, action, folder?, createFolder?, reason}]}
 * At most 2000 messages across all batches; no id twice.
 */
export function validateCleanup(payload) {
  onlyKeys(payload, ["batches"], "request");
  const { batches } = payload;
  if (!Array.isArray(batches) || batches.length < 1 || batches.length > APPROVAL_LIMITS.maxBatches) {
    throw bad(`batches must be an array of 1 to ${APPROVAL_LIMITS.maxBatches} batches`);
  }
  const seen = new Set();
  let total = 0;
  const out = batches.map((b, i) => {
    const where = `batches[${i}]`;
    onlyKeys(b, ["messageIds", "action", "folder", "createFolder", "reason"], where);
    if (!CLEANUP_ACTIONS.includes(b.action)) {
      throw bad(`${where}.action must be one of ${CLEANUP_ACTIONS.join(", ")}`);
    }
    if (!Array.isArray(b.messageIds) || b.messageIds.length < 1) {
      throw bad(`${where}.messageIds must be a non-empty array of message ids`);
    }
    total += b.messageIds.length;
    if (total > APPROVAL_LIMITS.maxMessages) {
      throw new ApprovalInputError(
        `at most ${APPROVAL_LIMITS.maxMessages} messages per request; split the work into several requests`,
        "too_many"
      );
    }
    const ids = b.messageIds.map(v => positiveInt(v, `${where}.messageIds[]`));
    for (const id of ids) {
      if (seen.has(id)) throw bad(`message ${id} appears more than once`);
      seen.add(id);
    }
    let folder;
    let createFolder = false;
    if (b.action === "move") {
      folder = parseFolderPath(b.folder, `${where}.folder`);
      if (b.createFolder !== undefined && typeof b.createFolder !== "boolean") {
        throw bad(`${where}.createFolder must be a boolean`);
      }
      createFolder = b.createFolder === true;
    } else if (b.folder !== undefined || b.createFolder !== undefined) {
      throw bad(`${where}: folder and createFolder are only allowed with action "move" (trash and archive use the account's own special folder)`);
    }
    return { action: b.action, messageIds: ids, folder, createFolder, reason: reason(b.reason, where) };
  });
  return { batches: out };
}

/** {items: [{messageId, reason?}]}: no URLs, no addresses; Tools reads the headers itself. */
export function validateUnsubscribe(payload) {
  onlyKeys(payload, ["items"], "request");
  const { items } = payload;
  if (!Array.isArray(items) || items.length < 1 || items.length > APPROVAL_LIMITS.maxUnsubscribeItems) {
    throw new ApprovalInputError(
      `items must be an array of 1 to ${APPROVAL_LIMITS.maxUnsubscribeItems} messages; split larger requests`,
      Array.isArray(items) && items.length > APPROVAL_LIMITS.maxUnsubscribeItems ? "too_many" : "invalid_params"
    );
  }
  const seen = new Set();
  return {
    items: items.map((it, i) => {
      const where = `items[${i}]`;
      onlyKeys(it, ["messageId", "reason"], where);
      const id = positiveInt(it.messageId, `${where}.messageId`);
      if (seen.has(id)) throw bad(`message ${id} appears more than once`);
      seen.add(id);
      return { messageId: id, reason: reason(it.reason, where, false) };
    }),
  };
}

/** {changes: [{action, folder, newName?, into?}]} */
export function validateFolderChanges(payload) {
  onlyKeys(payload, ["changes"], "request");
  const { changes } = payload;
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > APPROVAL_LIMITS.maxFolderChanges) {
    throw bad(`changes must be an array of 1 to ${APPROVAL_LIMITS.maxFolderChanges} changes`);
  }
  const out = changes.map((c, i) => {
    const where = `changes[${i}]`;
    onlyKeys(c, ["action", "folder", "newName", "into"], where);
    if (!FOLDER_ACTIONS.includes(c.action)) {
      throw bad(`${where}.action must be one of ${FOLDER_ACTIONS.join(", ")}`);
    }
    const one = { action: c.action, folder: folderId(c.folder, `${where}.folder`) };
    if (c.action === "create" || c.action === "rename") {
      one.newName = folderName(c.newName, `${where}.newName`);
    } else if (c.newName !== undefined) {
      throw bad(`${where}.newName is only allowed for create and rename`);
    }
    if (c.action === "merge") {
      one.into = folderId(c.into, `${where}.into`);
      if (one.into === one.folder) throw bad(`${where}: a folder cannot be merged into itself`);
    } else if (c.into !== undefined) {
      throw bad(`${where}.into is only allowed for merge`);
    }
    return one;
  });
  // Folder ids change when a folder is renamed or moved, so every existing
  // folder may be referenced by at most one change, and a new folder cannot
  // be created inside a folder that another change of the same request
  // renames, merges or removes. Split such work into several requests.
  const touched = new Set();
  for (const c of out) {
    if (c.action === "create") continue;
    for (const id of c.action === "merge" ? [c.folder, c.into] : [c.folder]) {
      if (touched.has(id)) throw bad("a folder is referenced by more than one change; split the work into several requests");
      touched.add(id);
    }
  }
  const created = new Set();
  for (const c of out) {
    if (c.action !== "create") continue;
    if (touched.has(c.folder)) throw bad("a folder is created inside a folder that another change modifies; split the work into several requests");
    const key = `${c.folder}\n${c.newName.toLowerCase()}`;
    if (created.has(key)) throw bad("the same folder is created twice");
    created.add(key);
  }
  return { changes: out };
}

export const VALIDATORS = Object.freeze({
  cleanup: validateCleanup,
  unsubscribe: validateUnsubscribe,
  folders: validateFolderChanges,
});
