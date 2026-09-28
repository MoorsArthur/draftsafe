// SPDX-License-Identifier: MIT
// Approved one-click unsubscribes (RFC 8058). The ONLY network request any
// Draftsafe add-on makes, and it is made only:
//   - to a URL this add-on read itself from the message's own
//     List-Unsubscribe header (the agent can only name message ids; the
//     request schema has no URL field);
//   - when the message also carries "List-Unsubscribe-Post:
//     List-Unsubscribe=One-Click" and the URL is plain https on the default
//     port to a public-looking host name;
//   - after the user ticked that sender and clicked Approve, and granted the
//     per-origin host permission Thunderbird asks for at that moment;
//   - as a POST with body "List-Unsubscribe=One-Click", no cookies, no
//     referrer, no redirects followed.
// mailto: and web-page unsubscribe links are shown as "manual" and never
// acted on: no mail is sent and no link is opened or fetched.

import { queryAll } from "../../../shared/lib/mail.js";
import { decisionList, DecisionError, groupBySender, snapshotMessage, stillSame } from "./common.js";

const MAX_URL = 2048;
const POST_TIMEOUT_MS = 20_000;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa", ".localdomain"];

/** Lower-cased header map with array values, whatever the API returned. */
export async function headersOf(api, id) {
  let raw = {};
  try {
    if (api.messages.getHeaders) {
      raw = (await api.messages.getHeaders(id)) || {};
    } else {
      const full = await api.messages.getFull(id, { decodeContent: false });
      raw = (full && full.headers) || {};
    }
  } catch {
    raw = {};
  }
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k.toLowerCase(), (Array.isArray(v) ? v : [v]).map(x => String(x))])
  );
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

export async function planUnsubscribe(api, input, { fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const snaps = [];
  for (const it of input.items) {
    const s = await snapshotMessage(api, it.messageId);
    s.reason = it.reason;
    s.inJunk = s.junk || s.folderUses.includes("junk");
    s.how = unsubscribeMethod(await headersOf(api, s.id));
    snaps.push(s);
  }

  const junkFolders = await api.folders.query({ specialUse: ["junk"] });
  const junkSenders = new Set(snaps.filter(s => s.inJunk).map(s => s.sender));
  for (const sender of new Set(snaps.map(s => s.sender))) {
    if (junkSenders.has(sender) || !junkFolders.length) continue;
    try {
      const found = await queryAll(api, { folderId: junkFolders.map(f => f.id), author: sender }, 1);
      if (found.length) junkSenders.add(sender);
    } catch { junkSenders.add(sender); } // unknown Junk status defaults off
  }
  // Distinct mailing lists from the same sender keep separate destinations.
  const groups = new Map();
  for (const s of snaps) {
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

  const binding = senders.map(s => [s.sender, s.url, s.items.map(i => [i.id, i.key])]);

  const view = {
    kind: "unsubscribe",
    reasons: [...new Set(snaps.map(s => s.reason).filter(Boolean))].slice(0, 20),
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
      const fresh = unsubscribeMethod(await headersOf(api, s.pick.id));
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
    return { items };
  }

  return { binding, view, execute, readDecision, originsFor };
}
