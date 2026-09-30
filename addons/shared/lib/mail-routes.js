// SPDX-License-Identifier: MIT
// The complete bridge surface. Anything not in this table returns 404.
//
// Deliberately absent: send, send later, forward, reply-and-send, permanent
// delete, direct move/snooze/archive, filters, contact writes and account settings.
// The combined manifest has some of these permissions for approved changes
// and user-only Send later, so route allowlisting is the MCP boundary.

import {
  BridgeError,
  NO_DEADLINE,
  messageId,
  messageIds,
  onlyKeys,
  optBool,
  optDate,
  optInt,
  optString,
  optStringList,
  reqString,
} from "./validate.js";

export const ROUTE_NAMES = Object.freeze([
  "health",
  "accounts.list",
  "folders.detailed",
  "messages.search",
  "recipients.find",
  "messages.get",
  "messages.thread",
  "messages.setTags",
  "messages.markRead",
  "followups.list",
  "followups.set",
  "drafts.create",
  "compose.openForReview",
  "compose.updateForReview",
  "compose.closeForReview",
  "compose.listForReview",
  "attachments.begin",
  "attachments.chunk",
  "attachments.discard",
]);

const MAX_BODY_CHARS = 200_000;
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function recipients(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 ||
      !value.every(address => typeof address === "string" && address.length <= 320 && ADDRESS.test(address)))
    throw new BridgeError("invalid_params", "to must contain 1 to 20 plain email addresses", 400);
  return value;
}

function subject(value) {
  const text = reqString({ subject: value }, "subject", 300);
  if (/[\x00-\x1f\x7f]/.test(text)) throw new BridgeError("invalid_params", "subject must be a single line", 400);
  return text;
}

function attachmentSpecs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new BridgeError("invalid_params", "At most 100 attachments are allowed.", 400);
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new BridgeError("invalid_params", "Invalid attachment.", 400);
    if (Object.keys(item).length === 1 && /^[a-f0-9]{32}$/.test(item.stagedToken || ""))
      return { stagedToken: item.stagedToken };
    if (Object.keys(item).length === 2 && Number.isSafeInteger(item.messageId) && item.messageId > 0 &&
        typeof item.partName === "string" && item.partName.length > 0 && item.partName.length <= 200 &&
        !/[\x00-\x1f\x7f]/.test(item.partName))
      return { messageId: item.messageId, partName: item.partName };
    throw new BridgeError("invalid_params", "Attachment must be a staged file or an email message ID and part name.", 400);
  });
}

