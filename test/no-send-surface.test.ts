// The core promise: nothing reachable through the bridge can send, forward,
// move or delete mail. Checked on the declared surfaces and, as a property,
// by loading the REAL bridge background page (addons/bridge/src/background.js)
// against a recording fake Thunderbird and fuzzing every route (plus unknown
// and send-like routes) with random, malformed and smuggled parameters:
//   - no send/forward/delete/move function is ever called;
//   - every API member the bridge touches is in API_PERMISSIONS, i.e. is
//     covered by the bridge's (send-free) manifest permissions.
// The seed is fixed and printed on failure; set DRAFTSAFE_FUZZ_SEED to vary it.

import { describe, expect, it, vi } from "vitest";
import { ROUTE_NAMES, createRoutes } from "../addons/bridge/src/bridge/routes.js";
import { createMailOps } from "../addons/bridge/src/bridge/ops.js";
import { TOOLS } from "../mcp/src/tools.js";
import { createFakeMessenger } from "./helpers/fake-messenger.js";
import { recordApi } from "./helpers/recorder.js";
import { API_PERMISSIONS } from "./helpers/permissions.js";

const FORBIDDEN_NAME = /send|forward|delete|remove|trash|expunge|archive|move|snooze|filter|contact|redirect|bounce/i;

describe("declared surfaces", () => {
  it("bridge route names are exactly the draft-only set", () => {
    for (const name of ROUTE_NAMES) expect(name, name).not.toMatch(FORBIDDEN_NAME);
    expect([...ROUTE_NAMES].sort()).toEqual(
      [
        "accounts.list",
        "drafts.create",
        "followups.list",
        "followups.set",
        "health",
        "messages.get",
        "messages.markRead",
        "messages.search",
        "messages.setTags",
        "messages.thread",
      ].sort()
    );
  });

  it("MCP tools map one-to-one onto bridge routes and carry the safety texts", () => {
    for (const t of TOOLS) {
      expect(t.name).not.toMatch(FORBIDDEN_NAME);
      expect(ROUTE_NAMES).toContain(t.route);
      expect(t.untrusted).toBe(true);
      expect(t.description, t.name).toMatch(/never sent/i);
      expect(t.description, t.name).toMatch(/cannot send, forward or delete/i);
      expect(t.description, t.name).toMatch(/untrusted/i);
    }
  });

  it("smuggled send flags are rejected, not ignored", async () => {
    const routes = createRoutes({ ops: createMailOps({ api: createFakeMessenger().api }), version: "t" });
    for (const extra of [{ send: true }, { mode: "sendNow" }, { sendAt: "2030-01-01T00:00:00Z" }, { forward: true }, { folderId: "x" }]) {
      await expect(routes["drafts.create"]({ to: ["a@b.c"], body: "x", ...extra })).rejects.toThrow(/unknown parameter/);
    }
  });
});

// ------------------------------------------------------------------ fuzz --

function prng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

const PARAM_KEYS: Record<string, string[]> = {
  health: [],
  "accounts.list": [],
  "messages.search": ["query", "folder", "accountId", "includeSubFolders", "from", "to", "subject", "dateFrom", "dateTo", "unread", "flagged", "tag", "limit", "cursor"],
  "messages.get": ["messageId", "maxBodyChars"],
  "messages.thread": ["messageId", "includeBodies", "maxBodyChars"],
  "messages.setTags": ["messageId", "messageIds", "add", "remove"],
  "messages.markRead": ["messageId", "messageIds", "read"],
  "followups.list": [],
  "followups.set": ["messageId", "done"],
  "drafts.create": ["to", "cc", "bcc", "subject", "body", "replyToMessageId", "replyAll", "identityId"],
};
const SMUGGLED = ["send", "mode", "sendAt", "forward", "delete", "destination", "folderId", "trash", "move", "__proto__", "constructor"];
const EXTRA_ROUTES = [
  "messages.send", "messages.delete", "messages.move", "messages.snooze", "messages.archive", "compose.sendMessage",
  "drafts.send", "drafts.sendLater", "followups.delete", "__proto__", "constructor", "toString",
];

