import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMessenger } from "./helpers/fake-messenger.js";
import { createStore } from "../addons/tools/src/lib/store.js";
import { createApprovals, APPROVAL_TIMEOUT_MS, canonical, sha256Text } from "../addons/tools/src/approval/manager.js";
import { validateCleanup, validateFolderChanges, validateUnsubscribe } from "../addons/shared/lib/approval-schema.js";
import { planCleanup } from "../addons/tools/src/approval/cleanup.js";
import { planFolderChanges } from "../addons/tools/src/approval/folder-changes.js";
import { planUnsubscribe, safeOneClickUrl } from "../addons/tools/src/approval/unsubscribe.js";
import { planState } from "../addons/tools/src/approval/state.js";
import { createRelay } from "../addons/bridge/src/bridge/relay.js";
import { createRoutes } from "../addons/bridge/src/bridge/routes.js";
import { createMailOps } from "../addons/shared/lib/mail-ops.js";

const BRIDGE = { id: "draftsafe-bridge@draftsafe.dev" };
const BASE = "moz-extension://tools/";
const folder = (name: string, specialUse: string[] = []) => ({ id: `account1://${name}`, accountId: "account1", name: name.split("/").at(-1)!, path: `/${name}`, specialUse });
function fixture() {
  const fake = createFakeMessenger({ withSaveMessage: true, extraFolders: [folder("Source"), folder("Target"), folder("Empty"), folder("Junk", ["junk"])] });
  const api: any = fake.api;
  api.runtime.id = "draftsafe-tools@draftsafe.dev";
  api.runtime.getURL = (p: string) => BASE + p;
  api.windows = { create: vi.fn(async () => ({ id: 55 })), update: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  api.permissions = { contains: vi.fn(async () => true), request: vi.fn(async () => true), remove: vi.fn(async () => true) };
  let clock = 1000;
  const manager = createApprovals({ api, store: createStore(api.storage.local), now: () => clock });
  const add = (subject = "Message", folderId = "account1://INBOX", extra = {}) => fake.addMessage({ folderId, subject, ...extra });
  const request = (kind: string, payload: any, sender: any = BRIDGE) => manager.handleExternal({ type: "draftsafe.approval.request", v: 1, kind, payload }, sender);
  const status = (r: any) => manager.handleExternal({ type: "draftsafe.approval.status", v: 1, requestId: r.requestId }, BRIDGE);
  // DOM stand-in for unit tests. Release code cannot manufacture trusted events;
  // the Xvfb smoke uses actual X11 pointer input on the real page.
  function page(r: any, decision: any, mutate = (_data: any) => {}, windowId = 55) {
    const listeners: any = {};
    const buttons: any = {};
    for (const name of ["apply", "deny", "status"]) buttons[name] = { addEventListener: (_type: string, fn: any) => { listeners[name] = fn; } };
    class MouseEvent { isTrusted: boolean; currentTarget: any; constructor(name: string, trusted: boolean) { this.currentTarget = buttons[name]; this.isTrusted = trusted; } }
    const win: any = { location: { href: api.windows.create.mock.calls.at(-1)?.[0]?.url },
      messenger: { windows: { getCurrent: async () => ({ id: windowId }) }, permissions: api.permissions },
      document: { getElementById: (id: string) => buttons[id] }, MouseEvent, close: vi.fn() };
    return { win, attach: () => manager.attachPage(win, (data: any) => { mutate(data); return () => decision; }),
      click: (name = "apply", trusted = true) => listeners[name](new MouseEvent(name, trusted)) };
  }
  return { fake, api, manager, add, request, status, page, advance: (ms: number) => { clock += ms; } };
}
afterEach(() => vi.useRealTimers());
const cleanup = (ids: number[], extra = {}) => ({ batches: [{ messageIds: ids, action: "trash", reason: "untrusted reason", ...extra }] });
const decision = { batches: [{ approved: true }] };

describe("approval boundary", () => {
  it("accepts only the bridge sender, with no external approval path", async () => {
    const f = fixture(); const m = f.add();
    for (const sender of [undefined, {}, { id: "evil" }, { id: f.api.runtime.id }]) {
      expect(await f.request("cleanup", cleanup([m.id]), sender || {})).toMatchObject({ ok: false });
    }
    expect(f.api.windows.create).not.toHaveBeenCalled();
    for (const type of ["approval.decide", "approve", "snooze.ids", "sendlater.schedule"]) {
      expect(await f.manager.handleExternal({ type, v: 1, approved: true }, BRIDGE)).toMatchObject({ ok: false });
    }
    expect(Object.keys(f.manager)).not.toContain("decide");
  });
  it("one pending request, one window, no change before click; deny changes nothing", async () => {
    const f = fixture(); const m = f.add(); const r = await f.request("cleanup", cleanup([m.id]));
    expect(r.ok).toBe(true);
    expect(await f.request("cleanup", cleanup([m.id]))).toMatchObject({ code: "busy" });
    expect(f.api.windows.create).toHaveBeenCalledTimes(1);
    expect(f.api.messages.move).not.toHaveBeenCalled();
    const p = f.page(r, decision); await p.attach(); p.click("deny");
    await vi.waitFor(async () => expect(await f.status(r)).toMatchObject({ outcome: { status: "denied" } }));
    expect(f.api.messages.move).not.toHaveBeenCalled();
    expect((await f.manager.history())[0]).toMatchObject({ status: "denied", kind: "cleanup" });
  });
  it("opens and focuses the window before slow unsubscribe headers finish, with visible progress", async () => {
    const f = fixture(); const m = f.add("News"), other = f.add("News 2");
    let release!: () => void;
    f.api.messages.getFull.mockImplementation((id: number) => id === m.id
      ? new Promise(resolve => { release = () => resolve({ headers: {} }); }) : Promise.resolve({ headers: {} }));
    const r = await f.request("unsubscribe", { items: [{ messageId: m.id }, { messageId: other.id }] });
    expect(r.ok).toBe(true);
    expect(f.api.windows.create).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("&n=2") }));
    expect(f.api.windows.update).toHaveBeenCalledWith(55, { drawAttention: true });
    expect(f.api.windows.update).toHaveBeenCalledWith(55, { focused: true });
    expect(await f.status(r)).toMatchObject({ status: "planning", progress: { total: 2 } });
    const p = f.page(r, { senders: [] });
    const attached = p.attach();
    await vi.waitFor(() => expect(p.win.document.getElementById("status").textContent).toContain("van 2 berichten"));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await vi.waitFor(async () => expect(await f.status(r)).toMatchObject({ status: "pending", progress: { done: 1, phase: "junk" } }));
    await attached;
    p.click("deny");
    await vi.waitFor(async () => expect(await f.status(r)).toMatchObject({ outcome: { status: "denied" } }));
  });
  it("rejects programmatic clicks, permits one trusted click and consumes it once", async () => {
    const f = fixture(); const a = f.add("A"), b = f.add("B");
    const r = await f.request("cleanup", cleanup([a.id, b.id]));
    const p = f.page(r, { batches: [{ approved: true, excluded: [b.id] }] }); await p.attach();
    p.click("apply", false); expect(f.api.messages.move).not.toHaveBeenCalled();
    p.click(); p.click();
    await vi.waitFor(async () => expect(await f.status(r)).toMatchObject({ outcome: { status: "approved", batches: [{ moved: 1, excluded: 1 }] } }));
    expect(f.api.messages.move).toHaveBeenCalledTimes(1);
    expect(f.fake.messages.get(b.id)?.folderId).toContain("INBOX");
  });
  it.each(["nonce", "hash"])("rejects a changed %s", async field => {
    const f = fixture(); const r = await f.request("cleanup", cleanup([f.add().id]));
    const p = f.page(r, decision, d => { d[field] = "forged"; }); await p.attach(); p.click();
    await vi.waitFor(() => expect(p.win.document.getElementById("status").textContent).toContain("gestopt"));
    expect(f.api.messages.move).not.toHaveBeenCalled();
    f.manager.onWindowRemoved(55);
  });
  it("rejects exact-plan tampering and decisions with foreign exclusions", async () => {
    const f = fixture(); const r = await f.request("cleanup", cleanup([f.add().id]));
    const p = f.page(r, decision, d => { d.view.batches[0].reason = "altered"; }); await p.attach(); p.click();
    await vi.waitFor(async () => expect(await f.status(r)).toMatchObject({ outcome: { status: "failed" } }));
    expect(f.api.messages.move).not.toHaveBeenCalled();
    const plan = await planCleanup(f.api, validateCleanup(cleanup([f.add().id])));
    expect(() => plan.readDecision({ batches: [{ approved: true, excluded: [999] }] })).toThrow();
  });
  it("refuses a page from another window and an expired click even before timer dispatch", async () => {
    const f = fixture(); const r = await f.request("cleanup", cleanup([f.add().id]));
    await expect(f.page(r, decision, () => {}, 66).attach()).rejects.toThrow();
    const p = f.page(r, decision); await p.attach(); f.advance(APPROVAL_TIMEOUT_MS); p.click();
    expect(f.api.messages.move).not.toHaveBeenCalled(); f.manager.onWindowRemoved(55);
  });
  it("expires and closes after ten minutes", async () => {
    vi.useFakeTimers(); const f = fixture(); const r = await f.request("cleanup", cleanup([f.add().id]));
    f.advance(APPROVAL_TIMEOUT_MS); await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
    expect(await f.status(r)).toMatchObject({ outcome: { status: "expired" } });
    expect(f.api.windows.remove).toHaveBeenCalledWith(55);
    expect(f.api.messages.move).not.toHaveBeenCalled();
  });
  it("window close denies and records the outcome", async () => {
    const f = fixture(); const r = await f.request("cleanup", cleanup([f.add().id])); f.manager.onWindowRemoved(55);
    await vi.waitFor(async () => expect(await f.status(r)).toMatchObject({ outcome: { status: "closed" } }));
    expect(f.api.messages.move).not.toHaveBeenCalled();
  });
  it("binds hashes to values independent of key order", async () => {
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
    expect(await sha256Text(canonical({ ids: [1, 2] }))).not.toBe(await sha256Text(canonical({ ids: [1, 3] })));
  });
});

