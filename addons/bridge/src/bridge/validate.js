// SPDX-License-Identifier: MIT
// Minimal parameter validation for bridge routes. Unknown keys are rejected so
// a typo (or an attempt to smuggle e.g. a "send" flag) fails loudly.

import { parseWhen } from "../../../shared/lib/time.js";

export class BridgeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const bad = message => new BridgeError("invalid_params", message);

export function onlyKeys(params, allowed) {
  for (const k of Object.keys(params)) {
    if (!allowed.includes(k)) {
      throw bad(`unknown parameter "${k}"`);
    }
  }
}

export function optString(params, key, max = 1000) {
  const v = params[key];
  if (v === undefined || v === null || v === "") {
    return undefined;
  }
  if (typeof v !== "string" || v.length > max) {
    throw bad(`${key} must be a string of at most ${max} characters`);
  }
  return v;
}

export function reqString(params, key, max = 1000) {
  const v = optString(params, key, max);
  if (v === undefined) {
    throw bad(`${key} is required`);
  }
  return v;
}

export function optBool(params, key) {
  const v = params[key];
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== "boolean") {
    throw bad(`${key} must be a boolean`);
  }
  return v;
}

export function optInt(params, key, min, max, dflt) {
  const v = params[key];
  if (v === undefined || v === null) {
    return dflt;
  }
  if (!Number.isInteger(v) || v < min || v > max) {
    throw bad(`${key} must be an integer between ${min} and ${max}`);
  }
  return v;
}

export function messageId(v, key = "messageId") {
  if (!Number.isInteger(v) || v < 1) {
    throw bad(`${key} must be a positive integer message id`);
  }
  return v;
}

/** Accepts messageId (single) or messageIds (array, max 100). */
export function messageIds(params) {
  if (params.messageIds !== undefined) {
    if (!Array.isArray(params.messageIds) || params.messageIds.length === 0 || params.messageIds.length > 100) {
      throw bad("messageIds must be an array of 1 to 100 ids");
    }
    return params.messageIds.map(v => messageId(v, "messageIds[]"));
  }
  return [messageId(params.messageId)];
}

export function optDate(params, key) {
  const v = optString(params, key, 64);
  if (v === undefined) {
    return undefined;
  }
  const d = parseWhen(v);
  if (!d) {
    throw bad(`${key} must be an ISO 8601 date or date-time`);
  }
  return d;
}

export function optStringList(params, key, maxItems, maxLen) {
  const v = params[key];
  if (v === undefined || v === null) {
    return undefined;
  }
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list) || list.length > maxItems) {
    throw bad(`${key} must be a string or an array of at most ${maxItems} strings`);
  }
  for (const s of list) {
    // CR/LF would allow header injection into the draft.
    if (typeof s !== "string" || !s.trim() || s.length > maxLen || /[\r\n\0]/.test(s)) {
      throw bad(`${key} contains an invalid entry`);
    }
  }
  return list;
}

/**
 * Per-request budget. Long operations call check() between steps (per message,
 * per thread candidate) so a request that already timed out on the socket side
 * stops doing work, and in particular stops mutating, instead of running on.
 */
export function createDeadline(budgetMs, now = () => Date.now()) {
  const until = now() + budgetMs;
  return {
    check() {
      if (now() > until) {
        throw new BridgeError("timeout", "the operation ran out of time and was stopped", 504);
      }
    },
  };
}

/** A deadline that never expires (tests, direct calls). */
export const NO_DEADLINE = Object.freeze({ check() {} });
