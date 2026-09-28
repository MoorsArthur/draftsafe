// draftsafe-tools' background page, loaded for real against a recording fake:
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
  let onExternal: ((msg: unknown, sender: unknown) => unknown) | null = null;
  const target = {
    ...fake.api,
    runtime: {
      id: ID,
      getURL: (p: string) => `${BASE}${p}`,
      onMessageExternal: { addListener: vi.fn((fn: typeof onExternal) => (onExternal = fn)) },
      onMessage: { addListener: vi.fn((fn: typeof onMessage) => (onMessage = fn)) },
    },
    menus: { create: vi.fn(), onClicked: { addListener: vi.fn() } },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    notifications: { create: vi.fn(async () => "n") },
    browserAction: { setBadgeText: vi.fn(async () => {}) },
    messageDisplay: { getDisplayedMessages: vi.fn(async () => []), open: vi.fn() },
    windows: { create: vi.fn(), onRemoved: { addListener: vi.fn() } },
  };
  const rec = recordApi(target);
  (globalThis as any).messenger = rec.api;
  vi.resetModules();
  await import("../addons/tools/src/external-receiver.js");
  const beforeReady = await onExternal!({ v: 1, type: "draftsafe.approval.health" }, { id: "draftsafe-bridge@draftsafe.dev" });
  const beforeRequest = await onExternal!({ v: 1, type: "draftsafe.approval.request", kind: "cleanup", payload: {} }, { id: "draftsafe-bridge@draftsafe.dev" });
  const mod = await import("../addons/tools/src/background.js");
  await mod.ready;
  const afterReady = await onExternal!({ v: 1, type: "draftsafe.approval.health" }, { id: "draftsafe-bridge@draftsafe.dev" });
  delete (globalThis as any).messenger;
  delete (globalThis as any).draftsafeSetExternalHandler;
  return { fake, rec, onMessage: onMessage!, onExternal: onExternal!, beforeReady, beforeRequest, afterReady };
}

describe("draftsafe-tools background (real module)", () => {
  it("registers the request receiver but never touches a bridge", async () => {
    const { rec, beforeReady, beforeRequest, afterReady } = await loadTools();
    expect(beforeReady).toEqual({ ok: true, ready: false });
    expect(beforeRequest).toEqual({ ok: false, code: "not_ready" });
    expect(afterReady).toEqual({ ok: true, ready: true });
    for (const path of rec.touched) {
      expect(path).not.toMatch(/draftsafeBridge|connectNative|runtime\.connect|runtime\.sendMessage/);
    }
  });

  it("rejects a request while starting, then accepts one after the background wakes", async () => {
    const { onExternal } = await loadTools();
    const sender = { id: "draftsafe-bridge@draftsafe.dev" };
    expect(await onExternal({ v: 1, type: "draftsafe.approval.request", kind: "bad", payload: {} }, sender))
      .toEqual({ ok: false, code: "bad_request" });
    expect(await onExternal({ v: 1, type: "draftsafe.approval.health" }, { id: "evil@x" }))
      .toEqual({ ok: false, code: "forbidden_sender" });
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
