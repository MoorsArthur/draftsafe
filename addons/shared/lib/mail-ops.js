// SPDX-License-Identifier: MIT
// Mail operations exposed through the bridge: reads, approval-gated state
// requests, saved drafts and agent-prepared native compose windows. The
// combined manifest has Send later permission, but this module never sends.

import { FOLLOWUP_TAG_KEY } from "./constants.js";
import { identityForReply, insertAgentText } from "./compose-body.js";
import { createComposeReview } from "./compose-review.js";
import { createAttachmentStage } from "./attachment-stage.js";
import { createFollowupTag } from "./followup-tag.js";
import { findRecipients } from "./recipient-lookup.js";
import { abortList, queryAll, summarizeFolder, summarizeHeader } from "./mail.js";
import { normalizeSubject, parseMessageIds, stripHtml, truncate } from "./text.js";
import { BridgeError, NO_DEADLINE } from "./validate.js";

const SPECIAL_USES = ["inbox", "drafts", "sent", "trash", "templates", "archives", "junk", "outbox"];
const CURSOR_TTL_MS = 10 * 60 * 1000;
const MAX_CURSORS = 16;
const MAX_FOLDERS = 1000;
const MAX_FOLLOWUPS = 500;
const THREAD_MAX_REFS = 30;
const THREAD_MAX_CANDIDATES = 80;
// HTML is cut to this many characters per requested output character before
// conversion, so a huge message cannot make the converter do unbounded work.
const HTML_INPUT_FACTOR = 8;
const MAX_HTML_INPUT = 2_000_000;

function randomId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

