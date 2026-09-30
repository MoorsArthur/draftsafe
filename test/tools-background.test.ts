// Draftsafe's user-feature background page, loaded against a recording fake:
//   - it registers no external-messaging or bridge surface;
//   - only its own popups (same extension id, own UI URL) reach its handlers;
//   - send later can only be scheduled from the compose-window popup.
import { describe, expect, it, vi } from "vitest";
import { createFakeMessenger } from "./helpers/fake-messenger.js";
import { recordApi } from "./helpers/recorder.js";

const ID = "draftsafe-tools@draftsafe.dev";
const BASE = `moz-extension://uuid/`;

async function loadTools() {
  const fake = createFakeMessenger();
  let onMessage: ((msg: unknown, sender: unknown) => unknown) | null = null;
  let onMenuClick: ((info: any) => unknown) | null = null;
  const target = {
    ...fake.api,
    runtime: {
      id: ID,
      getURL: (p: string) => `${BASE}${p}`,
      onMessageExternal: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn((fn: typeof onMessage) => (onMessage = fn)) },
    },
    menus: { create: vi.fn(), update: vi.fn(async () => {}), onClicked: { addListener: vi.fn((fn: typeof onMenuClick) => (onMenuClick = fn)) } },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    notifications: { create: vi.fn(async () => "n") },
    permissions: { request: vi.fn(async () => true), contains: vi.fn(async () => true), remove: vi.fn(async () => true) },
    browserAction: { setBadgeText: vi.fn(async () => {}) },
    messageDisplay: { getDisplayedMessages: vi.fn(async () => []), open: vi.fn() },
    windows: { create: vi.fn(), onRemoved: { addListener: vi.fn() } },
  };
  const rec = recordApi(target);
  (globalThis as any).messenger = rec.api;
  vi.resetModules();
  const mod = await import("../addons/tools/src/background.js");
  await mod.ready;
  delete (globalThis as any).messenger;
  return { fake, rec, onMessage: onMessage!, onMenuClick: onMenuClick!, target, approvals: mod.approvals };
}

describe("draftsafe-tools background (real module)", () => {
  it("exposes local request/status methods but no external receiver", async () => {
    const { rec, target, approvals } = await loadTools();
    expect(typeof approvals.request).toBe("function");
    expect(typeof approvals.status).toBe("function");
    expect(target.runtime.onMessageExternal.addListener).not.toHaveBeenCalled();
    for (const path of rec.touched) {
      expect(path).not.toMatch(/draftsafeBridge|connectNative|runtime\.connect|runtime\.sendMessage/);
    }
  });

  it("rejects invalid local approval requests", async () => {
    const { approvals } = await loadTools();
    expect(await approvals.request("bad", {}))
      .toEqual({ ok: false, code: "bad_request" });
  });

  it("does not accept approval decisions through runtime messages", async () => {
    const { onMessage } = await loadTools();
    expect(onMessage({ type: "approval.decide", approved: true }, { id: ID, url: `${BASE}tools/src/ui/approve.html` })).toBeUndefined();
  });

  it("starts and revokes trust from Thunderbird's native menu listener only", async () => {
    const { onMenuClick, approvals, target } = await loadTools();
    expect(approvals.trustRemaining()).toBe(0);
    expect(target.notifications.create).not.toHaveBeenCalled();
    await onMenuClick({ menuItemId: "ds-trust-agent" });
    expect(target.permissions.request).toHaveBeenCalledWith({ origins: ["https://*/*"] });
    expect(target.notifications.create).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("vertrouwd") }));
    expect(target.menus.update).toHaveBeenCalledWith("ds-trust-agent", expect.objectContaining({ title: expect.stringContaining("Stop") }));
    await onMenuClick({ menuItemId: "ds-trust-agent" });
    expect(target.menus.update).toHaveBeenCalledWith("ds-trust-agent", { title: "Trust agent for 1 hour" });
  });

  it("ignores messages from other extensions, content or foreign pages (fuzzed)", async () => {
    const { fake, onMessage } = await loadTools();
    const scheduleSpy = fake.api.compose.saveMessage;
    const types = ["sendlater.schedule", "sendlater.cancel", "snooze.ids", "followup.setIds", "snooze.cancel"];
    const senders = [
      { id: "draftsafe-bridge@draftsafe.dev", url: `${BASE}tools/src/ui/sendlater-popup.html` },
      { id: "evil@x", url: `${BASE}tools/src/ui/sendlater-popup.html` },
      { id: ID, url: "https://evil.example/" },
      { id: ID, url: `${BASE}bridge/background.html` },
      { id: ID, url: undefined },
      { id: ID, url: `${BASE}tools/src/uiX/sendlater-popup.html` },
    ];
    for (const type of types) {
      for (const sender of senders) {
        const r = onMessage({ type, tabId: 1, messageIds: [1], key: "k", preset: "tomorrow" }, sender);
        expect(r, `${type} from ${JSON.stringify(sender)}`).toBeUndefined();
      }
    }
    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(fake.forbidden.composeSendMessage).not.toHaveBeenCalled();
  });

  it("send later is only accepted from the compose-window popup", async () => {
    const { fake, onMessage } = await loadTools();
    const tab = await fake.api.compose.beginNew(undefined, { to: ["bob@example.test"], subject: "x" });
    const fromFollowups = await onMessage(
      { type: "sendlater.schedule", tabId: tab.id, preset: "tomorrow" },
      { id: ID, url: `${BASE}tools/src/ui/followups-popup.html` }
    );
    expect(fromFollowups).toMatchObject({ ok: false, error: expect.stringMatching(/compose window/) });
    expect(fake.api.compose.saveMessage).not.toHaveBeenCalled();
    const fromCompose = await onMessage(
      { type: "sendlater.schedule", tabId: tab.id, preset: "tomorrow" },
      { id: ID, url: `${BASE}tools/src/ui/sendlater-popup.html` }
    );
    expect(fromCompose).toMatchObject({ ok: true });
    expect(fake.forbidden.composeSendMessage).not.toHaveBeenCalled(); // scheduled, not sent
  });

  it("validates popup input", async () => {
    const { onMessage } = await loadTools();
    const own = { id: ID, url: `${BASE}tools/src/ui/pick-time.html` };
    expect(await onMessage({ type: "snooze.ids", messageIds: ["1"], preset: "tomorrow" }, own)).toMatchObject({ ok: false });
    expect(await onMessage({ type: "followup.done", messageId: { x: 1 } }, own)).toMatchObject({ ok: false });
  });
});
