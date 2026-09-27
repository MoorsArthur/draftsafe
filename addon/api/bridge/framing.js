/* SPDX-License-Identifier: MIT */
/*
 * HTTP/1.1 request framing for the loopback bridge.
 *
 * Plain script, no imports: the privileged experiment loads it with
 * Services.scriptloader.loadSubScript(), and the Node tests load it with
 * node:vm. It works on "binary strings" (one char per byte, 0-255), which is
 * what nsIBinaryInputStream.readBytes() produces.
 *
 * It only decides "need more bytes", "reject with status N" or "complete
 * request". Authentication, Host/Origin checks and routing happen in the
 * unprivileged background page (addon/src/bridge/server.js).
 */

"use strict";

/* exported LIMITS, frameRequest, parseHead, buildResponse, utf8Encode */

var LIMITS = Object.freeze({
  maxHeaderBytes: 8 * 1024,
  maxBodyBytes: 256 * 1024,
  maxHeaderCount: 48,
  maxTargetLength: 256,
  maxConnections: 8,
  // A client has this long to deliver the complete request.
  readTimeoutMs: 10 * 1000,
  // The background page has this long to produce a response.
  handlerTimeoutMs: 90 * 1000,
});

// Headers that must never appear twice: a duplicate is a smuggling or
// confusion attempt, never a legitimate client.
var SINGLETON_HEADERS = [
  "host",
  "authorization",
  "content-length",
  "content-type",
  "origin",
  "transfer-encoding",
];

var TOKEN_CHARS = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function parseHead(head, limits) {
  limits = limits || LIMITS;
  var lines = head.split("\r\n");
  var requestLine = lines[0];
  var m = /^([A-Z]{1,16}) (\S+) HTTP\/1\.[01]$/.exec(requestLine);
  if (!m) {
    return { error: 400, reason: "malformed request line" };
  }
  if (m[2].length > limits.maxTargetLength) {
    return { error: 414, reason: "request target too long" };
  }
  if (lines.length - 1 > limits.maxHeaderCount) {
    return { error: 431, reason: "too many headers" };
  }
  var headers = Object.create(null);
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i];
    if (line === "") {
      return { error: 400, reason: "empty header line" };
    }
    if (line[0] === " " || line[0] === "\t") {
      return { error: 400, reason: "obsolete header folding" };
    }
    var colon = line.indexOf(":");
    if (colon <= 0) {
      return { error: 400, reason: "malformed header" };
    }
    var name = line.slice(0, colon);
    if (!TOKEN_CHARS.test(name)) {
      return { error: 400, reason: "invalid header name" };
    }
    var value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "");
    // Control characters (other than tab) are never valid in a field value.
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
      return { error: 400, reason: "invalid header value" };
    }
    var key = name.toLowerCase();
    if (key in headers) {
      if (SINGLETON_HEADERS.indexOf(key) !== -1) {
        return { error: 400, reason: "duplicate " + key + " header" };
      }
      headers[key] += ", " + value;
    } else {
      headers[key] = value;
    }
  }
  return { method: m[1], target: m[2], headers: headers };
}

/**
 * @param {string} buf binary string received so far
 * @returns {{state: "incomplete"} |
 *           {state: "error", status: number, reason: string} |
 *           {state: "complete", method, target, headers, body}}
 */
function frameRequest(buf, limits) {
  limits = limits || LIMITS;
  var end = buf.indexOf("\r\n\r\n");
  if (end === -1) {
    if (buf.length > limits.maxHeaderBytes) {
      return { state: "error", status: 431, reason: "header block too large" };
    }
    return { state: "incomplete" };
  }
  if (end + 4 > limits.maxHeaderBytes) {
    return { state: "error", status: 431, reason: "header block too large" };
  }
  var head = parseHead(buf.slice(0, end), limits);
  if (head.error) {
    return { state: "error", status: head.error, reason: head.reason };
  }
  if ("transfer-encoding" in head.headers) {
    return { state: "error", status: 501, reason: "transfer-encoding not supported" };
  }
  var length = 0;
  var cl = head.headers["content-length"];
  if (cl !== undefined) {
    if (!/^[0-9]{1,10}$/.test(cl)) {
      return { state: "error", status: 400, reason: "invalid content-length" };
    }
    length = Number(cl);
  }
  if (length > limits.maxBodyBytes) {
    return { state: "error", status: 413, reason: "body too large" };
  }
  var bodyStart = end + 4;
  if (buf.length < bodyStart + length) {
    return { state: "incomplete" };
  }
  if (buf.length > bodyStart + length) {
    // One request per connection; pipelined or trailing bytes are rejected.
    return { state: "error", status: 400, reason: "unexpected bytes after body" };
  }
  return {
    state: "complete",
    method: head.method,
    target: head.target,
    headers: head.headers,
    body: buf.slice(bodyStart),
  };
}

/** UTF-16 JS string to UTF-8 binary string. */
function utf8Encode(str) {
  return unescape(encodeURIComponent(str));
}

var REASONS = {
  200: "OK",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  421: "Misdirected Request",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
  501: "Not Implemented",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/**
 * Builds a complete HTTP response as a binary string. No CORS headers are
 * ever emitted, so browsers cannot read responses cross-origin.
 */
function buildResponse(status, bodyText) {
  if (!(status in REASONS)) {
    status = 500;
    bodyText = JSON.stringify({ ok: false, error: { code: "internal", message: "invalid status" } });
  }
  var body = utf8Encode(String(bodyText));
  return (
    "HTTP/1.1 " + status + " " + REASONS[status] + "\r\n" +
    "Content-Type: application/json; charset=utf-8\r\n" +
    "Content-Length: " + body.length + "\r\n" +
    "Cache-Control: no-store\r\n" +
    "X-Content-Type-Options: nosniff\r\n" +
    "Connection: close\r\n" +
    "\r\n" +
    body
  );
}
