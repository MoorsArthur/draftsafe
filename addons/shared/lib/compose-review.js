// SPDX-License-Identifier: MIT
// Agent-prepared mail stops at Thunderbird's native compose window. This
// module never saves or sends a message and never exposes a send decision.

import { BridgeError } from "./validate.js";

const MAX_OPENS_PER_HOUR = 12;
const HOUR_MS = 60 * 60 * 1000;

export function createComposeReview({ api, now = () => Date.now() }) {
  let activeTab = null;
  let opening = false;
  let uncertain = false;
  const openedAt = [];
  const removedDuringOpen = new Set();

  api.tabs.onRemoved.addListener(tabId => {
    if (tabId === activeTab) activeTab = null;
    if (opening) removedDuringOpen.add(tabId);
  });

  async function replyIdentity(messageId) {
    let header;
    try { header = await api.messages.get(messageId); }
    catch { throw new BridgeError("not_found", "Message not found; search again.", 404); }
    const account = (await api.accounts.list()).find(a => a.id === header.folder?.accountId);
    const identities = account?.identities || [];
    if (!identities.length) throw new BridgeError("invalid_params", "Reply account has no sending identity.", 400);
    const addressed = [...(header.recipients || []), ...(header.ccList || [])]
      .map(value => /<([^<>]+)>/.exec(value)?.[1] || value)
      .map(value => value.trim().toLowerCase());
    return identities.find(i => i.email && addressed.includes(i.email.toLowerCase()))?.id || identities[0].id;
  }

  async function open(d) {
    if (uncertain) throw new BridgeError("compose_unknown", "Check Thunderbird for an already-open agent message before retrying.", 409);
    if (opening || activeTab !== null) throw new BridgeError("compose_busy", "Close the previous agent-prepared compose window first.", 409);
    const cutoff = now() - HOUR_MS;
    while (openedAt.length && openedAt[0] <= cutoff) openedAt.shift();
    if (openedAt.length >= MAX_OPENS_PER_HOUR) throw new BridgeError("compose_rate_limit", "Too many agent-prepared compose windows this hour.", 429);

    opening = true;
    removedDuringOpen.clear();
    let attemptedOpen = false;
    try {
      const details = { isPlainText: true, plainTextBody: d.body };
      let tab;
      if (d.replyToMessageId) {
        details.identityId = await replyIdentity(d.replyToMessageId);
        attemptedOpen = true;
        tab = await api.compose.beginReply(d.replyToMessageId, "replyToSender", details);
      } else {
        const identities = (await api.accounts.list()).flatMap(a => a.identities || []);
        if (d.identityId && !identities.some(i => i.id === d.identityId)) {
          throw new BridgeError("invalid_params", "Unknown sender identity; list accounts first.", 400);
        }
        Object.assign(details, { to: d.to, subject: d.subject });
        if (d.identityId) details.identityId = d.identityId;
        attemptedOpen = true;
        tab = await api.compose.beginNew(undefined, details);
      }
      if (!tab || !Number.isSafeInteger(tab.id)) {
        uncertain = true;
        throw new BridgeError("compose_unknown", "Thunderbird did not confirm the compose window; check it before retrying.", 409);
      }
      openedAt.push(now());
      activeTab = removedDuringOpen.has(tab.id) ? null : tab.id;
      try {
        await api.notifications.create(`draftsafe-agent-compose-${tab.id}`, {
          type: "basic", title: "Review agent-prepared email",
          message: "Check From, To, subject and body. Edit or discard it, or click Thunderbird's Send button yourself.",
        });
      } catch { /* A desktop notification is helpful, never required for safety. */ }
      return { status: "awaiting_user_send", sent: false, review: "Check From, To, subject and body in Thunderbird, then click Send yourself or discard." };
    } catch (e) {
      if (attemptedOpen && !(e instanceof BridgeError)) uncertain = true;
      throw e;
    } finally {
      opening = false;
      removedDuringOpen.clear();
    }
  }

  return { open };
}
