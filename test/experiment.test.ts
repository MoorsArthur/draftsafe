// Runs the privileged Experiment (addons/bridge/api/implementation.js) in a
// node:vm sandbox with small fakes for the XPCOM pieces it uses, to test the
// socket lifecycle (write deadline, response cap, connection slots) and the
// connection-file publication rules without Thunderbird.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const IMPL = fileURLToPath(new URL("../addons/bridge/api/implementation.js", import.meta.url));
const FRAMING = fileURLToPath(new URL("../addons/bridge/api/framing.js", import.meta.url));

function harness() {
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let clock = 0;
  let nextTimer = 1;
  const files = new Map<string, string>();
  const perms = new Map<string, number>();
  const writes: { path: string; mode: string }[] = [];
  let acceptor: any = null;
  let copyCallback: (() => void) | null = null;
  const copies: string[] = [];

  const modules: Record<string, unknown> = {
    "resource://gre/modules/NetUtil.sys.mjs": {
      NetUtil: {
        asyncCopy: (src: any, _out: unknown, cb: () => void) => (copies.push(src.data), (copyCallback = cb)),
        readInputStreamToString: (stream: any) => files.get(stream.path)!,
      },
    },
    "resource://gre/modules/Timer.sys.mjs": {
      setTimeout: (fn: () => void, ms: number) => (timers.push({ at: clock + ms, fn, id: nextTimer }), nextTimer++),
      clearTimeout: (id: number) => timers.splice(0, timers.length, ...timers.filter(t => t.id !== id)),
    },
    "resource://gre/modules/ExtensionUtils.sys.mjs": { ExtensionUtils: { ExtensionError: Error } },
  };
  const ExtensionCommon = {
    ExtensionAPI: class {},
    EventManager: class {
      constructor(private o: { register: (fire: unknown) => unknown }) {}
      api() {
        return { addListener: (cb: (r: unknown) => unknown) => this.o.register({ async: cb }) };
      }
    },
  };
  const make: Record<string, () => any> = {
    "@mozilla.org/network/server-socket;1": () => ({ init() {}, asyncListen: (l: any) => (acceptor = l), port: 5555, close() {} }),
    "@mozilla.org/network/input-stream-pump;1": () => ({ init() {}, asyncRead: (l: any) => (pumpListener = l) }),
    "@mozilla.org/binaryinputstream;1": () => ({ setInputStream(s: any) { this.s = s; }, readBytes() { return this.s.chunk; } }),
    "@mozilla.org/io/string-input-stream;1": () => ({ setByteStringData(d: string) { this.data = d; } }),
    "@mozilla.org/file/local;1": () => ({
      path: "",
      initWithPath(p: string) { this.path = p; },
      exists() { return files.has(this.path); },
      isSymlink: () => false,
      remove() { files.delete(this.path); },
    }),
    "@mozilla.org/network/file-input-stream;1": () => ({ init(f: any) { this.path = f.path; }, available: () => 100, close() {} }),
  };
  let pumpListener: any = null;
  const substitutions: [string, unknown][] = [];
  const sandbox: Record<string, unknown> = {
    ExtensionCommon,
    ChromeUtils: { importESModule: (u: string) => modules[u], generateQI: () => () => {} },
    Components: {
      classes: new Proxy({}, { get: (_t, k: string) => ({ createInstance: () => make[k]() }) }),
      interfaces: new Proxy({}, { get: (_t, k) => k }),
      results: { NS_OK: 0, NS_ERROR_ABORT: 1 },
    },
    Services: {
      env: { get: (k: string) => (k === "SNAP_USER_COMMON" ? "/snapcommon" : "") },
      appinfo: { OS: "Linux" },
      dirsvc: { get: () => ({ path: "/home/u" }) },
      io: { getProtocolHandler: () => ({ QueryInterface: () => ({ setSubstitution: (h: string, u: unknown) => substitutions.push([h, u]) }) }) },
      scriptloader: { loadSubScript: (_u: string, target: object) => vm.runInNewContext(readFileSync(FRAMING, "utf8"), Object.assign(target, { unescape, encodeURIComponent })) },
      uuid: { generateUUID: () => ({ toString: () => `{${Math.random().toString(16).slice(2)}}` }) },
    },
    PathUtils: { join: (...p: string[]) => p.join("/") },
    IOUtils: {
      makeDirectory: async () => {},
      stat: async () => ({ type: "directory" }),
      setPermissions: async (p: string, m: number) => void perms.set(p, m),
      writeUTF8: async (p: string, c: string, o: { mode: string }) => {
        if (o.mode === "create" && files.has(p)) throw new Error("exists");
        writes.push({ path: p, mode: o.mode });
        files.set(p, c);
      },
      move: async (a: string, b: string) => void (files.set(b, files.get(a)!), files.delete(a)),
      readUTF8: async (p: string) => files.get(p)!,
      remove: async (p: string) => void files.delete(p),
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(IMPL, "utf8") + "\n;this.__api = draftsafeBridge;", sandbox);
  const Api = sandbox.__api as any;
  const instance = new Api();
  const api = instance.getAPI({ extension: { id: "draftsafe-bridge@draftsafe.dev", version: "t", rootURI: { resolve: (p: string) => p } } }).draftsafeBridge;

  return {
    api,
    instance,
    files,
    perms,
    writes,
    copies,
    substitutions,
    finishCopy: () => copyCallback && copyCallback(),
    advance(ms: number) {
      clock += ms;
      for (const t of timers.filter(t => t.at <= clock)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
    connect() {
      const transport = { closed: false, openInputStream: () => ({}), openOutputStream: () => ({}), close() { this.closed = true; } };
      acceptor.onSocketAccepted(null, transport);
      const listener = pumpListener;
      return {
        transport,
        send: (chunk: string) => listener.onDataAvailable(null, { chunk }, 0, chunk.length),
        hangup: () => listener.onStopRequest(),
      };
    },
  };
}

const flush = () => new Promise(r => setTimeout(r, 0));
const REQ = "POST /v1/health HTTP/1.1\r\nHost: 127.0.0.1:5555\r\nContent-Length: 2\r\n\r\n{}";

describe("experiment socket lifecycle (vm harness)", () => {
  it("closes a connection whose client never reads the response (write deadline)", async () => {
    const h = harness();
    await h.api.start();
    h.api.onRequest.addListener(async () => ({ status: 200, body: "{}" }));
    const c = h.connect();
    c.send(REQ);
    await flush();
    expect(h.copies).toHaveLength(1);
    expect(c.transport.closed).toBe(false); // copy still pending: client not reading
    h.advance(15_000);
    expect(c.transport.closed).toBe(true);
  });

  it("lingers after writing the response until the client hangs up (no RST)", async () => {
    const h = harness();
    await h.api.start();
    h.api.onRequest.addListener(async () => ({ status: 200, body: "{}" }));
    const c = h.connect();
    c.send(REQ);
    await flush();
    h.finishCopy();
    expect(c.transport.closed).toBe(false); // response written, waiting for the client's FIN
    c.hangup();
    expect(c.transport.closed).toBe(true);
  });

  it("closes a lingering connection after lingerMs if the client never hangs up", async () => {
    const h = harness();
    await h.api.start();
    h.api.onRequest.addListener(async () => ({ status: 200, body: "{}" }));
    const c = h.connect();
    c.send(REQ);
    await flush();
    h.finishCopy();
    h.advance(1_999);
    expect(c.transport.closed).toBe(false);
    h.advance(1);
    expect(c.transport.closed).toBe(true);
  });

  it("a client hanging up before the response abandons the request", async () => {
    const h = harness();
    await h.api.start();
    const c = h.connect();
    c.send(REQ.slice(0, 20));
    c.hangup();
    expect(c.transport.closed).toBe(true);
  });

  it("frees slots so a stalled reader cannot lock out new connections", async () => {
    const h = harness();
    await h.api.start();
    h.api.onRequest.addListener(async () => ({ status: 200, body: "{}" }));
    const stalled = Array.from({ length: 8 }, () => h.connect());
    stalled.forEach(c => c.send(REQ));
    await flush();
    const rejected = h.connect();
    expect(rejected.transport.closed).toBe(true); // all 8 slots busy
    h.advance(15_000);
    const fresh = h.connect();
    expect(fresh.transport.closed).toBe(false);
  });

  it("loads framing.js through a resource:// alias that is removed right after", async () => {
    const h = harness();
    await h.api.start();
    expect(h.substitutions.map(([host, uri]) => [host, uri === null])).toEqual([
      ["draftsafe-bridge", false],
      ["draftsafe-bridge", true],
    ]);
  });

  it("replaces an oversized response with a small error", async () => {
    const h = harness();
    await h.api.start();
    h.api.onRequest.addListener(async () => ({ status: 200, body: "x".repeat(5 * 1024 * 1024) }));
    h.connect().send(REQ);
    await flush();
    expect(h.copies[0].length).toBeLessThan(1000);
    expect(h.copies[0]).toMatch(/result_too_large/);
  });
});

describe("connection file publication (vm harness)", () => {
  const T1 = "A".repeat(43);
  const T2 = "B".repeat(43);
  const TARGET = "/snapcommon/draftsafe-mcp/connection.json";

  it("writes an exclusive, randomly named temp file, then renames it into place", async () => {
    const h = harness();
    await h.api.start();
    await h.api.publishConnection(T1);
    expect(JSON.parse(h.files.get(TARGET)!)).toMatchObject({ version: 1, port: 5555, token: T1 });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].mode).toBe("create");
    expect(h.writes[0].path).toMatch(/^\/snapcommon\/draftsafe-mcp\/\.connection\.json\.[0-9a-f]+\.tmp$/);
    expect(h.perms.get("/snapcommon/draftsafe-mcp")).toBe(0o700);
    expect(h.perms.get(h.writes[0].path)).toBe(0o600);
    expect([...h.files.keys()]).toEqual([TARGET]);
  });

  it("on shutdown removes only its own record, never another instance's", async () => {
    const h = harness();
    await h.api.start();
    await h.api.publishConnection(T1);
    await h.api.stop();
    expect(h.files.has(TARGET)).toBe(false);

    await h.api.start();
    await h.api.publishConnection(T1);
    h.files.set(TARGET, JSON.stringify({ version: 1, port: 6666, token: T2 })); // another profile started later
    h.instance.onShutdown(true);
    expect(JSON.parse(h.files.get(TARGET)!).token).toBe(T2);
  });

  it("on app shutdown removes its own record synchronously", async () => {
    const h = harness();
    await h.api.start();
    await h.api.publishConnection(T1);
    h.instance.onShutdown(true);
    expect(h.files.has(TARGET)).toBe(false); // no await: must already be gone
  });

  it("rejects malformed tokens", async () => {
    const h = harness();
    await h.api.start();
    await expect(h.api.publishConnection("short")).rejects.toThrow(/token/);
  });
});
