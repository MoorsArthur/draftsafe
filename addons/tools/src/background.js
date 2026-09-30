// SPDX-License-Identifier: MIT
// User features and approval manager for the single Draftsafe add-on.

import { collect } from "../../shared/lib/mail.js";
import { parseWhen, presetById, sendLaterPresets, snoozePresets, tomorrowMorning, nextMondayMorning } from "../../shared/lib/time.js";
import { TICK_ALARM } from "./lib/constants.js";
import { createStore } from "./lib/store.js";
import { createSnooze } from "./features/snooze.js";
import { createFollowups } from "./features/followup.js";
import { createSendLater } from "./features/sendlater.js";

import { createApprovals } from "./approval/manager.js";

const api = globalThis.messenger;

function notify(title, message) {
  api.notifications
    .create({ type: "basic", title: `Draftsafe: ${title}`, message, iconUrl: "tools/icons/draftsafe.svg" })
    .catch(() => {});
}

const store = createStore(api.storage.local);
export const approvals = createApprovals({ api, store, notify, onTrustChange: updateTrustMenu });
// Available only to pages belonging to this add-on; never a runtime decision API.
globalThis.attachApprovalPage = (page, render) => approvals.attachPage(page, render);
api.windows.onRemoved.addListener(id => approvals.onWindowRemoved(id));

const snooze = createSnooze({ api, store, notify });
const followups = createFollowups({ api, store });
const sendLater = createSendLater({ api, store, notify });

// ----------------------------------------------------------------- ticks --

async function updateBadge() {
  try {
    const n = await followups.overdueCount();
    await api.browserAction.setBadgeText({ text: n ? String(n) : "" });
  } catch {
    // Badge is cosmetic.
  }
}

async function tick() {
  updateTrustMenu(approvals.trustRemaining());
  for (const job of [() => snooze.wakeDue(), () => sendLater.processDue(), updateBadge]) {
    try {
      await job();
    } catch (e) {
      console.error("draftsafe: tick job failed", e);
    }
  }
}

api.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === TICK_ALARM) {
    tick();
  }
});

// ----------------------------------------------------------------- menus --

const MENU = {
  snooze: "ds-snooze",
  followup: "ds-followup",
  trust: "ds-trust-agent",
};

function updateTrustMenu(remaining) {
  const title = remaining > 0
    ? `Stop trusting agent (${Math.ceil(remaining / 60000)} min left)`
    : "Trust agent for 1 hour";
  api.menus.update(MENU.trust, { title }).catch(() => {});
}

function createMenus() {
  api.menus.create({ id: MENU.trust, title: "Trust agent for 1 hour", contexts: ["browser_action", "message_list"] });
  api.menus.create({ id: MENU.snooze, title: "Snooze", contexts: ["message_list"] });
  for (const [id, title] of [
    ["later-today", "Later today"],
    ["tomorrow", "Tomorrow 08:00"],
    ["next-monday", "Next Monday 08:00"],
    ["custom", "Pick a date and time…"],
  ]) {
    api.menus.create({ id: `ds-snooze:${id}`, parentId: MENU.snooze, title, contexts: ["message_list"] });
  }
  api.menus.create({ id: MENU.followup, title: "Follow up", contexts: ["message_list"] });
  for (const [id, title] of [
    ["none", "No due date"],
    ["tomorrow", "Due tomorrow"],
    ["next-monday", "Due next Monday"],
    ["custom", "Pick a due date…"],
    ["done", "Mark as done"],
  ]) {
    api.menus.create({ id: `ds-followup:${id}`, parentId: MENU.followup, title, contexts: ["message_list"] });
  }
}

function openPicker(mode, ids) {
  const url = api.runtime.getURL(`tools/src/ui/pick-time.html?mode=${mode}&ids=${ids.join(",")}`);
  return api.windows.create({ type: "popup", url, width: 380, height: 260 });
}

