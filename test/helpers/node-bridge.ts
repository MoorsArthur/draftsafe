// A Node stand-in for the privileged experiment: same framing.js, same
// background request handler, real TCP on 127.0.0.1. Lets tests exercise the
// full HTTP path (framing -> auth -> routing -> mail ops) without Thunderbird.
import net from "node:net";
import { loadFraming } from "./framing.js";

type Handler = (req: {
  method: string;
  target: string;
  headers: Record<string, string>;
  body: string;
  port: number;
}) => Promise<{ status: number; body: string }>;

export async function startNodeBridge(makeHandler: (port: number) => Handler) {
  const framing = loadFraming();
  let handler: Handler | null = null;
  const server = net.createServer(socket => {
    let buf = "";
    let done = false;
    const reply = (status: number, body: string) => {
      done = true;
      socket.end(Buffer.from(framing.buildResponse(status, body), "latin1"));
    };
    socket.on("data", chunk => {
      if (done) return;
      buf += chunk.toString("latin1");
      if (buf.length > framing.LIMITS.maxHeaderBytes + framing.LIMITS.maxBodyBytes + 4) {
        reply(413, JSON.stringify({ ok: false, error: { code: "too_large" } }));
        return;
      }
      const f = framing.frameRequest(buf);
      if (f.state === "incomplete") return;
      if (f.state === "error") {
        reply(f.status, JSON.stringify({ ok: false, error: { code: "bad_request", message: f.reason } }));
        return;
      }
      done = true;
      handler!({ method: f.method, target: f.target, headers: f.headers, body: f.body, port })
        .then(r => reply(r.status, r.body))
        .catch(() => reply(500, "{}"));
    });
    socket.on("error", () => {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  handler = makeHandler(port);
  return {
    port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** Sends raw bytes and returns the raw response (for malformed-request tests). */
export function rawRequest(port: number, data: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    let out = "";
    s.on("data", c => (out += c.toString("latin1")));
    s.on("end", () => resolve(out));
    s.on("error", reject);
    s.end(data);
  });
}
