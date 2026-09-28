// SPDX-License-Identifier: MIT
// Approved one-click unsubscribes (RFC 8058). The ONLY network request any
// Draftsafe add-on makes, and it is made only:
//   - to a URL this add-on read itself from the message's own
//     List-Unsubscribe header (the agent can name message ids or account-scoped
//     senders; the request schema has no URL field);
//   - when the message also carries "List-Unsubscribe-Post:
//     List-Unsubscribe=One-Click" and the URL is plain https on the default
//     port to a public-looking host name;
//   - after the user ticked that sender and clicked Approve, and granted the
//     per-origin host permission Thunderbird asks for at that moment;
//   - as a POST with body "List-Unsubscribe=One-Click", no cookies, no
//     referrer, no redirects followed.
// mailto: and web-page unsubscribe links are shown as "manual" and never
// acted on: no mail is sent and no link is opened or fetched.

import { abortList, queryAll } from "../../../shared/lib/mail.js";
import { decisionList, DecisionError, groupBySender, senderAddress, snapshotMessage, stillSame } from "./common.js";

const MAX_URL = 2048;
const POST_TIMEOUT_MS = 20_000;
export const HEADER_TIMEOUT_MS = 8_000;
export const HEADER_CONCURRENCY = 4;
export const SENDER_TIMEOUT_MS = 7_000;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa", ".localdomain"];

/** Lower-cased header map with array values, whatever the API returned. */
export async function headersOf(api, id) {
  let raw = {};
  if (api.messages.getHeaders) {
    raw = (await api.messages.getHeaders(id)) || {};
  } else {
    const full = await api.messages.getFull(id, { decodeContent: false });
    raw = (full && full.headers) || {};
  }
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k.toLowerCase(), (Array.isArray(v) ? v : [v]).map(x => String(x))])
  );
}

function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("message read timed out")), ms);
  })]).finally(() => clearTimeout(timer));
}

/** A URL we would POST to, or null. */
export function safeOneClickUrl(raw) {
  if (typeof raw !== "string" || raw.length > MAX_URL) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port !== "") return null;
  const host = u.hostname.toLowerCase();
  if (!host || !host.includes(".") || host.endsWith(".")) return null;
  if (host.startsWith("[") || host.includes(":") || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return null;
  if (host === "localhost" || BLOCKED_SUFFIXES.some(s => host.endsWith(s))) return null;
  return u;
}

/**
 * {method: "one_click", url, origin} or {method: "manual", targets: [...]}.
 * `targets` are shown to the user as plain text for manual handling.
 */
export function unsubscribeMethod(headers) {
  const lu = (headers["list-unsubscribe"] || []).join(",").slice(0, 8192);
  const post = (headers["list-unsubscribe-post"] || []).map(v => v.trim().toLowerCase());
  const uris = [...lu.matchAll(/<\s*([^<>\s]{1,2048})\s*>/g)].map(m => m[1]);
  const targets = uris.slice(0, 3).map(u => u.slice(0, 200));
  if (!uris.length) {
    return { method: "manual", targets: [], why: "no List-Unsubscribe header" };
  }
  if (!post.includes("list-unsubscribe=one-click")) {
    return { method: "manual", targets, why: "no one-click unsubscribe (RFC 8058) offered" };
  }
  for (const raw of uris) {
    const u = safeOneClickUrl(raw);
    if (u) {
      return { method: "one_click", url: u.href, origin: `https://${u.hostname}`, host: u.hostname, targets };
    }
  }
  return { method: "manual", targets, why: "the one-click link is not a plain public https address" };
}

export function originPattern(origin) {
  return `${origin}/*`;
}

function searchableFolder(folder) {
  if (!folder?.id || folder.isVirtual || folder.isUnified || folder.isTag) return false;
  if ((folder.specialUse || []).some(use => ["inbox", "trash", "archives"].includes(use))) return true;
  // Thunderbird has no specialUse value for Gmail's All Mail folder.
  const allMail = /^(?:all mail|alle e-mails?|alle berichten|tous les messages|tous les e-mails|alle nachrichten)$/i;
  return allMail.test((folder.path || "").split("/").at(-1) || "") || allMail.test(folder.name || "");
}

