// SPDX-License-Identifier: MIT
// Add agent-supplied plain text above Thunderbird's own signature and quote.
// Never change the compose format or the recipients after the window opens.

import { BridgeError } from "./validate.js";

export function htmlFromPlainText(text) {
  return String(text).replace(/\r\n?/g, "\n").split(/\n{2,}/).map(paragraph => {
    const escaped = paragraph.replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    return `<p>${escaped.replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

function prependHtml(existing, insertion) {
  // ComposeDetails.body may be a full document or an HTML fragment. Keep its
  // original markup intact so signature images and reply quotes survive.
  const bodyTag = /<body\b[^>]*>/i.exec(existing);
  if (!bodyTag) return insertion + existing;
  const index = bodyTag.index + bodyTag[0].length;
  return existing.slice(0, index) + insertion + existing.slice(index);
}

export function agentBodyDetails(native, text) {
  if (native.isPlainText) {
    const existing = String(native.plainTextBody || "").replace(/^\n+/, "");
    return { plainTextBody: existing ? `${text}\n\n${existing}` : text };
  }
  return { body: prependHtml(String(native.body || ""), htmlFromPlainText(text)) };
}

export async function insertAgentText(api, tabId, text) {
  const native = await api.compose.getComposeDetails(tabId);
  await api.compose.setComposeDetails(tabId, agentBodyDetails(native, text));
  return native;
}

export async function identityForReply(api, header) {
  const account = (await api.accounts.list()).find(a => a.id === header.folder?.accountId);
  const identities = account?.identities || [];
  if (!identities.length) throw new BridgeError("invalid_params", "Reply account has no sending identity.", 400);
  const addressed = [...(header.recipients || []), ...(header.ccList || [])]
    .map(value => /<([^<>]+)>/.exec(value)?.[1] || value)
    .map(value => value.trim().toLowerCase());
  return identities.find(i => i.email && addressed.includes(i.email.toLowerCase()))?.id || identities[0].id;
}