export function createRoutes({ ops, version }) {
  const routes = {
    health: async p => {
      onlyKeys(p, []);
      return { ...(await ops.health()), version, protocol: 1 };
    },

    "accounts.list": async p => {
      onlyKeys(p, []);
      return ops.listAccounts();
    },

    "folders.detailed": async (p, ctx = NO_DEADLINE) => {
      onlyKeys(p, ["accountId"]);
      return ops.listFoldersDetailed(optString(p, "accountId", 100), ctx);
    },

    "messages.search": async (p, ctx = NO_DEADLINE) => {
      onlyKeys(p, [
        "query", "folder", "accountId", "includeSubFolders", "from", "to", "subject",
        "dateFrom", "dateTo", "unread", "flagged", "tag", "limit", "cursor", "fast",
      ]);
      return ops.search({
        query: optString(p, "query", 500),
        folder: optString(p, "folder", 500),
        accountId: optString(p, "accountId", 100),
        includeSubFolders: optBool(p, "includeSubFolders"),
        from: optString(p, "from", 320),
        to: optString(p, "to", 1000),
        subject: optString(p, "subject", 500),
        dateFrom: optDate(p, "dateFrom"),
        dateTo: optDate(p, "dateTo"),
        unread: optBool(p, "unread"),
        flagged: optBool(p, "flagged"),
        tag: optString(p, "tag", 100),
        limit: optInt(p, "limit", 1, 100, 25),
        cursor: optString(p, "cursor", 64),
        fast: optBool(p, "fast"),
      }, ctx);
    },

    "recipients.find": async (p, ctx = NO_DEADLINE) => {
      onlyKeys(p, ["query", "limit"]);
      const query = reqString(p, "query", 100).trim();
      if (query.length < 2 || /[\x00-\x1f\x7f]/.test(query))
        throw new BridgeError("invalid_params", "query must contain 2 to 100 printable characters", 400);
      return ops.findRecipients(query, optInt(p, "limit", 1, 20, 10), ctx);
    },

    "messages.get": async p => {
      onlyKeys(p, ["messageId", "maxBodyChars"]);
      return ops.getMessage(messageId(p.messageId), optInt(p, "maxBodyChars", 100, MAX_BODY_CHARS, 20_000));
    },

    "messages.thread": async (p, ctx = NO_DEADLINE) => {
      onlyKeys(p, ["messageId", "includeBodies", "maxBodyChars"]);
      return ops.getThread(
        messageId(p.messageId),
        optBool(p, "includeBodies") || false,
        optInt(p, "maxBodyChars", 100, 50_000, 4_000),
        ctx
      );
    },

    "messages.setTags": async (p, ctx = NO_DEADLINE) => {
      onlyKeys(p, ["messageId", "messageIds", "add", "remove"]);
      const add = optStringList(p, "add", 20, 100);
      const remove = optStringList(p, "remove", 20, 100);
      if (!add && !remove) {
        throw new BridgeError("invalid_params", "give add and/or remove");
      }
      return ops.setTags(messageIds(p), add, remove, ctx);
    },

    "messages.markRead": async (p, ctx = NO_DEADLINE) => {
      onlyKeys(p, ["messageId", "messageIds", "read"]);
      const read = optBool(p, "read");
      return ops.markRead(messageIds(p), read === undefined ? true : read, ctx);
    },

    "followups.list": async p => {
      onlyKeys(p, []);
      return ops.listFollowups();
    },

    "followups.set": async p => {
      onlyKeys(p, ["messageId", "done"]);
      return ops.setFollowup(messageId(p.messageId), !optBool(p, "done"));
    },

    "drafts.create": async p => {
      onlyKeys(p, ["to", "cc", "bcc", "subject", "body", "replyToMessageId", "replyAll", "identityId"]);
      const replyTo = p.replyToMessageId === undefined ? undefined : messageId(p.replyToMessageId, "replyToMessageId");
      const draft = {
        to: optStringList(p, "to", 50, 320),
        cc: optStringList(p, "cc", 50, 320),
        bcc: optStringList(p, "bcc", 50, 320),
        subject: optString(p, "subject", 998),
        body: reqString(p, "body", 100_000),
        replyToMessageId: replyTo,
        replyAll: optBool(p, "replyAll") || false,
        identityId: optString(p, "identityId", 100),
      };
      if (draft.subject && /[\r\n]/.test(draft.subject)) {
        throw new BridgeError("invalid_params", "subject must be a single line");
      }
      if (!replyTo && !draft.to && !draft.cc && !draft.bcc && !draft.subject) {
        throw new BridgeError("invalid_params", "a new draft needs at least a recipient or a subject");
      }
      return ops.createDraft(draft);
    },

    "compose.openForReview": async p => {
      onlyKeys(p, ["to", "subject", "body", "replyToMessageId", "identityId", "attachments", "newWindow"]);
      if (p.newWindow !== undefined && typeof p.newWindow !== "boolean")
        throw new BridgeError("invalid_params", "newWindow must be a boolean", 400);
      const body = reqString(p, "body", 100_000);
      if (body.includes("\0")) throw new BridgeError("invalid_params", "body contains an invalid character", 400);
      const attachments = attachmentSpecs(p.attachments);
      const replyToMessageId = p.replyToMessageId === undefined ? undefined : messageId(p.replyToMessageId, "replyToMessageId");
      if (replyToMessageId !== undefined) {
        if (p.to !== undefined || p.subject !== undefined || p.identityId !== undefined)
          throw new BridgeError("invalid_params", "reply input cannot override recipients, subject or identity", 400);
        return ops.openComposeForReview({ replyToMessageId, body, attachments, newWindow: p.newWindow });
      }
      const to = recipients(p.to);
      const title = subject(p.subject);
      const identityId = optString(p, "identityId", 100);
      if (identityId !== undefined && (!identityId || /[\x00-\x1f\x7f]/.test(identityId)))
        throw new BridgeError("invalid_params", "invalid sender identity", 400);
      return ops.openComposeForReview({ to, subject: title, body, identityId, attachments, newWindow: p.newWindow });
    },

    "compose.updateForReview": async p => {
      onlyKeys(p, ["tabId", "body", "to", "subject", "attachments", "removeAttachmentIds"]);
      const tabId = optInt(p, "tabId", 1, Number.MAX_SAFE_INTEGER);
      const body = reqString(p, "body", 100_000);
      if (body.includes("\0")) throw new BridgeError("invalid_params", "body contains an invalid character", 400);
      const remove = p.removeAttachmentIds;
      if (remove !== undefined && (!Array.isArray(remove) || remove.length > 100 ||
          !remove.every(id => Number.isSafeInteger(id) && id > 0) || new Set(remove).size !== remove.length))
        throw new BridgeError("invalid_params", "Invalid attachment IDs.", 400);
      return ops.updateComposeForReview({ tabId, body,
        to: p.to === undefined ? undefined : recipients(p.to),
        subject: p.subject === undefined ? undefined : subject(p.subject),
        attachments: attachmentSpecs(p.attachments), removeAttachmentIds: remove });
    },
    "compose.closeForReview": async p => {
      onlyKeys(p, ["tabId"]);
      return ops.closeComposeForReview({ tabId: optInt(p, "tabId", 1, Number.MAX_SAFE_INTEGER) });
    },
    "compose.listForReview": async p => {
      onlyKeys(p, []);
      return ops.listComposesForReview();
    },
    "attachments.begin": async p => {
      onlyKeys(p, ["name", "size", "type"]);
      return ops.beginAttachment(p);
    },
    "attachments.chunk": async p => {
      onlyKeys(p, ["token", "offset", "data"]);
      return ops.chunkAttachment(p);
    },
    "attachments.discard": async p => {
      onlyKeys(p, ["token"]);
      return ops.discardAttachment(p);
    },
  };

  // Guard against drift between the table and the declared list.
  const names = Object.keys(routes).sort();
  if (JSON.stringify(names) !== JSON.stringify([...ROUTE_NAMES].sort())) {
    throw new Error("route table does not match ROUTE_NAMES");
  }
  return Object.freeze(routes);
}