api.menus.onClicked.addListener(async info => {
  if (info.menuItemId === MENU.trust) {
    approvals.onTrustMenuClick();
    return;
  }
  const [group, choice] = String(info.menuItemId).split(":");
  if (!choice || !info.selectedMessages) {
    return;
  }
  try {
    const { messages } = await collect(api, Promise.resolve(info.selectedMessages), 100);
    const ids = messages.map(m => m.id);
    if (!ids.length) {
      return;
    }
    if (group === "ds-snooze") {
      if (choice === "custom") {
        await openPicker("snooze", ids);
        return;
      }
      const preset = presetById(snoozePresets(), choice) || presetById(snoozePresets(), "tomorrow");
      await snooze.snooze(ids, preset.when);
    } else if (group === "ds-followup") {
      if (choice === "custom") {
        await openPicker("followup", ids);
        return;
      }
      for (const id of ids) {
        if (choice === "done") {
          await followups.clear(id);
        } else {
          const due = { none: null, tomorrow: tomorrowMorning(), "next-monday": nextMondayMorning() }[choice];
          await followups.set(id, { due });
        }
      }
      await updateBadge();
    }
  } catch (e) {
    notify("Action failed", String((e && e.message) || e));
  }
});

// ------------------------------------------------------ popup messaging --

function presetList(presets) {
  return presets.map(p => ({ id: p.id, label: p.label, when: p.when.toISOString() }));
}

function whenFrom(msg, presets) {
  if (msg.preset) {
    const p = presetById(presets, msg.preset);
    if (p) {
      return p.when;
    }
  }
  const d = parseWhen(msg.when);
  if (!d) {
    throw new Error("invalid date");
  }
  return d;
}

const uiBase = api.runtime.getURL("tools/src/ui/");

function idList(v) {
  if (!Array.isArray(v) || !v.length || v.length > 100 || !v.every(n => Number.isInteger(n) && n > 0)) {
    throw new Error("invalid message ids");
  }
  return v;
}

function oneId(v) {
  return idList([v])[0];
}

function keyOf(v) {
  if (typeof v !== "string" || !v || v.length > 1100) {
    throw new Error("invalid key");
  }
  return v;
}

const handlers = {
  "approval.history": () => approvals.history(),
  "snooze.presets": () => presetList(snoozePresets()),
  "snooze.displayed": async msg => {
    const shown = await api.messageDisplay.getDisplayedMessages(msg.tabId);
    const ids = (Array.isArray(shown) ? shown : (shown && shown.messages) || []).map(m => m.id);
    if (!ids.length) {
      throw new Error("no message is displayed");
    }
    return snooze.snooze(ids, whenFrom(msg, snoozePresets()));
  },
  "snooze.ids": msg => snooze.snooze(idList(msg.messageIds), whenFrom(msg, snoozePresets())),
  "snooze.list": () => snooze.list(),
  "snooze.cancel": msg => snooze.unsnooze(keyOf(msg.key)),
  "followup.list": () => followups.list(),
  "followup.setIds": async msg => {
    const due = msg.when ? whenFrom(msg, []) : null;
    for (const id of idList(msg.messageIds)) {
      await followups.set(id, { due });
    }
    await updateBadge();
    return true;
  },
  "followup.done": async msg => {
    await followups.clear(oneId(msg.messageId));
    await updateBadge();
    return true;
  },
  "followup.open": msg => api.messageDisplay.open({ messageId: oneId(msg.messageId), location: "tab" }),
  "sendlater.presets": () => presetList(sendLaterPresets()),
  "sendlater.list": () => sendLater.list(),
  "sendlater.cancel": msg => sendLater.cancel(keyOf(msg.key)),
  "sendlater.schedule": (msg, sender) => {
    // Only the compose-action popup, i.e. a click in the compose window.
    if (!sender.url || !sender.url.startsWith(`${uiBase}sendlater-popup.html`)) {
      throw new Error("send later can only be scheduled from the compose window");
    }
    if (!Number.isInteger(msg.tabId)) {
      throw new Error("invalid tab");
    }
    return sendLater.schedule(msg.tabId, whenFrom(msg, sendLaterPresets()));
  },
};

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== "string" || sender.id !== api.runtime.id) {
    return undefined;
  }
  if (!sender.url || !sender.url.startsWith(uiBase)) {
    return undefined;
  }
  const handler = Object.prototype.hasOwnProperty.call(handlers, msg.type) ? handlers[msg.type] : null;
  if (!handler) {
    return undefined;
  }
  return Promise.resolve()
    .then(() => handler(msg, sender))
    .then(
      result => ({ ok: true, result }),
      e => ({ ok: false, error: String((e && e.message) || e) })
    );
});

// ----------------------------------------------------------------- start --

async function main() {
  createMenus();
  api.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  followups.ensureTag().catch(e => console.error("draftsafe: could not create Follow up tag", e));
  await tick();
}

export const ready = main();