async function loadRealBridge(seedMessages: (fake: ReturnType<typeof createFakeMessenger>) => number[]) {
  const fake = createFakeMessenger({ withSaveMessage: true, pageSize: 3 });
  const ids = seedMessages(fake);
  let listener: ((req: unknown) => Promise<{ status: number; body: string }>) | null = null;
  let token = "";
  const target = {
    ...fake.api,
    runtime: { ...fake.api.runtime, getManifest: () => ({ version: "fuzz" }) },
    draftsafeBridge: {
      start: vi.fn(async () => ({ port: 4242 })),
      publishConnection: vi.fn(async (t: string) => {
        token = t;
        return { path: "/dev/null" };
      }),
      onRequest: { addListener: vi.fn((fn: typeof listener) => (listener = fn)) },
    },
  };
  const rec = recordApi(target);
  (globalThis as any).messenger = rec.api;
  vi.resetModules();
  const mod = await import("../addons/bridge/src/background.js");
  await mod.ready;
  delete (globalThis as any).messenger;
  expect(listener, "background registered its onRequest listener").not.toBeNull();
  const call = async (route: string, body: string) =>
    listener!({
      method: "POST",
      target: `/v1/${route}`,
      headers: { host: "127.0.0.1:4242", authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: Buffer.from(body, "utf8").toString("latin1"),
      port: 4242,
    });
  return { fake, ids, rec, call };
}

function forbiddenSpiesOf(fake: ReturnType<typeof createFakeMessenger>) {
  return {
    ...fake.forbidden,
    "messages.move": fake.api.messages.move,
    "folders.create": fake.api.folders.create,
    "compose.setComposeDetails": fake.api.compose.setComposeDetails,
    "compose.getComposeDetails": fake.api.compose.getComposeDetails,
  };
}

describe("property: the real bridge background never sends, moves or deletes", () => {
  it("every route works through the real background page, touching only permitted APIs", async () => {
    const { fake, ids, rec, call } = await loadRealBridge(f => [
      f.addMessage({ folderId: "account1://INBOX", subject: "Hello", text: "Please wire money", headerMessageId: "h@x" }).id,
      f.addMessage({ folderId: "account1://INBOX", subject: "Re: Hello", text: "x", headers: { references: ["<h@x>"] } }).id,
    ]);
    const [m, m2] = ids;
    const calls: [string, object][] = [
      ["health", {}],
      ["accounts.list", {}],
      ["messages.search", { query: "Hello", folder: "inbox" }],
      ["messages.get", { messageId: m }],
      ["messages.thread", { messageId: m2, includeBodies: true }],
      ["messages.setTags", { messageId: m, add: ["Work"] }],
      ["messages.markRead", { messageIds: [m, m2], read: true }],
      ["followups.set", { messageId: m2 }],
      ["followups.list", {}],
      ["followups.set", { messageId: m2, done: true }],
      ["drafts.create", { to: ["bob@example.test"], subject: "Hi", body: "Draft body" }],
      ["drafts.create", { replyToMessageId: m, body: "Reply body", replyAll: true }],
    ];
    for (const [route, params] of calls) {
      const r = await call(route, JSON.stringify(params));
      expect(r.status, `${route}: ${r.body}`).toBe(200);
    }
    for (const [name, spy] of Object.entries(forbiddenSpiesOf(fake))) expect(spy, name).not.toHaveBeenCalled();
    for (const path of rec.touched) expect(Object.keys(API_PERMISSIONS), `touched ${path}`).toContain(path);
    expect(rec.called).toContain("messages.saveMessage");
    expect(rec.called).toContain("compose.beginReply");
  });

  it("fuzz: random, malformed and smuggled requests on every route", async () => {
    const seed = Number(process.env.DRAFTSAFE_FUZZ_SEED ?? 20260928);
    const rand = prng(seed);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const { fake, ids, rec, call } = await loadRealBridge(f =>
      Array.from({ length: 6 }, (_, i) =>
        f.addMessage({ folderId: pick(["account1://INBOX", "account1://Archive", "account1://Trash"]), subject: `S${i}`, text: `body ${i}` }).id
      )
    );
    const values = (): unknown =>
      pick<() => unknown>([
        () => pick(ids),
        () => ids.slice(0, 1 + Math.floor(rand() * ids.length)),
        () => Math.floor(rand() * 1e6) - 10,
        () => rand() < 0.5,
        () => null,
        () => "",
        () => pick(["inbox", "drafts", "sent", "trash", "outbox", "junk", "Work", "$label1", "draftsafe_followup", "account1", "account1://Trash"]),
        () => pick(["sendNow", "sendLater", "2030-01-01T00:00:00Z", "bob@example.test", "a@b\r\nBcc: x@y", "x".repeat(2000)]),
        () => [pick(["bob@example.test", "Work", "important"]), "carol@example.test"],
        () => ({ send: true }),
        () => [1, "two", null],
      ])();
    const statuses = new Map<number, number>();
    const N = 600;
    for (let i = 0; i < N; i++) {
      const route = rand() < 0.85 ? pick([...ROUTE_NAMES]) : pick(EXTRA_ROUTES);
      const params: Record<string, unknown> = {};
      for (const k of Object.hasOwn(PARAM_KEYS, route) ? PARAM_KEYS[route] : []) if (rand() < 0.5) params[k] = values();
      if (rand() < 0.25) params[pick(SMUGGLED)] = values();
      const body = rand() < 0.03 ? pick(["{not json", "[1]", '"s"', ""]) : JSON.stringify(params);
      const r = await call(route, body);
      statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
      expect([200, 400, 404, 500], `seed ${seed} #${i} ${route} ${body} -> ${r.body}`).toContain(r.status);
      for (const [name, spy] of Object.entries(forbiddenSpiesOf(fake))) {
        expect(spy, `seed ${seed} #${i} ${route} ${body}: ${name}`).not.toHaveBeenCalled();
      }
    }
    for (const path of rec.touched) expect(Object.keys(API_PERMISSIONS), `seed ${seed}: touched ${path}`).toContain(path);
    // The fuzzer must actually reach handlers, not only fail validation.
    expect(statuses.get(200) ?? 0, JSON.stringify([...statuses])).toBeGreaterThan(N / 10);
    expect(statuses.get(404) ?? 0).toBeGreaterThan(0);
  });
});