export function createMailOps({ api, now = () => Date.now() }) {
  const cursors = new Map();
  const followupTag = createFollowupTag({ api });
  const attachmentStage = createAttachmentStage({ now });
  const composeReview = createComposeReview({ api, stage: attachmentStage });

  function sweepCursors() {
    const t = now();
    for (const [id, c] of cursors) {
      if (t - c.createdAt > CURSOR_TTL_MS) {
        cursors.delete(id);
        abortList(api, c.listId);
      }
    }
    while (cursors.size >= MAX_CURSORS) {
      const [oldest, c] = cursors.entries().next().value;
      cursors.delete(oldest);
      abortList(api, c.listId);
    }
  }

  async function getMessageHeader(id) {
    let header;
    try {
      header = await api.messages.get(id);
    } catch {
      header = null;
    }
    if (!header) {
      throw new BridgeError("not_found", `message ${id} not found (ids are only valid until Thunderbird restarts or the message moves)`, 404);
    }
    return header;
  }

  async function headersOf(id) {
    let raw = {};
    try {
      if (api.messages.getHeaders) {
        raw = (await api.messages.getHeaders(id)) || {};
      } else {
        const full = await api.messages.getFull(id, { decodeContent: true });
        raw = (full && full.headers) || {};
      }
    } catch {
      return {};
    }
    // Normalise to lowercase names with array values, whatever the API returned.
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.map(String) : [String(v)]])
    );
  }

  function fromDomain(header) {
    const address = /@([^<>\s]+)>?\s*$/.exec(String(header.author || ""));
    return address ? address[1].toLowerCase().slice(0, 253) : null;
  }

  function classifyFast(header) {
    return { ...summarizeHeader(header), classificationLoaded: false,
      hasListUnsubscribe: null, listId: null, precedence: null, fromDomain: fromDomain(header) };
  }

  async function classify(header) {
    const h = await headersOf(header.id);
    return { ...summarizeHeader(header), classificationLoaded: true, hasListUnsubscribe: !!h["list-unsubscribe"]?.length,
      listId: (h["list-id"] || [])[0]?.slice(0, 2000) || null,
      precedence: (h.precedence || [])[0]?.slice(0, 100) || null,
      fromDomain: fromDomain(header) };
  }

  function pickHeaders(all) {
    const out = {};
    for (const name of ["message-id", "in-reply-to", "references", "reply-to", "list-id", "precedence", "date"]) {
      if (all[name]) {
        out[name] = all[name].slice(0, 10).map(v => v.slice(0, 2000));
      }
    }
    return out;
  }

  /** Body as plain text, never more than `maxChars` + 1 characters of work output. */
  async function bodyText(id, maxChars) {
    let parts = [];
    try {
      parts = (await api.messages.listInlineTextParts(id)) || [];
    } catch {
      parts = [];
    }
    const plain = parts.find(p => /^text\/plain/i.test(p.contentType));
    if (plain) {
      return { text: String(plain.content || "").slice(0, maxChars + 1), sourceType: "text/plain" };
    }
    const html = parts.find(p => /^text\/html/i.test(p.contentType));
    if (!html) {
      return { text: "", sourceType: null };
    }
    const input = String(html.content || "").slice(0, Math.min(MAX_HTML_INPUT, (maxChars + 1) * HTML_INPUT_FACTOR));
    let text = null;
    if (api.messengerUtilities && api.messengerUtilities.convertToPlainText) {
      try {
        text = await api.messengerUtilities.convertToPlainText(input);
      } catch {
        text = null;
      }
    }
    return { text: (text ?? stripHtml(input)).slice(0, maxChars + 1), sourceType: "text/html" };
  }

  async function resolveFolderIds(folder, accountId) {
    if (!folder) {
      return undefined;
    }
    if (SPECIAL_USES.includes(folder.toLowerCase())) {
      const q = { specialUse: [folder.toLowerCase()] };
      if (accountId) {
        q.accountId = accountId;
      }
      const found = await api.folders.query(q);
      if (!found || !found.length) {
        throw new BridgeError("not_found", `no ${folder.toLowerCase()} folder found`, 404);
      }
      return found.map(f => f.id);
    }
    return [folder];
  }

  function flattenFolders(folder, out) {
    for (const sub of folder.subFolders || []) {
      if (out.length >= MAX_FOLDERS) {
        return;
      }
      out.push(summarizeFolder(sub));
      flattenFolders(sub, out);
    }
  }

  return {
    openComposeForReview: composeReview.open,
    updateComposeForReview: composeReview.update,
    closeComposeForReview: composeReview.close,
    listComposesForReview: composeReview.list,
    beginAttachment: attachmentStage.begin,
    chunkAttachment: attachmentStage.chunk,
    discardAttachment: attachmentStage.discard,
    async health() {
      return { status: "ok" };
    },

    async listAccounts() {
      const accounts = await api.accounts.list(true);
      const tags = await api.messages.tags.list();
      return {
        accounts: accounts.map(a => {
          const folders = [];
          if (a.rootFolder) {
            flattenFolders(a.rootFolder, folders);
          }
          return {
            id: a.id,
            name: a.name,
            type: a.type,
            identities: (a.identities || []).map(i => ({ id: i.id, name: i.name, email: i.email })),
            folders,
          };
        }),
        tags: tags.map(t => ({ key: t.key, label: t.tag, color: t.color })),
      };
    },

    async listFoldersDetailed(accountId, ctx = NO_DEADLINE) {
      const accounts = (await api.accounts.list(true)).filter(a => !accountId || a.id === accountId);
      const folders = [];
      let truncated = false;
      async function visit(folder) {
        if (folders.length >= MAX_FOLDERS) { truncated = true; return; }
        ctx.check();
        let info = {};
        try { info = await api.folders.getFolderInfo(folder.id); } catch { /* root */ }
        // Folder counts are metadata. Enumerating every message for date extrema
        // made this route scale with the entire mailbox and regularly timed out.
        folders.push({ ...summarizeFolder(folder), count: info.totalMessageCount ?? null,
          unread: info.unreadMessageCount ?? null, oldest: null, newest: null,
          subfolders: (folder.subFolders || []).map(f => f.id) });
        for (const sub of folder.subFolders || []) await visit(sub);
      }
      for (const a of accounts) if (a.rootFolder) await visit(a.rootFolder);
      return { folders, truncated };
    },

    async search(p, ctx = NO_DEADLINE) {
      ctx.check();
      sweepCursors();
      let state;
      if (p.cursor) {
        state = cursors.get(p.cursor);
        cursors.delete(p.cursor);
        if (!state) {
          throw new BridgeError("cursor_expired", "cursor expired or unknown; run the search again");
        }
      } else {
        const q = { messagesPerPage: p.limit, autoPaginationTimeout: 400 };
        if (p.query) q.fullText = p.query;
        if (p.from) q.author = p.from;
        if (p.to) q.recipients = p.to;
        if (p.subject) q.subject = p.subject;
        if (p.dateFrom) q.fromDate = p.dateFrom;
        if (p.dateTo) q.toDate = p.dateTo;
        if (p.unread !== undefined) q.unread = p.unread;
        if (p.flagged !== undefined) q.flagged = p.flagged;
        if (p.tag) q.tags = { mode: "all", tags: { [p.tag]: true } };
        if (p.accountId) q.accountId = p.accountId;
        const folderIds = await resolveFolderIds(p.folder, p.accountId);
        ctx.check();
        if (folderIds) {
          q.folderId = folderIds;
          if (p.includeSubFolders) q.includeSubFolders = true;
        }
        const first = await api.messages.query(q);
        ctx.check();
        state = { buffer: [...(first.messages || [])], listId: first.id || null,
          fast: p.fast || false, limit: p.limit };
      }
      if (!state.buffer.length && state.listId) {
        const next = await api.messages.continueList(state.listId);
        ctx.check();
        state.buffer.push(...(next.messages || []));
        state.listId = next.id || null;
      }
      const page = state.buffer.splice(0, state.limit);
      let nextCursor = null;
      if (state.buffer.length || state.listId) {
        nextCursor = randomId();
        cursors.set(nextCursor, { ...state, createdAt: now() });
      }
      const messages = state.fast ? page.map(classifyFast) : await Promise.all(page.map(classify));
      ctx.check();
      return { messages, nextCursor, complete: !nextCursor };
    },

    findRecipients(query, limit, ctx = NO_DEADLINE) {
      return findRecipients({ api, query, limit, now, ctx });
    },

    async getMessage(id, maxBodyChars) {
      const header = await getMessageHeader(id);
      const [headers, body, attachments] = await Promise.all([
        headersOf(id),
        bodyText(id, maxBodyChars),
        api.messages.listAttachments(id).catch(() => []),
      ]);
      const { text, truncated } = truncate(body.text, maxBodyChars);
      return {
        message: await classify(header),
        headers: pickHeaders(headers),
        body: { text, truncated, sourceType: body.sourceType },
        attachments: attachments.slice(0, 100).map(a => ({
          name: String(a.name || "").slice(0, 500),
          contentType: a.contentType,
          size: a.size,
          partName: a.partName,
        })),
      };
    },

    async getThread(id, includeBodies, maxBodyChars, ctx = NO_DEADLINE) {
      const root = await getMessageHeader(id);
      const accountId = root.folder ? root.folder.accountId : undefined;
      const rootHeaders = await headersOf(id);
      const known = new Set([root.headerMessageId]);
      for (const ref of parseMessageIds([...(rootHeaders.references || []), ...(rootHeaders["in-reply-to"] || [])])) {
        known.add(ref);
      }
      const found = new Map([[root.id, root]]);

      // Ancestors named in References / In-Reply-To.
      for (const ref of [...known].slice(0, THREAD_MAX_REFS)) {
        if (ref === root.headerMessageId) continue;
        ctx.check();
        const q = { headerMessageId: ref };
        if (accountId) q.accountId = accountId;
        for (const m of await queryAll(api, q, 5)) found.set(m.id, m);
      }

      // Replies and siblings: same normalized subject, linked by headers.
      const base = normalizeSubject(root.subject);
      if (base) {
        const q = { subject: base };
        if (accountId) q.accountId = accountId;
        const candidates = (await queryAll(api, q, THREAD_MAX_CANDIDATES)).filter(m => !found.has(m.id));
        const linkCache = new Map();
        for (let pass = 0; pass < 2; pass++) {
          for (const c of candidates) {
            if (found.has(c.id)) continue;
            ctx.check();
            if (!linkCache.has(c.id)) {
              const h = await headersOf(c.id);
              linkCache.set(c.id, parseMessageIds([...(h.references || []), ...(h["in-reply-to"] || [])]));
            }
            const links = linkCache.get(c.id);
            if (known.has(c.headerMessageId) || links.some(l => known.has(l))) {
              found.set(c.id, c);
              known.add(c.headerMessageId);
            }
          }
        }
      }

      const messages = [...found.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
      const out = [];
      for (const m of messages) {
        const entry = await classify(m);
        if (includeBodies) {
          ctx.check();
          const body = await bodyText(m.id, maxBodyChars);
          const t = truncate(body.text, maxBodyChars);
          entry.body = { text: t.text, truncated: t.truncated };
        }
        out.push(entry);
      }
      return { messages: out };
    },

    async setTags(ids, add, remove, ctx = NO_DEADLINE) {
      const known = await api.messages.tags.list();
      const resolve = name => {
        const lower = name.toLowerCase();
        const t = known.find(k => k.key === lower || k.tag.toLowerCase() === lower);
        if (!t) {
          throw new BridgeError("unknown_tag", `tag "${name}" does not exist (list_accounts shows available tags)`);
        }
        return t.key;
      };
      const addKeys = (add || []).map(resolve);
      const removeKeys = (remove || []).map(resolve);
      if (addKeys.includes(FOLLOWUP_TAG_KEY) || removeKeys.includes(FOLLOWUP_TAG_KEY)) {
        throw new BridgeError("use_followup", "use set_followup for the Follow up tag");
      }
      const results = [];
      for (const id of ids) {
        ctx.check();
        const header = await getMessageHeader(id);
        const tags = new Set(header.tags || []);
        addKeys.forEach(k => tags.add(k));
        removeKeys.forEach(k => tags.delete(k));
        await api.messages.update(id, { tags: [...tags] });
        results.push({ id, tags: [...tags] });
      }
      return { updated: results };
    },

    async markRead(ids, read, ctx = NO_DEADLINE) {
      let updated = 0;
      for (const id of ids) {
        ctx.check();
        await getMessageHeader(id);
        await api.messages.update(id, { read });
        updated++;
      }
      return { updated, read };
    },

    async listFollowups() {
      const { messages, truncated } = await followupTag.listTagged(MAX_FOLLOWUPS);
      return { followups: messages.map(summarizeHeader), truncated };
    },

    async setFollowup(id, open) {
      await getMessageHeader(id);
      try {
        if (open) {
          await followupTag.add(id);
        } else {
          await followupTag.remove(id);
        }
      } catch {
        throw new BridgeError("not_taggable", `message ${id} cannot be tagged`);
      }
      return { messageId: id, open };
    },

    /**
     * Saves a NEW draft to the Drafts folder. This route uses save APIs only;
     * Send later elsewhere in the combined add-on has send permission.
     *
     * New drafts use messages.saveMessage (Thunderbird 153+, no window).
     * Reply drafts use compose.beginReply so Thunderbird sets threading,
     * identity, signature and quote. Add agent text above the body Thunderbird
     * built, then close the compose window after saving.
     */
    async createDraft(d) {
      let saved;
      if (d.replyToMessageId) {
        const original = await getMessageHeader(d.replyToMessageId);
        const details = {
          identityId: await identityForReply(api, original),
        };
        if (d.to) details.to = d.to;
        if (d.cc) details.cc = d.cc;
        if (d.bcc) details.bcc = d.bcc;
        if (d.subject) details.subject = d.subject;
        const tab = await api.compose.beginReply(d.replyToMessageId, d.replyAll ? "replyToAll" : "replyToSender", details);
        try {
          await insertAgentText(api, tab.id, d.body);
          saved = await api.compose.saveMessage(tab.id, { mode: "draft" });
        } finally {
          await api.tabs.remove(tab.id).catch(() => {});
        }
      } else {
        const details = {
          to: d.to || [],
          cc: d.cc || [],
          bcc: d.bcc || [],
          subject: d.subject || "",
          plainTextBody: d.body,
          isPlainText: true,
        };
        if (d.identityId) details.identityId = d.identityId;
        if (api.messages.saveMessage) {
          // Thunderbird 153+: saves in the background, no window.
          saved = await api.messages.saveMessage(details, { mode: "draft" });
        } else {
          const tab = await api.compose.beginNew(undefined, details);
          try {
            saved = await api.compose.saveMessage(tab.id, { mode: "draft" });
          } finally {
            await api.tabs.remove(tab.id).catch(() => {});
          }
        }
      }
      const draft = saved && saved.messages && saved.messages[0];
      return {
        saved: true,
        sent: false,
        draft: draft ? summarizeHeader(draft) : null,
        note: "Saved to Drafts. Nothing was sent; the user must review and send it in Thunderbird.",
      };
    },
  };
}
