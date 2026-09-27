// SPDX-License-Identifier: MIT
import { activeTabId, call, presetButton, setStatus, toLocalInput } from "./common.js";

const status = document.getElementById("status");

async function run(payload) {
  try {
    const tabId = await activeTabId();
    await call("snooze.displayed", { tabId, ...payload });
    window.close();
  } catch (e) {
    setStatus(status, e.message, true);
  }
}

async function init() {
  const presets = await call("snooze.presets");
  const box = document.getElementById("presets");
  for (const p of presets) box.append(presetButton(p, () => run({ preset: p.id })));
  const tomorrow = presets.find(p => p.id === "tomorrow");
  const input = document.getElementById("when");
  if (tomorrow) input.value = toLocalInput(tomorrow.when);
  document.getElementById("custom").addEventListener("submit", ev => {
    ev.preventDefault();
    run({ when: input.value });
  });
}

init().catch(e => setStatus(status, e.message, true));