describe("schemas and folder execution", () => {
  it("caps the whole request, rejects duplicates and unknown keys", () => {
    expect(() => validateCleanup(cleanup(Array.from({ length: 2001 }, (_, i) => i + 1)))).toThrow();
    expect(() => validateCleanup({ batches: [...cleanup(Array.from({ length: 1001 }, (_, i) => i + 1)).batches, ...cleanup(Array.from({ length: 1000 }, (_, i) => i + 2000)).batches] })).toThrow();
    expect(() => validateCleanup(cleanup([1, 1]))).toThrow();
    for (const k of ["approved", "nonce", "hash", "url", "send", "permanent", "__proto__"]) {
      expect(() => validateCleanup({ batches: [{ ...cleanup([1]).batches[0], [k]: true }] })).toThrow();
    }
    expect(() => validateUnsubscribe({ items: [{ messageId: 1, url: "https://evil.example" }] })).toThrow();
  });
  it("property: special-use destinations and their ancestors always refuse moves", async () => {
    for (const use of ["trash", "archives", "sent", "junk", "outbox", "drafts", "templates", "future-special"]) {
      const f = fixture(); const m = f.add(); f.fake.folders.push(folder("Parent"), folder("Parent/Special", [use]));
      for (const path of ["Parent", "Parent/Special"]) await expect(planCleanup(f.api, validateCleanup(cleanup([m.id], { action: "move", folder: path })))).rejects.toThrow();
      for (const action of ["rename", "merge", "delete_empty"]) await expect(planFolderChanges(f.api, validateFolderChanges({ changes: [{ action, folder: "account1://Parent", ...(action === "rename" ? { newName: "Renamed" } : action === "merge" ? { into: "account1://Target" } : {}) }] }))).rejects.toThrow();
      expect(f.api.messages.move).not.toHaveBeenCalled();
    }
  });
  it("restores mail to Inbox but refuses other protected move destinations", async () => {
    const f = fixture();
    const mail = f.add("Restore", "account1://Source");
    const plan = await planCleanup(f.api, validateCleanup(cleanup([mail.id], { action: "move", folder: "INBOX" })));
    expect((await plan.execute(decision)).batches[0]).toMatchObject({ moved: 1, failed: 0 });
    expect(f.api.messages.move).toHaveBeenCalledWith([mail.id], "account1://INBOX");
    for (const path of ["Trash", "Archive", "Drafts", "Junk", "Sent"]) {
      if (path === "Sent") f.fake.folders.push(folder("Sent", ["sent"]));
      await expect(planCleanup(f.api, validateCleanup(cleanup([f.add().id], { action: "move", folder: path })))).rejects.toMatchObject({ code: "forbidden_folder" });
    }
    await expect(planCleanup(f.api, { batches: [{ action: "move", messageIds: [f.add().id], folder: [], reason: "root" }] } as any))
      .rejects.toMatchObject({ code: "forbidden_folder" });
    const another = f.add("Restore later", "account1://Source");
    const recheck = await planCleanup(f.api, validateCleanup(cleanup([another.id], { action: "move", folder: "INBOX" })));
    f.fake.folders.find(folder => folder.id === "account1://INBOX")!.specialUse = ["inbox", "trash"];
    expect((await recheck.execute(decision)).batches[0]).toMatchObject({ moved: 0, failed: 1 });
  });
  it("trash/archive use only their account special-use folder", async () => {
    for (const [action, id] of [["trash", "account1://Trash"], ["archive", "account1://Archive"]]) {
      const f = fixture(); const p = await planCleanup(f.api, validateCleanup(cleanup([f.add().id], { action })));
      await p.execute(decision); expect(f.api.messages.move.mock.calls[0][1]).toBe(id);
    }
  });
  it("move creates at most two levels, checks names and honours exclusions", async () => {
    const f = fixture(); const a = f.add();
    const p = await planCleanup(f.api, validateCleanup(cleanup([a.id], { action: "move", folder: "Clients/Acme", createFolder: true })));
    expect(f.api.folders.create).not.toHaveBeenCalled(); expect(p.view.batches[0].destinations[0].creates).toEqual(["Clients", "Acme"]);
    expect((await p.execute(decision)).batches[0].moved).toBe(1);
    for (const path of ["One/Two/Three", ".hidden", "Trash/Foo", "A/<script>"]) await expect(planCleanup(f.api, validateCleanup(cleanup([f.add().id], { action: "move", folder: path, createFolder: true })))).rejects.toThrow();
  });
  it("rechecks destinations and message identity after approval", async () => {
    const f = fixture(); const a = f.add();
    const p = await planCleanup(f.api, validateCleanup(cleanup([a.id], { action: "move", folder: "Target" })));
    f.fake.folders.find(f => f.name === "Target")!.specialUse = ["trash"];
    expect((await p.execute(decision)).batches[0].failed).toBe(1);
    f.fake.folders.find(f => f.name === "Target")!.specialUse = [];
    const q = await planCleanup(f.api, validateCleanup(cleanup([a.id]))); a.headerMessageId = "changed";
    expect((await q.execute(decision)).batches[0].failed).toBe(1); expect(f.api.messages.move).not.toHaveBeenCalled();
  });
  it("merge snapshots membership, preserves excluded/new mail and never deletes", async () => {
    const f = fixture(); const a = f.add("A", "account1://Source"), b = f.add("B", "account1://Source");
    const p = await planFolderChanges(f.api, validateFolderChanges({ changes: [{ action: "merge", folder: "account1://Source", into: "account1://Target" }] }));
    const c = f.add("New mail", "account1://Source");
    expect(p.view.previews[0].before).toBeTruthy();
    expect((await p.execute({ changes: [{ approved: true, excluded: [b.id] }] })).changes[0].result).toBe("kept_not_empty");
    expect(f.api.messages.move).toHaveBeenCalledWith([a.id], "account1://Target");
    expect(f.fake.messages.get(c.id)?.folderId).toBe("account1://Source"); expect(f.api.folders.move).not.toHaveBeenCalled();
  });
  it("merge moves a now-empty source folder recoverably to Trash", async () => {
    const f = fixture(); f.add("A", "account1://Source");
    const p = await planFolderChanges(f.api, validateFolderChanges({ changes: [{ action: "merge", folder: "account1://Source", into: "account1://Target" }] }));
    expect(p.view.previews[0].before.find((n: any) => n.name === "Source").depth).toBe(1);
    expect(p.view.previews[0].after.find((n: any) => n.name === "Source").depth).toBe(2);
    expect((await p.execute({ changes: [{ approved: true }] })).changes[0].result).toBe("done");
    expect(f.api.folders.move).toHaveBeenCalledWith("account1://Source", "account1://Trash");
    expect(f.fake.forbidden.messagesDelete).not.toHaveBeenCalled();
  });
  it("merge total membership cap is 2000, including across changes", async () => {
    const f = fixture(); for (let i = 0; i < 2001; i++) f.add(`M${i}`, "account1://Source");
    await expect(planFolderChanges(f.api, validateFolderChanges({ changes: [{ action: "merge", folder: "account1://Source", into: "account1://Target" }] }))).rejects.toThrow(/at most/);
  });
  it.each(["new message", "new child"])("delete_empty rechecks %s after the window opens", async kind => {
    const f = fixture(); const p = await planFolderChanges(f.api, validateFolderChanges({ changes: [{ action: "delete_empty", folder: "account1://Empty" }] }));
    if (kind === "new message") f.add("Late", "account1://Empty"); else f.fake.folders.push(folder("Empty/Child"));
    expect((await p.execute({ changes: [{ approved: true }] })).changes[0].result).toBe("refused"); expect(f.api.folders.move).not.toHaveBeenCalled();
  });
  it("legacy read/tag/draft requests do no work unless approved", async () => {
    const f = fixture(); const a = f.add();
    for (const [route, params] of [["messages.markRead", { messageId: a.id }], ["messages.setTags", { messageId: a.id, add: ["Work"] }], ["followups.set", { messageId: a.id }], ["drafts.create", { subject: "Draft", body: "Body" }]]) {
      const p = await planState(f.api, { route, params }); await p.execute({ changes: [{ approved: false }] });
    }
    expect(f.api.messages.update).not.toHaveBeenCalled(); expect(f.api.messages.saveMessage).not.toHaveBeenCalled();
    const p = await planState(f.api, { route: "messages.markRead", params: { messageId: a.id } });
    await p.execute({ changes: [{ approved: true }] }); expect(a.read).toBe(true);
  });
  it("returns classification and folder metadata without mutation", async () => {
    const f = fixture(); const m = f.add("List", "account1://INBOX", { headers: { "List-Unsubscribe": ["<mailto:x@example.test>"], "List-Id": ["news.example.test"], Precedence: ["bulk"] } });
    const ops = createMailOps({ api: f.api }); const full = await ops.getMessage(m.id, 100);
    expect(full.message).toMatchObject({ hasListUnsubscribe: true, listId: "news.example.test", precedence: "bulk", fromDomain: "example.test" });
    const detailed = await ops.listFoldersDetailed();
    expect(detailed.folders.find((f: any) => f.id.endsWith("INBOX"))).toMatchObject({ count: 1, unread: 1, oldest: m.date.toISOString(), newest: m.date.toISOString(), subfolders: [] });
    expect(f.api.messages.update).not.toHaveBeenCalled();
  });
});

