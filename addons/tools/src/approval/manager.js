// SPDX-License-Identifier: MIT
// Agent requests reserve one slot. Only a trusted click listener attached to
// this add-on's exact approval page can invoke the private decision function.
// Neither runtime message channel exposes approval or its nonce.

import { APPROVAL_KINDS, ApprovalInputError, VALIDATORS } from "../../../shared/lib/approval-schema.js";
import { BRIDGE_ID, APPROVAL_PROTOCOL, APPROVAL_REQUEST, APPROVAL_STATUS } from "../../../shared/lib/ids.js";
import { planState } from "./state.js";
import { validateStateRequest } from "../../../shared/lib/state-request.js";
import { planCleanup } from "./cleanup.js";
import { DecisionError } from "./common.js";
import { planFolderChanges } from "./folder-changes.js";
import { FolderRuleError } from "./tree.js";
import { planUnsubscribe } from "./unsubscribe.js";

export const APPROVAL_PAGE = "tools/src/ui/approve.html";
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
export const COOLDOWN_MS = 20 * 1000;
export const MAX_REQUESTS_PER_HOUR = 30;
export const OUTCOME_TTL_MS = 30 * 60 * 1000;
export const LOG_KEY = "approvalLog";
export const MAX_LOG_ENTRIES = 200;
export const TRUST_DURATION_MS = 60 * 60 * 1000;

const PLANNERS = { cleanup: planCleanup, unsubscribe: planUnsubscribe, folders: planFolderChanges, state: planState };
const DECISION_KEY = { cleanup: "batches", unsubscribe: "senders", folders: "changes", state: "changes" };
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{24}$/;
const TRUSTED_STATE_ROUTES = new Set(["messages.setTags", "messages.markRead"]);

export class PageError extends Error {}

function token(bytes, cryptoImpl = globalThis.crypto) {
  const b = new Uint8Array(bytes);
  cryptoImpl.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** JSON with object keys sorted at every level: a stable input for the hash. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

export async function sha256Text(text, subtle = globalThis.crypto.subtle) {
  const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}

function sameSecret(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !expected) return false;
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= (given.charCodeAt(i) | 0) ^ expected.charCodeAt(i);
  return diff === 0;
}

const fail = code => ({ ok: false, code });

function summarize(kind, view) {
  if (kind === "cleanup") {
    return view.batches.map(b => ({
      action: b.action,
      count: b.total,
      to: b.destinations.map(d => d.label).join("; ").slice(0, 300),
    }));
  }
  if (kind === "unsubscribe") {
    return view.senders.map(s => ({ sender: s.sender, method: s.method, count: s.count }));
  }
  return view.changes.map(c => ({ action: c.action, label: c.label.slice(0, 300) }));
}

function reasonsOf(kind, view) {
  const list = kind === "cleanup" ? view.batches.map(b => b.reason) : kind === "unsubscribe" ? view.reasons : [];
  return list.filter(Boolean).map(r => r.slice(0, 300)).slice(0, 10);
}

function itemCount(kind, input) {
  if (kind === "unsubscribe") return (input.items || input.senders).length;
  if (kind === "cleanup") return input.batches.reduce((sum, batch) => sum + batch.messageIds.length, 0);
  if (kind === "folders") return input.changes.length;
  return Array.isArray(input.params?.messageIds) ? input.params.messageIds.length : 1;
}

