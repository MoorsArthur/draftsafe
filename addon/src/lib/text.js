// SPDX-License-Identifier: MIT
// Text helpers used by the bridge. Pure functions.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Fallback HTML-to-text conversion, used when messengerUtilities
 * .convertToPlainText() is unavailable or fails. Drops scripts, styles,
 * comments and all tags; keeps line structure roughly intact.
 */
export function stripHtml(html) {
  if (typeof html !== "string") {
    return "";
  }
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code) => {
      if (code[0] === "#") {
        const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text to a minimal HTML fragment (paragraphs and line breaks). */
export function textToHtml(text) {
  return String(text)
    .split(/\n{2,}/)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** Inserts an HTML fragment right after the opening <body> tag (or prepends). */
export function prependToHtmlBody(html, fragment) {
  const m = /<body\b[^>]*>/i.exec(html || "");
  if (!m) {
    return fragment + (html || "");
  }
  const at = m.index + m[0].length;
  return html.slice(0, at) + fragment + html.slice(at);
}

export function truncate(text, max) {
  if (text.length <= max) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, max), truncated: true };
}

/** Extracts <message-ids> from References / In-Reply-To header values. */
export function parseMessageIds(values) {
  const out = [];
  for (const v of values || []) {
    for (const m of String(v).matchAll(/<([^<>\s]{1,250})>/g)) {
      if (!out.includes(m[1])) {
        out.push(m[1]);
      }
    }
  }
  return out;
}

/** Strips Re:/Fwd:/Aw:/Antw: style prefixes (repeated) for thread matching. */
export function normalizeSubject(subject) {
  let s = String(subject || "").trim();
  const prefix = /^(re|fw|fwd|aw|wg|antw|sv|vs|tr|rif|ref)(\[\d+\])?\s*:\s*/i;
  while (prefix.test(s)) {
    s = s.replace(prefix, "");
  }
  return s.trim();
}
