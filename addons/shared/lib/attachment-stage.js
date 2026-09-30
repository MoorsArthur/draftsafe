// SPDX-License-Identifier: MIT
// Authenticated bridge routes keep attachment bytes only in memory until one
// compose operation consumes them. No byte content is returned to MCP tools.

import { BridgeError } from "./validate.js";

export const MAX_ATTACHMENT_FILES = 100;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL = 25 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 128 * 1024;
const TTL_MS = 5 * 60 * 1000;

export function createAttachmentStage({ now = () => Date.now() } = {}) {
  const sessions = new Map();

  function sweep() {
    for (const [token, record] of sessions) if (now() - record.createdAt > TTL_MS) sessions.delete(token);
  }

  function lookup(token) {
    sweep();
    if (typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token) || !sessions.has(token))
      throw new BridgeError("attachment_expired", "Attachment staging expired; start again.", 409);
    return sessions.get(token);
  }

  function begin({ name, size, type = "application/octet-stream" }) {
    sweep();
    if (typeof name !== "string" || !name || name.length > 200 || /[\\/\x00-\x1f\x7f]/.test(name) ||
        !Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES ||
        typeof type !== "string" || type.length > 100 || /[\x00-\x1f\x7f]/.test(type))
      throw new BridgeError("invalid_params", "Invalid attachment metadata.", 400);
    const reserved = [...sessions.values()].reduce((total, entry) => total + entry.size, 0);
    if (sessions.size >= MAX_ATTACHMENT_FILES || reserved + size > MAX_ATTACHMENT_TOTAL)
      throw new BridgeError("attachment_limit", "Too many staged attachment bytes; finish or wait for expiry.", 429);
    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    const token = Array.from(random, b => b.toString(16).padStart(2, "0")).join("");
    sessions.set(token, { name, size, type, chunks: [], received: 0, createdAt: now() });
    return { token, chunkBytes: MAX_CHUNK_BYTES };
  }

  function chunk({ token, offset, data }) {
    const record = lookup(token);
    if (!Number.isSafeInteger(offset) || offset !== record.received || typeof data !== "string" ||
        data.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
      throw new BridgeError("invalid_params", "Invalid attachment chunk or offset.", 400);
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    if (!bytes.length || bytes.length > MAX_CHUNK_BYTES || record.received + bytes.length > record.size)
      throw new BridgeError("invalid_params", "Attachment chunk exceeds its declared size.", 400);
    record.chunks.push(bytes);
    record.received += bytes.length;
    return { received: record.received, complete: record.received === record.size };
  }

  function consume(token) {
    const record = lookup(token);
    if (record.received !== record.size) throw new BridgeError("invalid_params", "Attachment upload is incomplete.", 400);
    sessions.delete(token);
    return new File(record.chunks, record.name, { type: record.type });
  }

  function discard({ token }) {
    if (typeof token === "string") sessions.delete(token);
    return { discarded: true };
  }

  return { begin, chunk, consume, discard };
}
