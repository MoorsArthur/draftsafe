// SPDX-License-Identifier: MIT
// The complete bridge surface. Anything not in this table returns 404.
//
// Deliberately absent, and must stay absent: send, send later, forward,
// reply-and-send, delete, move (including snooze), archive, filters,
// contacts, account settings. The add-on's manifest does not even hold the
// permissions those would need; test/bridge-permissions.test.ts and
// test/no-send-surface.test.ts enforce both.

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
  "messages.search",
  "messages.get",
  "messages.thread",
  "messages.setTags",
  "messages.markRead",
  "followups.list",
  "followups.set",
  "drafts.create",
]);

const MAX_BODY_CHARS = 200_000;

export function createRoutes({ ops, version }) {
  const routes = {
    health: async p => {
      onlyKeys(p, []);
      return { ...(await ops.health()), version };
    },

    "accounts.list": async p => {
      onlyKeys(p, []);
      return ops.listAccounts();
    },

    "messages.search": async p => {
      onlyKeys(p, [
        "query", "folder", "accountId", "includeSubFolders", "from", "to", "subject",
        "dateFrom", "dateTo", "unread", "flagged", "tag", "limit", "cursor",
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
      });
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
  };

  // Guard against drift between the table and the declared list.
  const names = Object.keys(routes).sort();
  if (JSON.stringify(names) !== JSON.stringify([...ROUTE_NAMES].sort())) {
    throw new Error("route table does not match ROUTE_NAMES");
  }
  return Object.freeze(routes);
}