async function resolveSender(api, sender, folderIds, timeoutMs) {
  let listId = null;
  let expired = false;
  const timer = setTimeout(() => { expired = true; }, timeoutMs);
  try {
    const work = (async () => {
      const matches = [];
      let page = await api.messages.query({ accountId: sender.accountId, folderId: folderIds, author: sender.address, messagesPerPage: 100 });
      for (;;) {
        listId = page.id;
        if (expired) throw new Error("sender search timed out");
        for (const m of page.messages || []) {
          if (m.folder?.accountId === sender.accountId && folderIds.includes(m.folder.id) && senderAddress(m.author) === sender.address) matches.push(m);
        }
        if (!page.id) break;
        page = await api.messages.continueList(page.id);
      }
      matches.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      let unreadable = false;
      for (const m of matches) {
        if (expired) throw new Error("sender search timed out");
        try {
          const headers = await headersOf(api, m.id);
          if ((headers["list-unsubscribe"] || []).length) return { messageId: m.id };
        } catch { unreadable = true; }
      }
      return { result: unreadable ? "unreadable" : "not_found" };
    })();
    return await within(work, timeoutMs);
  } finally {
    expired = true;
    clearTimeout(timer);
    await abortList(api, listId);
  }
}

async function resolveSenders(api, senders, onProgress, timeoutMs) {
  const folders = new Map();
  const results = Array(senders.length);
  let next = 0, done = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= senders.length) return;
      const sender = senders[index];
      try {
        if (!folders.has(sender.accountId)) {
          folders.set(sender.accountId, within(api.folders.query({ accountId: sender.accountId }), timeoutMs));
        }
        const folderIds = (await folders.get(sender.accountId)).filter(f => f.accountId === sender.accountId && searchableFolder(f)).map(f => f.id);
        results[index] = folderIds.length ? await resolveSender(api, sender, folderIds, timeoutMs) : { result: "not_found" };
      } catch (e) {
        results[index] = { result: /timed out/.test(String(e)) ? "timeout" : "unreadable" };
      } finally { onProgress(++done, senders.length, "senders"); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(HEADER_CONCURRENCY, senders.length) }, () => worker()));
  return {
    items: results.filter(r => r.messageId),
    skippedSenders: results.flatMap((r, i) => r.messageId ? [] : [{ ...senders[i], result: r.result }]),
  };
}

