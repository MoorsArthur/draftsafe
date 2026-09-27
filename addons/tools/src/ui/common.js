// SPDX-License-Identifier: MIT
// Shared popup helpers. All mail-derived text goes through textContent only.

export async function call(type, payload = {}) {
  const res = await messenger.runtime.sendMessage({ type, ...payload });
  if (!res || !res.ok) {
    throw new Error((res && res.error) || "no response");
  }
  return res.result;
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") node.textContent = v;
    else if (k === "className") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export function setStatus(node, message, isError = false) {
  node.textContent = message;
  node.classList.toggle("error", isError);
}

export function fmt(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function presetButton(preset, onClick) {
  return el("button", { type: "button", onclick: () => onClick(preset) }, [
    el("span", { text: preset.label }),
    el("small", { text: fmt(preset.when) }),
  ]);
}

export async function activeTabId() {
  const [tab] = await messenger.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("no active tab");
  return tab.id;
}

/** ISO timestamp to an <input type="datetime-local"> value in local time. */
export function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
