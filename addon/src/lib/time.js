// SPDX-License-Identifier: MIT
// Snooze / send-later presets, computed in local time. Pure functions.

const HOUR = 60 * 60 * 1000;

function atLocal(base, dayOffset, hour, minute = 0) {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** Now + 3 hours, rounded up to the next full hour. Null once that crosses midnight. */
export function laterToday(now = new Date()) {
  const d = new Date(now.getTime() + 3 * HOUR);
  if (d.getMinutes() || d.getSeconds() || d.getMilliseconds()) {
    d.setHours(d.getHours() + 1, 0, 0, 0);
  }
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? d : null;
}

export function tomorrowMorning(now = new Date(), hour = 8) {
  return atLocal(now, 1, hour);
}

/** Monday 08:00 of next week. On a Monday this is 7 days later. */
export function nextMondayMorning(now = new Date(), hour = 8) {
  const day = now.getDay(); // 0 = Sunday
  const offset = ((8 - day) % 7) || 7;
  return atLocal(now, offset, hour);
}

export function inOneHour(now = new Date()) {
  return new Date(now.getTime() + HOUR);
}

/**
 * Presets shown in the snooze UI. "later today" is omitted late in the day.
 * @returns {{id: string, label: string, when: Date}[]}
 */
export function snoozePresets(now = new Date()) {
  const presets = [];
  const later = laterToday(now);
  if (later) {
    presets.push({ id: "later-today", label: "Later today", when: later });
  }
  presets.push({ id: "tomorrow", label: "Tomorrow 08:00", when: tomorrowMorning(now) });
  presets.push({ id: "next-monday", label: "Next Monday 08:00", when: nextMondayMorning(now) });
  return presets;
}

export function sendLaterPresets(now = new Date()) {
  return [
    { id: "one-hour", label: "In 1 hour", when: inOneHour(now) },
    { id: "tomorrow", label: "Tomorrow 08:00", when: tomorrowMorning(now) },
    { id: "next-monday", label: "Next Monday 08:00", when: nextMondayMorning(now) },
  ];
}

export function presetById(presets, id) {
  return presets.find(p => p.id === id) || null;
}

/**
 * Parses an ISO 8601 timestamp or a `<input type="datetime-local">` value
 * (interpreted as local time). Returns null when invalid.
 */
export function parseWhen(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (local) {
    const [, y, mo, d, h, mi, s] = local.map(Number);
    const date = new Date(y, mo - 1, d, h, mi, s || 0, 0);
    // Reject overflow like month 13 or 25:00 instead of silently rolling over.
    const exact =
      date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && date.getHours() === h && date.getMinutes() === mi;
    return exact ? date : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInputValue(date) {
  const pad = n => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function formatWhen(date, now = new Date()) {
  const opts = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  if (date.getFullYear() !== now.getFullYear()) {
    opts.year = "numeric";
  }
  return date.toLocaleString(undefined, opts);
}
