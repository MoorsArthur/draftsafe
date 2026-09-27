// SPDX-License-Identifier: MIT
// Mail operations exposed through the bridge. Read operations plus the four
// permitted mutations: tags, read/unread, snooze (via features/snooze.js) and
// saving a NEW draft. Nothing in this file sends, forwards or deletes mail.

import { FOLLOWUP_TAG_KEY } from "../lib/constants.js";
import { abortList, queryAll, summarizeFolder, summarizeHeader } from "../lib/mail.js";
import {
  normalizeSubject,
  parseMessageIds,
  prependToHtmlBody,
  stripHtml,
  textToHtml,
  truncate,
} from "../lib/text.js";
import { BridgeError } from "./validate.js";

const SPECIAL_USES = ["inbox", "drafts", "sent", "trash", "templates", "archives", "junk", "outbox"];
const CURSOR_TTL_MS = 10 * 60 * 1000;
const MAX_CURSORS = 16;
const MAX_FOLDERS = 1000;
const THREAD_MAX_REFS = 30;
const THREAD_MAX_CANDIDATES = 80;

function randomId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

export function createMailOps({ api, now = () => Date.now() }) {
  const cursors = new Map();

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
    try {
      if (api.messages.getHeaders) {
        return (await api.messages.getHeaders(id)) || {};
      }
      const full = await api.messages.getFull(id, { decodeContent: true });
      return (full && full.headers) || {};
    } catch {
      return {};
    }
  }

  function pickHeaders(all) {
    const out = {};
    for (const name of ["message-id", "in-reply-to", "references", "reply-to", "list-id", "date"]) {
      if (all[name]) {
        out[name] = all[name];
      }
    }
    return out;
  }

  async function bodyText(id) {
    let parts = [];
    try {
      parts = (await api.messages.listInlineTextParts(id)) || [];
    } catch {
      parts = [];
    }
    const plain = parts.find(p => /^text\/plain/i.test(p.contentType));
    if (plain) {
      return { text: plain.content || "", sourceType: "text/plain" };
    }
    const html = parts.find(p => /^text\/html/i.test(p.contentType));
    if (!html) {
      return { text: "", sourceType: null };
    }
    let text = null;
    if (api.messengerUtilities && api.messengerUtilities.convertToPlainText) {
      try {
        text = await api.messengerUtilities.convertToPlainText(html.content || "");
      } catch {
        text = null;
      }
    }
    return { text: text ?? stripHtml(html.content || ""), sourceType: "text/html" };
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
        throw new BridgeError("not_found", `no ${folder} folder found`, 404);
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

    async search(p) {
      sweepCursors();
      let state;
      if (p.cursor) {
        state = cursors.get(p.cursor);
        cursors.delete(p.cursor);
        if (!state) {
          throw new BridgeError("cursor_expired", "cursor expired or unknown; run the search again");
        }
      } else {
        const q = { messagesPerPage: Math.max(p.limit, 25) };
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
        if (folderIds) {
          q.folderId = folderIds;
          if (p.includeSubFolders) q.includeSubFolders = true;
        }
        const first = await api.messages.query(q);
        state = { buffer: [...(first.messages || [])], listId: first.id || null };
      }
      while (state.buffer.length < p.limit + 1 && state.listId) {
        const page = await api.messages.continueList(state.listId);
        state.buffer.push(...(page.messages || []));
        state.listId = page.id || null;
      }
      const page = state.buffer.splice(0, p.limit);
      let nextCursor = null;
      if (state.buffer.length || state.listId) {
        nextCursor = randomId();
        cursors.set(nextCursor, { ...state, createdAt: now() });
      }
      return { messages: page.map(summarizeHeader), nextCursor };
    },

    async getMessage(id, maxBodyChars) {
      const header = await getMessageHeader(id);
      const [headers, body, attachments] = await Promise.all([
        headersOf(id),
        bodyText(id),
        api.messages.listAttachments(id).catch(() => []),
      ]);
      const { text, truncated } = truncate(body.text, maxBodyChars);
      return {
        message: summarizeHeader(header),
        headers: pickHeaders(headers),
        body: { text, truncated, sourceType: body.sourceType },
        attachments: attachments.map(a => ({
          name: a.name,
          contentType: a.contentType,
          size: a.size,
          partName: a.partName,
        })),
      };
    },

    async getThread(id, includeBodies, maxBodyChars) {
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
        const entry = summarizeHeader(m);
        if (includeBodies) {
          const body = await bodyText(m.id);
          const t = truncate(body.text, maxBodyChars);
          entry.body = { text: t.text, truncated: t.truncated };
        }
        out.push(entry);
      }
      return { messages: out };
    },

    async setTags(ids, add, remove) {
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
        const header = await getMessageHeader(id);
        const tags = new Set(header.tags || []);
        addKeys.forEach(k => tags.add(k));
        removeKeys.forEach(k => tags.delete(k));
        await api.messages.update(id, { tags: [...tags] });
        results.push({ id, tags: [...tags] });
      }
      return { updated: results };
    },

    async markRead(ids, read) {
      for (const id of ids) {
        await getMessageHeader(id);
        await api.messages.update(id, { read });
      }
      return { updated: ids.length, read };
    },

    /**
     * Saves a NEW draft to the Drafts folder. Never sends. Replies go through
     * compose.beginReply() so threading headers and quoting are correct; this
     * briefly opens a compose window, which is closed after saving.
     */
    async createDraft(d) {
      let saved;
      if (d.replyToMessageId) {
        await getMessageHeader(d.replyToMessageId);
        const tab = await api.compose.beginReply(d.replyToMessageId, d.replyAll ? "replyToAll" : "replyToSender");
        const current = await api.compose.getComposeDetails(tab.id);
        const update = {};
        if (current.isPlainText) {
          update.plainTextBody = `${d.body}\n\n${current.plainTextBody || ""}`;
        } else {
          update.body = prependToHtmlBody(current.body || "", `${textToHtml(d.body)}\n<br>\n`);
        }
        if (d.to) update.to = d.to;
        if (d.cc) update.cc = d.cc;
        if (d.bcc) update.bcc = d.bcc;
        if (d.subject) update.subject = d.subject;
        await api.compose.setComposeDetails(tab.id, update);
        saved = await api.compose.saveMessage(tab.id, { mode: "draft" });
        await api.tabs.remove(tab.id);
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
          saved = await api.compose.saveMessage(tab.id, { mode: "draft" });
          await api.tabs.remove(tab.id);
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
