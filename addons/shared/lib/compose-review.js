// SPDX-License-Identifier: MIT
// Agent-prepared mail stops at Thunderbird's native composer. No send call.
import { agentBodyDetails, identityForReply, insertAgentText } from "./compose-body.js";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_FILES, MAX_ATTACHMENT_TOTAL } from "./attachment-stage.js";
import { BridgeError } from "./validate.js";

const summary = items => items.map(({ id, name, size }) => ({ id, name, size }));
const snapshot = (d, a) => JSON.stringify({
  isPlainText: d.isPlainText, body: d.body, plainTextBody: d.plainTextBody,
  to: d.to, subject: d.subject, identityId: d.identityId, attachments: summary(a),
});
const result = (tabId, attachments) => ({
  status: "awaiting_user_send", sent: false, tabId, attachments: summary(attachments),
  review: "Check From, To, subject, body and attachments in Thunderbird, then click Send yourself or discard.",
});
const targetKey = d => d.replyToMessageId
  ? `reply:${d.replyToMessageId}`
  : `new:${[...(d.to || [])].map(s => s.toLowerCase()).sort().join(",")}:${(d.subject || "").toLowerCase()}`;

export function createComposeReview({ api, stage }) {
  const tabs = new Map();
  const removedDuringOpen = new Set();
  let busy = false;
  let uncertain = false;
  api.tabs.onRemoved.addListener(id => {
    tabs.delete(id);
    if (busy) removedDuringOpen.add(id);
  });

  async function state(id) {
    const [details, attachments] = await Promise.all([
      api.compose.getComposeDetails(id), api.compose.listAttachments(id),
    ]);
    return { details, attachments, fingerprint: snapshot(details, attachments) };
  }

  async function files(specs = []) {
    const out = [];
    for (const spec of specs) {
      let file;
      if (spec.stagedToken) file = stage.consume(spec.stagedToken);
      else {
        try { file = await api.messages.getAttachmentFile(spec.messageId, spec.partName); }
        catch { throw new BridgeError("not_found", "Source attachment not found; read the email again.", 404); }
      }
      if (!file || !Number.isSafeInteger(file.size) || file.size > MAX_ATTACHMENT_BYTES ||
          !file.name || file.name.length > 200 || /[\\/\x00-\x1f\x7f]/.test(file.name))
        throw new BridgeError("attachment_limit", "Attachment name or size is not allowed.", 400);
      out.push(file);
    }
    if (out.length > MAX_ATTACHMENT_FILES || out.reduce((n, f) => n + f.size, 0) > MAX_ATTACHMENT_TOTAL)
      throw new BridgeError("attachment_limit", "Attachment count or total size exceeds the limit.", 400);
    return out;
  }

  async function addFiles(id, items, existing) {
    for (const file of items) await api.compose.addAttachment(id, { file });
    const actual = await api.compose.listAttachments(id);
    if (actual.length !== existing.length + items.length ||
        items.some(f => !actual.some(a => a.name === f.name && a.size === f.size)))
      throw new BridgeError("compose_unknown", "Thunderbird did not confirm all attachments; inspect the window.", 409);
    return actual;
  }

  async function open(d) {
    if (uncertain) throw new BridgeError("compose_unknown", "Inspect Thunderbird's compose windows before retrying.", 409);
    if (tabs.size && d.newWindow !== true)
      throw new BridgeError("compose_exists", "An agent-prepared composer is already open; list and update it, or explicitly request a separate new window.", 409);
    const target = targetKey(d);
    if ([...tabs.values()].some(record => record.target === target))
      throw new BridgeError("compose_exists", "A matching agent-prepared composer is already open; list and update it.", 409);
    if (busy) throw new BridgeError("compose_busy", "Another compose operation is running.", 409);
    busy = true;
    removedDuringOpen.clear();
    let attempted = false;
    try {
      const attachments = await files(d.attachments);
      const details = {};
      let tab;
      if (d.replyToMessageId) {
        let header;
        try { header = await api.messages.get(d.replyToMessageId); }
        catch { throw new BridgeError("not_found", "Message not found; search again.", 404); }
        details.identityId = await identityForReply(api, header);
        attempted = true;
        tab = await api.compose.beginReply(d.replyToMessageId, "replyToSender", details);
      } else {
        const identities = (await api.accounts.list()).flatMap(a => a.identities || []);
        if (d.identityId && !identities.some(i => i.id === d.identityId))
          throw new BridgeError("invalid_params", "Unknown sender identity; list accounts first.", 400);
        Object.assign(details, { to: d.to, subject: d.subject });
        if (d.identityId) details.identityId = d.identityId;
        attempted = true;
        tab = await api.compose.beginNew(undefined, details);
      }
      if (!tab || !Number.isSafeInteger(tab.id))
        throw new BridgeError("compose_unknown", "Thunderbird did not confirm the compose window; inspect it.", 409);
      const native = await insertAgentText(api, tab.id, d.body);
      const nativeAttachments = await api.compose.listAttachments(tab.id);
      const added = await addFiles(tab.id, attachments, nativeAttachments);
      const current = await state(tab.id);
      if (removedDuringOpen.has(tab.id)) throw new BridgeError("compose_unknown", "Composer closed during preparation.", 409);
      const nativeIds = new Set(nativeAttachments.map(a => a.id));
      const agentIds = new Set(added.filter(a => !nativeIds.has(a.id)).map(a => a.id));
      tabs.set(tab.id, { native, isReply: !!d.replyToMessageId, target, fingerprint: current.fingerprint,
        agentIds });
      try {
        await api.notifications.create(`draftsafe-agent-compose-${tab.id}`, {
          type: "basic", title: "Review agent-prepared email",
          message: `Check From, To, subject, body and ${agentIds.size} attachment(s). Click Thunderbird's Send button yourself.`,
        });
      } catch { /* Notification is optional. */ }
      return result(tab.id, added.filter(a => agentIds.has(a.id)));
    } catch (e) {
      if (attempted) uncertain = true;
      throw e;
    } finally { busy = false; removedDuringOpen.clear(); }
  }

  async function update(d) {
    if (uncertain) throw new BridgeError("compose_unknown", "Inspect Thunderbird's compose windows before retrying.", 409);
    if (busy) throw new BridgeError("compose_busy", "Another compose operation is running.", 409);
    const tabId = d.tabId ?? (tabs.size === 1 ? [...tabs.keys()][0] : undefined);
    if (tabId === undefined && tabs.size > 1)
      throw new BridgeError("compose_ambiguous", "Several agent-prepared composers are open; list them and choose a tab ID.", 409);
    const record = tabs.get(tabId);
    if (!record) throw new BridgeError("not_found", "This agent-prepared compose window is closed.", 404);
    if (record.isReply && (d.to !== undefined || d.subject !== undefined))
      throw new BridgeError("invalid_params", "Reply recipients and subject cannot be changed by the agent.", 400);
    busy = true;
    let changed = false;
    try {
      const before = await state(tabId);
      if (before.fingerprint !== record.fingerprint)
        throw new BridgeError("compose_conflict", "You edited this window; the agent will not overwrite it.", 409);
      const remove = d.removeAttachmentIds || [];
      if (remove.some(id => !record.agentIds.has(id)))
        throw new BridgeError("invalid_params", "Only agent-added attachments can be removed.", 400);
      const additions = await files(d.attachments);
      const remaining = before.attachments.filter(a => !remove.includes(a.id));
      const currentAgent = remaining.filter(a => record.agentIds.has(a.id));
      if (currentAgent.length + additions.length > MAX_ATTACHMENT_FILES ||
          currentAgent.reduce((n, a) => n + (a.size || 0), 0) + additions.reduce((n, f) => n + f.size, 0) > MAX_ATTACHMENT_TOTAL)
        throw new BridgeError("attachment_limit", "Composer attachment limit exceeded.", 400);
      const changes = { ...agentBodyDetails(record.native, d.body) };
      if (d.to !== undefined) changes.to = d.to;
      if (d.subject !== undefined) changes.subject = d.subject;
      changed = true;
      await api.compose.setComposeDetails(tabId, changes);
      for (const id of remove) await api.compose.removeAttachment(tabId, id);
      const added = await addFiles(tabId, additions, remaining);
      const current = await state(tabId);
      if (!tabs.has(tabId)) throw new BridgeError("compose_unknown", "Composer closed during update.", 409);
      const remainingIds = new Set(remaining.map(a => a.id));
      record.fingerprint = current.fingerprint;
      if (!record.isReply) record.target = targetKey({ to: current.details.to, subject: current.details.subject });
      record.agentIds = new Set([
        ...currentAgent.map(a => a.id),
        ...added.filter(a => !remainingIds.has(a.id)).map(a => a.id),
      ]);
      return result(tabId, added.filter(a => record.agentIds.has(a.id)));
    } catch (e) {
      if (changed || !(e instanceof BridgeError) ||
          !["compose_conflict", "invalid_params", "attachment_limit", "not_found"].includes(e.code)) uncertain = true;
      throw e;
    } finally { busy = false; }
  }

  async function close({ tabId: requestedTabId } = {}) {
    if (uncertain) throw new BridgeError("compose_unknown", "Inspect Thunderbird's compose windows before retrying.", 409);
    if (busy) throw new BridgeError("compose_busy", "Another compose operation is running.", 409);
    const tabId = requestedTabId ?? (tabs.size === 1 ? [...tabs.keys()][0] : undefined);
    if (tabId === undefined && tabs.size > 1)
      throw new BridgeError("compose_ambiguous", "Several agent-prepared composers are open; list them and choose a tab ID.", 409);
    const record = tabs.get(tabId);
    if (!record) throw new BridgeError("not_found", "This agent-prepared compose window is closed.", 404);
    busy = true;
    try {
      const before = await state(tabId);
      if (before.fingerprint !== record.fingerprint)
        throw new BridgeError("compose_conflict", "You edited this window; the agent will not close it.", 409);
      await api.tabs.remove(tabId);
      // Thunderbird may hold tabs.remove while its native unsaved-draft prompt
      // is open. Only the onRemoved event proves the window actually closed.
      for (let attempt = 0; attempt < 10 && tabs.has(tabId); attempt++)
        await new Promise(resolve => setTimeout(resolve, 100));
      if (tabs.has(tabId)) {
        uncertain = true;
        return { status: "close_unconfirmed", closed: false, tabId,
          review: "Thunderbird did not confirm the close. Inspect the compose window before retrying." };
      }
      return { status: "closed", closed: true, tabId, sent: false };
    } catch (e) {
      if (!(e instanceof BridgeError) || e.code !== "compose_conflict") uncertain = true;
      if (e instanceof BridgeError) throw e;
      throw new BridgeError("compose_unknown", "Thunderbird did not confirm the close. Inspect the compose window.", 409);
    } finally { busy = false; }
  }

  async function list() {
    const composers = [];
    for (const [tabId, record] of tabs) {
      let current;
      try { current = await state(tabId); }
      catch { composers.push({ tabId, unavailable: true }); continue; }
      composers.push({ tabId, isReply: record.isReply,
        subject: current.details.subject || "", to: current.details.to || [],
        userEdited: current.fingerprint !== record.fingerprint,
        attachments: summary(current.attachments),
      });
    }
    return { composers, uncertain };
  }

  return { open, update, close, list };
}