export function createApprovals({
  api,
  store,
  now = () => Date.now(),
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: t => clearTimeout(t) },
  fetchImpl,
  notify = () => {},
  onTrustChange = () => {},
}) {
  const pageBase = api.runtime.getURL(APPROVAL_PAGE);
  let pending = null;
  const outcomes = new Map();
  let cooldownUntil = 0;
  const recent = [];
  let trustUntil = 0;
  let trustTimer = null;

  function endTrust() {
    if (!trustUntil) return;
    trustUntil = 0;
    if (trustTimer !== null) timers.clearTimeout(trustTimer);
    trustTimer = null;
    notify("Vertrouwen gestopt", "Verzoeken van de agent vragen opnieuw je toestemming.");
    onTrustChange(0);
  }

  function trustRemaining() {
    if (trustUntil && now() >= trustUntil) endTrust();
    return Math.max(0, trustUntil - now());
  }

  function startTrust(clickedAt = now()) {
    if (trustTimer !== null) timers.clearTimeout(trustTimer);
    trustUntil = clickedAt + TRUST_DURATION_MS;
    if (trustRemaining() === 0) return;
    trustTimer = timers.setTimeout(endTrust, trustUntil - now());
    notify("Agent vertrouwd voor 1 uur", "Toegestane verzoeken worden zonder goedkeuringsvenster uitgevoerd tot het vertrouwen stopt.");
    onTrustChange(trustRemaining());
  }

  // Called only by Thunderbird's native menus.onClicked listener in background.js.
  function onTrustMenuClick() {
    if (trustRemaining()) endTrust();
    else startTrust();
  }

  function sweep() {
    const t = now();
    for (const [id, o] of outcomes) {
      if (t - o.at > OUTCOME_TTL_MS) outcomes.delete(id);
    }
  }

  async function log(entry) {
    try {
      await store.update(LOG_KEY, map => {
        map[entry.requestId] = { ...(map[entry.requestId] || {}), ...entry };
        const ids = Object.keys(map).sort((a, b) => (map[b].at || 0) - (map[a].at || 0));
        for (const id of ids.slice(MAX_LOG_ENTRIES)) delete map[id];
      });
    } catch (e) {
      console.error("draftsafe: could not write the approval log", e);
    }
  }

  function denyAll(slot) {
    return { [DECISION_KEY[slot.kind]]: slot.plan.readLength().map(() => ({ approved: false })) };
  }

  async function finish(slot, status, result, trusted = false) {
    if (pending !== slot || slot.state === "done") return;
    slot.state = "done";
    timers.clearTimeout(slot.timer);
    let final = result;
    if (!final && slot.plan) {
      try {
        final = await slot.plan.execute(denyAll(slot)); // nothing approved: builds zero counts only
      } catch {
        final = {};
      }
    }
    const outcome = { kind: slot.kind, status: status === "approved_trusted" ? "approved" : status, ...final };
    if (trusted) outcome.trusted = true;
    outcomes.set(slot.requestId, { at: now(), outcome });
    if (!["approved", "approved_trusted"].includes(status)) cooldownUntil = now() + COOLDOWN_MS;
    if (status === "expired" && slot.windowId !== undefined) {
      api.windows.remove(slot.windowId).catch(() => {});
    }
    await log({ requestId: slot.requestId, status, decidedAt: now(), result: final });
    if (pending === slot) pending = null;
  }

  async function request(kind, payload) {
    if (![...APPROVAL_KINDS, "state"].includes(kind)) return fail("bad_request");
    const t = now();
    if (pending) return fail("busy");
    if (t < cooldownUntil) return fail("cooldown");
    while (recent.length && t - recent[0] > 60 * 60 * 1000) recent.shift();
    if (recent.length >= MAX_REQUESTS_PER_HOUR) return fail("rate_limited");
    let input;
    try {
      input = kind === "state" ? await validateStateRequest(payload) : VALIDATORS[kind](payload);
    } catch (e) {
      return fail(e instanceof ApprovalInputError ? e.code : "invalid_params");
    }

    if (pending) return fail("busy");
    // Reserve the single planning/window slot before mailbox reads.
    const count = itemCount(kind, input);
    const auto = trustRemaining() > 0 && (kind !== "state" || TRUSTED_STATE_ROUTES.has(input.route));
    const slot = { requestId: token(18), kind, state: "planning", count, auto,
      progress: { done: 0, total: count, phase: kind === "unsubscribe" ? (input.senders ? "senders" : "headers") : "items" } };
    pending = slot;
    recent.push(t);
    slot.createdAt = t;
    slot.deadline = t + APPROVAL_TIMEOUT_MS;
    slot.timer = timers.setTimeout(() => { finish(slot, "expired").catch(() => {}); }, APPROVAL_TIMEOUT_MS);
    if (auto) {
      log({ requestId: slot.requestId, at: t, kind, status: "planning" }).catch(() => {});
      void prepare(slot, input);
      return { ok: true, requestId: slot.requestId };
    }
    try {
      const win = await api.windows.create({
        type: "popup", url: `${pageBase}?r=${slot.requestId}&n=${slot.count}`,
        width: 780, height: 720,
      });
      slot.windowId = win && win.id;
      if (slot.windowId === undefined) throw new Error("approval window did not open");
      api.windows.update(slot.windowId, { drawAttention: true }).catch(() => {})
        .then(() => api.windows.update(slot.windowId, { focused: true })).catch(() => {});
      if (pending !== slot || slot.state !== "planning") {
        api.windows.remove(slot.windowId).catch(() => {});
        return { ok: true, requestId: slot.requestId };
      }
      log({ requestId: slot.requestId, at: t, kind, status: "planning" }).catch(() => {});
      void prepare(slot, input);
      return { ok: true, requestId: slot.requestId };
    } catch (e) {
      timers.clearTimeout(slot.timer);
      if (pending === slot) pending = null;
      if (slot.windowId !== undefined) api.windows.remove(slot.windowId).catch(() => {});
      console.error("draftsafe: approval window failed", e);
      return fail("failed");
    }
  }

  async function prepare(slot, input) {
    const kind = slot.kind;
    try {
      const plan = await PLANNERS[kind](api, input, { fetchImpl, onProgress: (done, total, phase) => { slot.progress = { done, total, phase }; } });
      if (pending !== slot || slot.state !== "planning") return { ok: true, requestId: slot.requestId };
      plan.readLength = () => (kind === "cleanup" ? plan.view.batches : kind === "unsubscribe" ? plan.view.senders : plan.view.changes);
      slot.plan = plan;
      slot.nonce = token(32);
      slot.hash = await sha256Text(canonical({ requestId: slot.requestId, nonce: slot.nonce, kind, binding: plan.binding, view: plan.view }));
      await log({ requestId: slot.requestId, at: slot.createdAt, kind, status: "pending",
        summary: summarize(kind, plan.view), reasons: reasonsOf(kind, plan.view) });
      if (pending !== slot || slot.state !== "planning") return { ok: true, requestId: slot.requestId };
      if (slot.auto) {
        if (!trustRemaining()) {
          await finish(slot, "denied");
          return;
        }
        slot.state = "executing";
        timers.clearTimeout(slot.timer);
        try {
          const currentHash = await sha256Text(canonical({ requestId: slot.requestId, nonce: slot.nonce, kind, binding: plan.binding, view: plan.view }));
          if (currentHash !== slot.hash) throw new Error("plan changed");
          const key = DECISION_KEY[kind];
          const decision = { [key]: plan.readLength().map(item => ({ approved: kind !== "unsubscribe" || item.defaultChecked === true })) };
          plan.readDecision(decision);
          if (!trustRemaining()) {
            slot.state = "open";
            await finish(slot, "denied");
            return;
          }
          const result = await plan.execute(decision);
          slot.state = "open";
          await finish(slot, "approved_trusted", result, true);
        } catch (e) {
          console.error("draftsafe: trusted request failed", e);
          slot.state = "open";
          await finish(slot, "failed", { code: "failed" }, true);
        }
      } else slot.state = "open";
    } catch (e) {
      if (pending !== slot || slot.state !== "planning") return;
      await finish(slot, "refused", { code: e instanceof FolderRuleError || e instanceof ApprovalInputError ? e.code : "failed" });
      if (!(e instanceof FolderRuleError)) console.error("draftsafe: approval request failed", e);
    }
  }

  function status(requestId) {
    sweep();
    if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) return fail("unknown_request");
    if (pending && pending.state !== "done" && pending.requestId === requestId) return { ok: true, status: pending.state === "planning" ? "planning" : "pending", progress: pending.progress };
    const o = outcomes.get(requestId);
    return o ? { ok: true, status: "done", outcome: o.outcome } : fail("unknown_request");
  }

  /**
   * The ONLY entry point for other extensions. The background page calls it
   * solely for sender.id === draftsafe-bridge. It can open a window and
   * report an outcome; it cannot approve.
   */
  async function handleExternal(msg, sender) {
    if (sender?.id !== BRIDGE_ID) return fail("forbidden_sender");
    if (!msg || typeof msg !== "object" || msg.v !== APPROVAL_PROTOCOL) return fail("bad_request");
    if (msg.type === APPROVAL_REQUEST && Object.keys(msg).every(k => ["type", "v", "kind", "payload"].includes(k))) return request(msg.kind, msg.payload);
    if (msg.type === APPROVAL_STATUS && Object.keys(msg).every(k => ["type", "v", "requestId"].includes(k))) return status(msg.requestId);
    return fail("bad_request");
  }

  /** The open request, if `sender` is its approval page in its own window. */
  function slotFor(sender, requestId) {
    const slot = pending;
    if (!slot || slot.state !== "open" || typeof requestId !== "string" || slot.requestId !== requestId) return null;
    if (!sender || sender.id !== api.runtime.id) return null;
    if (sender.url !== `${pageBase}?r=${requestId}&n=${slot.count}`) return null;
    if (!sender.tab || slot.windowId === undefined || sender.tab.windowId !== slot.windowId) return null;
    return slot;
  }

  async function view(msg, sender) {
    if (pending && pending.state === "planning" && pending.requestId === msg?.requestId) {
      const slot = pending;
      if (sender?.id === api.runtime.id && sender.url === `${pageBase}?r=${slot.requestId}&n=${slot.count}` && sender.tab?.windowId === slot.windowId)
        return { status: "planning", progress: slot.progress };
    }
    const slot = slotFor(sender, msg && msg.requestId);
    if (!slot) return { status: "done" };
    return {
      requestId: slot.requestId,
      nonce: slot.nonce,
      hash: slot.hash,
      kind: slot.kind,
      deadline: slot.deadline,
      view: slot.plan.view,
    };
  }

  /** Called by the approval page after a trusted click on Approve or Deny. */
  async function decide(msg, sender, permission = Promise.resolve()) {
    const slot = slotFor(sender, msg && msg.requestId);
    if (!slot) throw new PageError("This request is no longer open.");
    if (now() >= slot.deadline) { await finish(slot, "expired"); throw new PageError("This request expired."); }
    if (!sameSecret(msg.nonce, slot.nonce) || msg.hash !== slot.hash) {
      throw new PageError("This approval does not match the request.");
    }
    try {
      slot.plan.readDecision(msg.decision);
    } catch (e) {
      if (e instanceof DecisionError) throw new PageError("This approval does not match the request.");
      throw e;
    }
    msg = { ...msg, decision: structuredClone(msg.decision) };
    // One-time: the slot leaves the "open" state before any await.
    slot.state = "executing";
    timers.clearTimeout(slot.timer);
    const approvedAny = msg.decision[DECISION_KEY[slot.kind]].some(d => d.approved === true);
    let result;
    try {
      const currentHash = await sha256Text(canonical({ requestId: slot.requestId, nonce: slot.nonce, kind: slot.kind, binding: slot.plan.binding, view: slot.plan.view }));
      if (currentHash !== slot.hash) throw new PageError("The plan changed.");
      await permission.catch(() => {});
      result = await slot.plan.execute(msg.decision);
    } catch (e) {
      console.error("draftsafe: approved request failed", e);
      slot.state = "open"; // let finish() record it
      await finish(slot, "failed", null);
      throw new PageError("Something went wrong; see the Thunderbird error console.");
    }
    slot.state = "open";
    await finish(slot, approvedAny ? "approved" : "denied", result);
    return { status: approvedAny ? "approved" : "denied", result };
  }

  function onWindowRemoved(windowId) {
    const slot = pending;
    if (slot && ["planning", "open"].includes(slot.state) && slot.windowId === windowId) {
      finish(slot, "closed").catch(() => {});
    }
  }

  async function history() {
    const map = await store.readMap(LOG_KEY);
    // A restart invalidates every nonce. Show unfinished historical work honestly.
    for (const entry of Object.values(map)) {
      if (["pending", "planning"].includes(entry.status) && entry.requestId !== pending?.requestId) entry.status = "interrupted";
    }
    return Object.values(map)
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, 50);
  }

  async function attachPage(page, render) {
    const win = await page.messenger.windows.getCurrent();
    const requestId = new URL(page.location.href).searchParams.get("r");
    const sender = { id: api.runtime.id, url: page.location.href, tab: { windowId: win.id } };
    let data = await view({ requestId }, sender);
    while (data.status === "planning") {
      page.document.getElementById("status").textContent = data.progress.phase === "junk"
        ? `Voorbereiden: ${data.progress.done} van ${data.progress.total} afzenders controleren…`
        : `Voorbereiden: ${data.progress.done} van ${data.progress.total} ${data.progress.phase === "headers" ? "berichten" : "onderdelen"}…`;
      await new Promise(resolve => timers.setTimeout(resolve, 250));
      data = await view({ requestId }, sender);
    }
    if (data.status === "done") throw new PageError("This request is no longer open.");
    const readDecision = render(data);
    const apply = page.document.getElementById("apply");
    const deny = page.document.getElementById("deny");
    let clicked = false;
    const trust = page.document.getElementById("apply-trust");
    function click(allow, button, event, trustAfter = false) {
      if (clicked || !event.isTrusted || !(event instanceof page.MouseEvent) || event.currentTarget !== button || page.location.href !== sender.url) return;
      const slot = slotFor(sender, requestId);
      if (!slot || now() >= slot.deadline) return;
      const decision = allow ? readDecision() : denyAll(slot);
      try { slot.plan.readDecision(decision); } catch { return; }
      clicked = true;
      apply.disabled = deny.disabled = trust.disabled = true;
      // Request permission while the trusted user gesture is still on the stack.
      const origins = allow && slot.plan.originsFor ? slot.plan.originsFor(decision) : [];
      let permission = Promise.resolve();
      if (origins.length) {
        try { permission = page.messenger.permissions.request({ origins }); } catch { /* fails closed */ }
      }
      const clickedAt = now();
      decide({ requestId, nonce: data.nonce, hash: data.hash, decision }, sender, permission).then(
        outcome => { if (trustAfter && outcome.status === "approved") startTrust(clickedAt); page.close(); },
        () => { page.document.getElementById("status").textContent = "Actie gestopt. Bekijk de geschiedenis."; }
      );
    }
    apply.addEventListener("click", event => click(true, apply, event));
    trust.addEventListener("click", event => click(true, trust, event, true));
    deny.addEventListener("click", event => click(false, deny, event));
    return true;
  }

  return { handleExternal, attachPage, onWindowRemoved, history, onTrustMenuClick, trustRemaining };
}