export async function planUnsubscribe(api, input, { fetchImpl = (...a) => globalThis.fetch(...a), onProgress = () => {}, headerTimeoutMs = HEADER_TIMEOUT_MS, senderTimeoutMs = SENDER_TIMEOUT_MS } = {}) {
  const resolved = input.senders ? await resolveSenders(api, input.senders, onProgress, senderTimeoutMs) : { items: input.items, skippedSenders: [] };
  const snaps = [];
  const unreadable = [];
  let next = 0, done = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= resolved.items.length) return;
      const it = resolved.items[index];
      try {
        const s = await within((async () => {
          const snap = await snapshotMessage(api, it.messageId);
          snap.reason = it.reason;
          snap.inJunk = snap.junk || snap.folderUses.includes("junk");
          snap.how = unsubscribeMethod(await headersOf(api, snap.id));
          return snap;
        })(), headerTimeoutMs);
        snaps[index] = s;
      } catch {
        unreadable[index] = it.messageId;
      } finally {
        onProgress(++done, resolved.items.length, "headers");
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(HEADER_CONCURRENCY, resolved.items.length) }, () => worker()));
  const readable = snaps.filter(Boolean);
  const skipped = unreadable.filter(Boolean);

  const junkSenders = new Set(readable.filter(s => s.inJunk).map(s => s.sender));
  const uniqueSenders = [...new Set(readable.map(s => s.sender))];
  let checked = 0, senderIndex = 0;
  onProgress(0, uniqueSenders.length, "junk");
  let junkFolders;
  try { junkFolders = await within(api.folders.query({ specialUse: ["junk"] }), headerTimeoutMs); }
  catch { junkFolders = null; }
  async function checkJunk() {
    for (;;) {
      const index = senderIndex++;
      if (index >= uniqueSenders.length) return;
      const sender = uniqueSenders[index];
      try {
        if (!junkFolders) junkSenders.add(sender);
        else if (!junkSenders.has(sender) && junkFolders.length) {
          const found = await within(queryAll(api, { folderId: junkFolders.map(f => f.id), author: sender }, 1), headerTimeoutMs);
          if (found.length) junkSenders.add(sender);
        }
      } catch { junkSenders.add(sender); } // unknown Junk status defaults off
      finally { onProgress(++checked, uniqueSenders.length, "junk"); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(HEADER_CONCURRENCY, uniqueSenders.length) }, () => checkJunk()));
  // Distinct mailing lists from the same sender keep separate destinations.
  const groups = new Map();
  for (const s of readable) {
    const key = `${s.sender}\n${s.how.url || "manual"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const senders = [...groups.values()].map(items => {
    const g = groupBySender(items)[0];
    // Newest message with a one-click link decides the URL for this sender.
    const pick = g.items.find(s => s.how.method === "one_click") || g.items[0];
    const inJunk = junkSenders.has(g.sender);
    return {
      pick,
      sender: g.sender,
      items: g.items,
      method: pick.how.method,
      url: pick.how.method === "one_click" ? pick.how.url : null,
      origin: pick.how.method === "one_click" ? pick.how.origin : null,
      host: pick.how.host || null,
      targets: pick.how.targets,
      why: pick.how.why || null,
      inJunk,
    };
  });

  const binding = { senders: senders.map(s => [s.sender, s.url, s.items.map(i => [i.id, i.key])]), unreadable: skipped, skippedSenders: resolved.skippedSenders };

  const view = {
    kind: "unsubscribe",
    reasons: [...new Set(readable.map(s => s.reason).filter(Boolean))].slice(0, 20),
    unreadable: skipped,
    skippedSenders: resolved.skippedSenders,
    senders: senders.map((s, index) => ({
      index,
      sender: s.sender,
      count: s.items.length,
      items: s.items.map(i => ({ id: i.id, subject: i.subject })),
      sourceMessageId: s.pick.id,
      method: s.method,
      host: s.host,
      origin: s.origin,
      targets: s.targets,
      why: s.why,
      inJunk: s.inJunk,
      defaultChecked: s.method === "one_click" && !s.inJunk,
    })),
  };

  function readDecision(decision) {
    return decisionList(decision, "senders", senders.length).map((d, i) => {
      const excluded = d.excluded || [];
      if (!Array.isArray(excluded) || new Set(excluded).size !== excluded.length || excluded.some(id => !senders[i].items.some(s => s.id === id))) throw new DecisionError("invalid exclusion");
      return { approved: d.approved && senders[i].method === "one_click" && !excluded.includes(senders[i].pick.id), excluded };
    });
  }
  function originsFor(decision) {
    const choices = readDecision(decision);
    return [...new Set(senders.filter((s, i) => choices[i].approved).map(s => originPattern(s.origin)))];
  }

  async function post(url) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      return res && res.ok ? "unsubscribed" : "failed";
    } catch {
      return "failed";
    }
  }

  async function execute(decision) {
    const choices = readDecision(decision);
    const perSender = [];
    const origins = new Set();
    for (const [i, s] of senders.entries()) {
      if (s.method !== "one_click") {
        perSender.push("manual");
        continue;
      }
      if (!choices[i].approved) {
        perSender.push("excluded");
        continue;
      }
      let fresh;
      try { fresh = unsubscribeMethod(await within(headersOf(api, s.pick.id), headerTimeoutMs)); }
      catch { perSender.push("failed"); continue; }
      if (!(await stillSame(api, s.pick)) || fresh.method !== "one_click" || fresh.url !== s.url) { perSender.push("failed"); continue; }
      const pattern = originPattern(s.origin);
      origins.add(pattern);
      let granted = false;
      try {
        granted = await api.permissions.contains({ origins: [pattern] });
      } catch {
        granted = false;
      }
      perSender.push(granted ? await post(s.url) : "permission_denied");
    }
    // The host permissions were only needed for these requests.
    if (origins.size) {
      await api.permissions.remove({ origins: [...origins] }).catch(() => {});
    }
    const items = [];
    for (const [i, s] of senders.entries()) {
      for (const m of s.items) {
        if (choices[i].excluded.includes(m.id)) { items.push({ messageId: m.id, approved: false, result: "excluded" }); continue; }
        items.push({ messageId: m.id, approved: perSender[i] !== "excluded" && perSender[i] !== "manual", result: perSender[i] });
      }
    }
    for (const messageId of skipped) items.push({ messageId, approved: false, result: "unreadable" });
    return { items, skippedSenders: resolved.skippedSenders };
  }

  return { binding, view, execute, readDecision, originsFor };
}