describe("unsubscribe provenance and relay", () => {
  const headers = { "list-unsubscribe": ["<https://news.example.test/u?id=mailbox>"], "list-unsubscribe-post": ["List-Unsubscribe=One-Click"] };
  it("only POSTs the message-derived URL after approval and host permission", async () => {
    const f = fixture(); const fetchImpl = vi.fn(async () => ({ ok: true })); const m = f.add("News", "account1://INBOX", { headers });
    const p = await planUnsubscribe(f.api, validateUnsubscribe({ items: [{ messageId: m.id, reason: "stop" }] }), { fetchImpl });
    await p.execute({ senders: [{ approved: false }] }); expect(fetchImpl).not.toHaveBeenCalled();
    await p.execute({ senders: [{ approved: true }] });
    expect(fetchImpl).toHaveBeenCalledWith("https://news.example.test/u?id=mailbox", expect.objectContaining({ method: "POST", body: "List-Unsubscribe=One-Click", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }));
    expect(f.api.permissions.remove).toHaveBeenCalledWith({ origins: ["https://news.example.test/*"] });
  });
  it("changed headers, excluded source or denied host permission prevent POSTs", async () => {
    for (const change of ["url", "excluded", "permission"]) {
      const f = fixture(); const fetchImpl = vi.fn(); const m = f.add("News", "account1://INBOX", { headers });
      const p = await planUnsubscribe(f.api, { items: [{ messageId: m.id }] }, { fetchImpl });
      if (change === "url") m.headers = { ...headers, "list-unsubscribe": ["<https://evil.example.test/> "] };
      if (change === "permission") f.api.permissions.contains.mockResolvedValue(false);
      await p.execute({ senders: [{ approved: true, excluded: change === "excluded" ? [m.id] : [] }] }); expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
  it("Junk defaults off and manual links never fetch or send", async () => {
    const f = fixture(); const fetchImpl = vi.fn(); const junk = f.add("Junk", "account1://Junk", { headers });
    const p = await planUnsubscribe(f.api, { items: [{ messageId: junk.id }] }, { fetchImpl });
    expect(p.view.senders[0]).toMatchObject({ inJunk: true, defaultChecked: false });
    for (const raw of ["<mailto:leave@example.test>", "<https://news.example.test/page>"]) {
      const m = f.add("Manual", "account1://INBOX", { headers: { "list-unsubscribe": [raw] } });
      const manual = await planUnsubscribe(f.api, { items: [{ messageId: m.id }] }, { fetchImpl });
      await manual.execute({ senders: [{ approved: true }] });
    }
    expect(fetchImpl).not.toHaveBeenCalled(); expect(f.fake.forbidden.composeSendMessage).not.toHaveBeenCalled();
  });
  it("bounds unsubscribe reads to four and records failed or timed-out messages as unreadable", async () => {
    const f = fixture();
    const ids = Array.from({ length: 6 }, () => f.add("News").id);
    let active = 0, peak = 0;
    f.api.messages.getFull.mockImplementation(async (id: number) => {
      active++; peak = Math.max(active, peak);
      try {
        if (id === ids[0]) return await new Promise(() => {});
        if (id === ids[1]) throw new Error("offline");
        await new Promise(resolve => setTimeout(resolve, 2));
        return { headers };
      } finally { active--; }
    });
    const progress: number[] = [];
    const plan = await planUnsubscribe(f.api, { items: ids.map(messageId => ({ messageId })) }, { headerTimeoutMs: 20, onProgress: (n: number) => progress.push(n) });
    expect(peak).toBeLessThanOrEqual(4);
    expect(progress).toContain(6);
    expect(plan.view.unreadable).toEqual(expect.arrayContaining([ids[0], ids[1]]));
    expect(plan.view.senders).toHaveLength(1);
    const result = await plan.execute({ senders: [{ approved: false }] });
    expect(result.items.filter((item: any) => item.result === "unreadable")).toHaveLength(2);
  });
  it("unselected Junk mail defaults its sender off, and distinct lists stay separate", async () => {
    const f = fixture();
    f.add("Unselected junk", "account1://Junk", { headers });
    const a = f.add("Newsletter", "account1://INBOX", { headers });
    const b = f.add("Other list", "account1://INBOX", { headers: { ...headers, "list-unsubscribe": ["<https://other.example.test/u>"] } });
    const p = await planUnsubscribe(f.api, { items: [{ messageId: a.id }, { messageId: b.id }] });
    expect(p.view.senders).toHaveLength(2);
    for (const s of p.view.senders) expect(s).toMatchObject({ inJunk: true, defaultChecked: false });
  });
  it("property: refuses unsafe URL protocols, credentials, IPs, local hosts and ports", () => {
    for (const raw of ["http://news.example/u", "mailto:leave@x", "javascript:alert(1)", "https://127.0.0.1/", "https://[::1]/", "https://2130706433/", "https://0x7f000001/", "https://user:pass@news.example/", "https://news.local/", "https://news.example:8443/"]) expect(safeOneClickUrl(raw), raw).toBeNull();
  });
  it("relay acknowledges promptly and polls status separately without a decision API", async () => {
    const api = { runtime: { sendMessage: vi.fn().mockResolvedValueOnce({ ok: true, ready: true }).mockResolvedValueOnce({ ok: true, requestId: "id" }).mockResolvedValueOnce({ ok: true, status: "pending" }).mockResolvedValueOnce({ ok: true, status: "done", outcome: { status: "denied" } }) } };
    const relay = createRelay({ api, sleep: async () => {} });
    expect(await relay("cleanup", cleanup([1]))).toEqual({ requestId: "id" });
    expect(await relay.status("id")).toMatchObject({ status: "pending" });
    expect(await relay.status("id")).toMatchObject({ status: "done", outcome: { status: "denied" } });
    for (const [id, msg] of api.runtime.sendMessage.mock.calls) { expect(id).toBe("draftsafe-tools@draftsafe.dev"); expect(["draftsafe.approval.health", "draftsafe.approval.request", "draftsafe.approval.status"]).toContain(msg.type); }
  });
  it("reports an already occupied Tools slot as pending elsewhere", async () => {
    const api = { runtime: { sendMessage: vi.fn(async (_id, msg) => msg.type.endsWith("health") ? { ok: true, ready: true } : { ok: false, code: "busy" }) } };
    const relay = createRelay({ api });
    await expect(relay("cleanup", cleanup([1]))).rejects.toMatchObject({ code: "pending_elsewhere" });
    expect(api.runtime.sendMessage.mock.calls.filter(([, m]) => m.type.endsWith("request"))).toHaveLength(1);
  });
  it("wakes Tools after a suspended background and waits for its late startup", async () => {
    let time = 0;
    let checks = 0;
    const api = { runtime: { sendMessage: vi.fn(async (_id, msg) => {
      if (msg.type.endsWith("health")) {
        checks++;
        if (checks === 1) throw new Error("receiving end does not exist");
        return { ok: true, ready: checks >= 3 };
      }
      if (msg.type.endsWith("request")) return { ok: true, requestId: "id" };
      return { ok: true, status: "done", outcome: { status: "denied" } };
    }) } };
    const relay = createRelay({ api, now: () => time, sleep: async ms => { time += ms; } });
    expect(await relay("cleanup", cleanup([1]))).toEqual({ requestId: "id" });
    expect(checks).toBe(3);
    expect(api.runtime.sendMessage.mock.calls.filter(([, m]) => m.type.endsWith("request"))).toHaveLength(1);
  });
  it("reports a failed health check clearly and never sends a request", async () => {
    let time = 0;
    const api = { runtime: { sendMessage: vi.fn(async () => { throw new Error("receiving end does not exist"); }) } };
    const relay = createRelay({ api, now: () => time, sleep: async ms => { time += ms; }, readyTimeoutMs: 250 });
    expect(await relay.health()).toEqual({ ready: false, code: "unavailable" });
    await expect(relay("cleanup", cleanup([1]))).rejects.toMatchObject({ code: "tools_unavailable", status: 503 });
    expect(api.runtime.sendMessage.mock.calls.every(([, m]) => m.type.endsWith("health"))).toBe(true);
  });
  it("includes Tools readiness in the bridge health response", async () => {
    const api = { runtime: { sendMessage: vi.fn(async () => { throw new Error("missing receiver"); }) } };
    const relay = createRelay({ api });
    const routes = createRoutes({ ops: { health: async () => ({ status: "ok" }) }, version: "0.3.1", relay });
    expect(await routes.health({})).toEqual({ status: "ok", version: "0.3.1", tools: { ready: false, code: "unavailable" } });
  });
  it("does not replay an approval request after an ambiguous delivery failure", async () => {
    const api = { runtime: { sendMessage: vi.fn(async (_id, msg) => {
      if (msg.type.endsWith("health")) return { ok: true, ready: true };
      throw new Error("reply lost after delivery");
    }) } };
    const relay = createRelay({ api });
    await expect(relay("cleanup", cleanup([1]))).rejects.toMatchObject({ code: "delivery_unknown" });
    expect(api.runtime.sendMessage.mock.calls.filter(([, m]) => m.type.endsWith("request"))).toHaveLength(1);
  });
});
