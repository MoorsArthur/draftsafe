// SPDX-License-Identifier: MIT
// The only UI that can schedule a send. The draft is saved to Drafts, the
// compose window closes, and the add-on sends it at the chosen time.
import { activeTabId, call, el, fmt, presetButton, setStatus, toLocalInput } from "./common.js";

const status = document.getElementById("status");

async function schedule(payload) {
  try {
    const tabId = await activeTabId();
    await call("sendlater.schedule", { tabId, ...payload });
    window.close();
  } catch (e) {
    setStatus(status, e.message, true);
  }
}

async function renderList() {
  const list = document.getElementById("list");
  list.replaceChildren();
  const items = await call("sendlater.list");
  if (!items.length) {
    list.append(el("li", { className: "empty", text: "Nothing scheduled." }));
    return;
  }
  for (const item of items) {
    const label = item.status === "scheduled" ? `Sends ${fmt(item.sendAt)}` : `${item.status} (due ${fmt(item.sendAt)})`;
    list.append(
      el("li", {}, [
        el("div", { className: "subject", text: item.subject || "(no subject)" }),
        el("div", { className: "meta", text: `${label} · to ${(item.to || []).join(", ")}` }),
        el("div", { className: "actions" }, [
          el("button", {
            type: "button",
            text: item.status === "scheduled" ? "Cancel (keep draft)" : "Dismiss",
            onclick: async () => {
              await call("sendlater.cancel", { key: item.key }).catch(e => setStatus(status, e.message, true));
              renderList();
            },
          }),
        ]),
      ])
    );
  }
}

async function init() {
  const presets = await call("sendlater.presets");
  const box = document.getElementById("presets");
  for (const p of presets) box.append(presetButton(p, () => schedule({ preset: p.id })));
  const input = document.getElementById("when");
  input.value = toLocalInput(presets[0].when);
  document.getElementById("custom").addEventListener("submit", ev => {
    ev.preventDefault();
    schedule({ when: input.value });
  });
  await renderList();
}

init().catch(e => setStatus(status, e.message, true));
