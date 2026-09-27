import { describe, expect, it } from "vitest";
import { loadFraming } from "./helpers/framing.js";

const f = loadFraming();

const req = (head: string, body = "") => `${head}\r\n\r\n${body}`;

describe("experiment framing (addon/api/bridge/framing.js)", () => {
  it("frames a complete POST request", () => {
    const body = '{"a":1}';
    const r = f.frameRequest(
      req(`POST /v1/health HTTP/1.1\r\nHost: 127.0.0.1:5000\r\nContent-Length: ${body.length}\r\nContent-Type: application/json`, body)
    );
    expect(r.state).toBe("complete");
    expect(r.method).toBe("POST");
    expect(r.target).toBe("/v1/health");
    expect(r.headers.host).toBe("127.0.0.1:5000");
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.body).toBe(body);
  });

  it("waits for more bytes until head and body are complete", () => {
    expect(f.frameRequest("POST /v1/health HTTP/1.1\r\nHost: x").state).toBe("incomplete");
    expect(f.frameRequest(req("POST / HTTP/1.1\r\nContent-Length: 10", "12345")).state).toBe("incomplete");
  });

  it("rejects an oversized header block with 431, even before it ends", () => {
    const big = "POST / HTTP/1.1\r\nX-Pad: " + "a".repeat(f.LIMITS.maxHeaderBytes);
    expect(f.frameRequest(big)).toMatchObject({ state: "error", status: 431 });
    expect(f.frameRequest(req(big))).toMatchObject({ state: "error", status: 431 });
  });

  it("rejects a declared body over the cap with 413 without waiting for it", () => {
    const r = f.frameRequest(req(`POST / HTTP/1.1\r\nContent-Length: ${f.LIMITS.maxBodyBytes + 1}`));
    expect(r).toMatchObject({ state: "error", status: 413 });
  });

  it("accepts a body exactly at the cap", () => {
    const body = "x".repeat(f.LIMITS.maxBodyBytes);
    expect(f.frameRequest(req(`POST / HTTP/1.1\r\nContent-Length: ${body.length}`, body)).state).toBe("complete");
  });

  it("rejects chunked transfer encoding", () => {
    expect(f.frameRequest(req("POST / HTTP/1.1\r\nTransfer-Encoding: chunked"))).toMatchObject({ status: 501 });
  });

  it.each([
    ["non-numeric content-length", "POST / HTTP/1.1\r\nContent-Length: 1e3"],
    ["negative content-length", "POST / HTTP/1.1\r\nContent-Length: -1"],
    ["duplicate Host", "POST / HTTP/1.1\r\nHost: a\r\nHost: b"],
    ["duplicate Authorization", "POST / HTTP/1.1\r\nAuthorization: a\r\nAuthorization: b"],
    ["duplicate Content-Length", "POST / HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 0"],
    ["obsolete folding", "POST / HTTP/1.1\r\nX-A: 1\r\n  continued"],
    ["bad request line", "POST /\r\nHost: a"],
    ["HTTP/2 request line", "POST / HTTP/2.0"],
    ["lowercase method", "post / HTTP/1.1"],
    ["header without colon", "POST / HTTP/1.1\r\nNoColon"],
    ["control char in value", "POST / HTTP/1.1\r\nX-A: a\x01b"],
    ["space in header name", "POST / HTTP/1.1\r\nBad Name: x"],
  ])("rejects %s with 400", (_, head) => {
    expect(f.frameRequest(req(head))).toMatchObject({ state: "error", status: 400 });
  });

  it("rejects bytes after the declared body (no pipelining)", () => {
    expect(f.frameRequest(req("POST / HTTP/1.1\r\nContent-Length: 2", "{}GET / HTTP/1.1"))).toMatchObject({ status: 400 });
  });

  it("limits header count and target length", () => {
    const many = "POST / HTTP/1.1" + "\r\nX-A: 1".repeat(f.LIMITS.maxHeaderCount + 1);
    expect(f.frameRequest(req(many))).toMatchObject({ status: 431 });
    expect(f.frameRequest(req(`POST /${"a".repeat(300)} HTTP/1.1`))).toMatchObject({ status: 414 });
  });

  it("builds responses with a correct UTF-8 Content-Length and no CORS headers", () => {
    const res = f.buildResponse(200, '{"s":"héllo ✓"}');
    const [head, body] = res.split("\r\n\r\n");
    const len = Number(/Content-Length: (\d+)/.exec(head)![1]);
    expect(len).toBe(Buffer.byteLength('{"s":"héllo ✓"}', "utf8"));
    expect(body.length).toBe(len);
    expect(Buffer.from(body, "latin1").toString("utf8")).toBe('{"s":"héllo ✓"}');
    expect(head).toMatch(/^HTTP\/1\.1 200 OK/);
    expect(head).toContain("Connection: close");
    expect(head.toLowerCase()).not.toContain("access-control");
  });

  it("maps unknown statuses to 500", () => {
    expect(f.buildResponse(299, "{}")).toMatch(/^HTTP\/1\.1 500 /);
  });
});
