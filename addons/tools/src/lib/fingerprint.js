// SPDX-License-Identifier: MIT
// Content fingerprint of a stored message, used to bind a scheduled send to
// exactly the draft the user approved.
//
// SHA-256 over the raw RFC 822 message with line endings normalised to LF and
// Thunderbird's own bookkeeping headers (X-Mozilla-*) removed: local folders
// rewrite X-Mozilla-Status in place when flags change, which must not count
// as a content change. Everything else, including recipients, subject, body
// and attachments, is covered.

function toBinaryString(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return out;
}

async function rawOf(api, messageId) {
  const raw = await api.messages.getRaw(messageId);
  if (typeof raw === "string") {
    return raw;
  }
  if (raw && typeof raw.arrayBuffer === "function") {
    return toBinaryString(new Uint8Array(await raw.arrayBuffer()));
  }
  throw new Error("could not read the draft");
}

/** Normalised message text (binary string) that the fingerprint covers. */
export function normalizeRaw(raw) {
  const text = String(raw).replace(/\r\n?/g, "\n");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? "" : text.slice(split);
  const kept = [];
  let skipping = false;
  for (const line of head.split("\n")) {
    const continuation = line.startsWith(" ") || line.startsWith("\t");
    if (!continuation) {
      skipping = /^x-mozilla-[^:]*:/i.test(line);
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  return kept.join("\n") + body;
}

export async function sha256Hex(binary, subtle = globalThis.crypto.subtle) {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i) & 0xff;
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintMessage(api, messageId) {
  return sha256Hex(normalizeRaw(await rawOf(api, messageId)));
}
