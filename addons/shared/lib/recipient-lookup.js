// SPDX-License-Identifier: MIT
// Read-only recipient suggestions from local contacts and bounded Sent mail.

import { abortList } from "./mail.js";

const EMAIL = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
const SENT_DAYS = 365;
const MAX_SENT_PAGES = 3;
const MAX_SENT_MESSAGES = 300;
const MAX_CONTACTS = 100;

function mailbox(value) {
  const text = String(value || "").trim();
  const angle = /^(.*?)<([^<>]+)>$/.exec(text);
  const email = (angle ? angle[2] : text).trim();
  if (email.length > 320 || !EMAIL.test(email)) return null;
  const name = angle ? angle[1].trim().replace(/^"|"$/g, "").slice(0, 200) : "";
  return { name, email: email.toLowerCase() };
}

export async function findRecipients({ api, query, limit, now = () => Date.now(), ctx }) {
  const wanted = query.toLowerCase();
  const found = new Map();
  function add(name, email, source) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (cleanEmail.length > 320 || !EMAIL.test(cleanEmail)) return;
    const parsed = { name: String(name || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 200),
      email: cleanEmail };
    if (!(parsed.name.toLowerCase().includes(wanted) || parsed.email.includes(wanted))) return;
    const existing = found.get(parsed.email);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (!existing.name && parsed.name) existing.name = parsed.name;
    } else {
      found.set(parsed.email, { ...parsed, sources: [source] });
    }
  }

  const contactsEnabled = !!api.permissions?.contains &&
    await api.permissions.contains({ permissions: ["addressBooks"] }).catch(() => false);
  let contactsSearched = false;
  let contactsTruncated = false;
  if (contactsEnabled && api.contacts?.quickSearch) {
    try {
      ctx.check();
      const contacts = await api.contacts.quickSearch({ searchString: query, includeRemote: false });
      ctx.check();
      contactsSearched = true;
      contactsTruncated = contacts.length > MAX_CONTACTS;
      for (const contact of contacts.slice(0, MAX_CONTACTS)) {
        if (contact.remote) continue;
        const props = contact.properties || {};
        const name = String(props.DisplayName || [props.FirstName, props.LastName].filter(Boolean).join(" ")).slice(0, 200);
        for (const email of [props.PrimaryEmail, props.SecondEmail]) if (email) add(name, email, "contacts");
      }
    } catch {
      contactsSearched = false;
    }
  }

  const sentFolders = await api.folders.query({ specialUse: ["sent"] });
  let listId = null;
  let sentScanned = 0;
  let sentTruncated = false;
  if (sentFolders.length) {
    const info = { folderId: sentFolders.map(folder => folder.id),
      fromDate: new Date(now() - SENT_DAYS * 24 * 60 * 60 * 1000),
      messagesPerPage: 100, autoPaginationTimeout: 400 };
    if (!wanted.includes("@") || EMAIL.test(wanted)) info.recipients = query;
    try {
      let page = await api.messages.query(info);
      for (let index = 0; index < MAX_SENT_PAGES; index++) {
        ctx.check();
        for (const message of page.messages || []) {
          if (sentScanned++ >= MAX_SENT_MESSAGES) { sentTruncated = true; break; }
          for (const recipient of [...(message.recipients || []), ...(message.ccList || [])]) {
            const parsed = mailbox(recipient);
            if (parsed) add(parsed.name, parsed.email, "sent_mail");
          }
        }
        listId = page.id || null;
        if (!listId || sentTruncated) break;
        if (index === MAX_SENT_PAGES - 1) { sentTruncated = true; break; }
        page = await api.messages.continueList(listId);
      }
    } finally {
      await abortList(api, listId);
    }
  }

  const candidates = [...found.values()];
  return {
    candidates: candidates.slice(0, limit), ambiguous: candidates.length > 1,
    contactsEnabled, contactsSearched, sentHistoryDays: SENT_DAYS,
    truncated: contactsTruncated || sentTruncated || candidates.length > limit,
  };
}
