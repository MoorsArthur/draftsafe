// SPDX-License-Identifier: MIT

/** 32 random bytes, base64url without padding (43 chars). */
export function generateToken(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Constant-time string comparison. The running time depends only on the
 * length of `expected` (the secret's length is not itself secret here: the
 * token format is public).
 */
export function timingSafeEqual(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || expected.length === 0) {
    return false;
  }
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    // Out-of-range reads yield NaN -> 0 via `| 0`, keeping the loop uniform.
    diff |= (given.charCodeAt(i) | 0) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function allowedHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}
