import { describe, expect, it } from "vitest";
import { createSnooze } from "../addon/src/features/snooze.js";
import { createFollowups } from "../addon/src/features/followup.js";
import { createSendLater } from "../addon/src/features/sendlater.js";
import { createStore } from "../addon/src/lib/store.js";
import { FOLLOWUP_TAG_KEY } from "../addon/src/lib/constants.js";
import {
  laterToday,
  nextMondayMorning,
  parseWhen,
  snoozePresets,
  tomorrowMorning,
} from "../addon/src/lib/time.js";
import { normalizeSubject, parseMessageIds, prependToHtmlBody, stripHtml } from "../addon/src/lib/text.js";
import { createFakeMessenger } from "./helpers/fake-messenger.js";

const at = (s: string) => new Date(s);

describe("time presets (local time)", () => {
  it("later today rounds up to the next hour and disappears late in the day", () => {
    const d = laterToday(new Date(2026, 8, 28, 9, 20));
    expect([d!.getHours(), d!.getMinutes()]).toEqual([13, 0]);
    expect(laterToday(new Date(2026, 8, 28, 21, 30))).toBeNull();
    expect(snoozePresets(new Date(2026, 8, 28, 22, 0)).map(p => p.id)).toEqual(["tomorrow", "next-monday"]);
  });

  it("tomorrow is 08:00 the next day", () => {
    const d = tomorrowMorning(new Date(2026, 8, 30, 23, 59));
    expect([d.getMonth(), d.getDate(), d.getHours()]).toEqual([9, 1, 8]);
  });

  it("next Monday is always in the future, a week ahead on Mondays", () => {
    // 2026-09-28 is a Monday.
    expect(nextMondayMorning(new Date(2026, 8, 28, 7, 0)).getDate()).toBe(5);
    expect(nextMondayMorning(new Date(2026, 8, 27, 12, 0)).getDate()).toBe(28); // Sunday
    expect(nextMondayMorning(new Date(2026, 9, 2, 12, 0)).getDate()).toBe(5); // Friday
    expect(nextMondayMorning(new Date(2026, 9, 2, 12, 0)).getDay()).toBe(1);
  });

  it("parses ISO and datetime-local values, rejects junk", () => {
    expect(parseWhen("2026-10-01T08:30")!.getHours()).toBe(8);
    expect(parseWhen("2026-10-01T08:30:00Z")!.toISOString()).toBe("2026-10-01T08:30:00.000Z");
    expect(parseWhen("2026-10-01")).not.toBeNull();
    expect(parseWhen("tomorrow")).toBeNull();
    expect(parseWhen("2026-13-45T99:99")).toBeNull();
    expect(parseWhen(42 as unknown as string)).toBeNull();
  });
});

describe("text helpers", () => {
  it("strips HTML to readable text and drops scripts and styles", () => {
    const html = "<html><head><style>p{}</style></head><body><p>Hi &amp; welcome</p><script>alert(1)</script><ul><li>One</li></ul>&#x2713;</body></html>";
    expect(stripHtml(html)).toBe("Hi & welcome\n- One\n✓");
  });

  it("parses message ids and normalizes subjects", () => {
    expect(parseMessageIds(["<a@x> <b@y>", "<a@x>"])).toEqual(["a@x", "b@y"]);
    expect(normalizeSubject("Re: AW: Fwd: Plan")).toBe("Plan");
  });

  it("inserts reply text after <body>", () => {
    expect(prependToHtmlBody('<html><body class="x"><q>old</q></body></html>', "<p>new</p>")).toBe(
      '<html><body class="x"><p>new</p><q>old</q></body></html>'
    );
  });
});

describe("snooze", () => {
  it("moves to a per-account Snoozed folder and wakes to the Inbox, unread", async () => {
    const fake = createFakeMessenger();
    const store = createStore(fake.api.storage.local);
    let now = at("2026-09-28T09:00:00Z");
    const snooze = createSnooze({ api: fake.api, store, now: () => now });
    const m = fake.addMessage({ folderId: "account1://Archive", subject: "Later", read: true, headerMessageId: "later@x" });

    const [rec] = await snooze.snooze([m.id], at("2026-09-29T08:00:00Z"));
    expect(fake.api.folders.create).toHaveBeenCalledWith("account1://", "Snoozed");
    const parked = [...fake.messages.values()].find(x => x.headerMessageId === "later@x")!;
    expect(parked.folderId).toBe("account1://Snoozed");
    expect(rec.originalFolderId).toBe("account1://Archive");

    expect(await snooze.wakeDue()).toBe(0);
    now = at("2026-09-29T08:00:30Z");
    expect(await snooze.wakeDue()).toBe(1);
    const back = [...fake.messages.values()].find(x => x.headerMessageId === "later@x")!;
    expect(back.folderId).toBe("account1://INBOX");
    expect(back.read).toBe(false);
    expect(await snooze.list()).toEqual([]);
  });

  it("refuses past times and keeps no record when the move fails", async () => {
    const fake = createFakeMessenger();
    const store = createStore(fake.api.storage.local);
    const snooze = createSnooze({ api: fake.api, store, now: () => at("2026-09-28T09:00:00Z") });
    const m = fake.addMessage({ folderId: "account1://INBOX", subject: "x" });
    await expect(snooze.snooze([m.id], at("2026-09-28T08:00:00Z"))).rejects.toThrow(/future/);
    fake.api.messages.move.mockRejectedValueOnce(new Error("server says no"));
    await expect(snooze.snooze([m.id], at("2026-09-29T08:00:00Z"))).rejects.toThrow(/server says no/);
    expect(await snooze.list()).toEqual([]);
  });
});

describe("follow-ups", () => {
  it("creates the tag once, tags messages, lists with due dates, clears", async () => {
    const fake = createFakeMessenger();
    const store = createStore(fake.api.storage.local);
    const fu = createFollowups({ api: fake.api, store, now: () => at("2026-09-28T09:00:00Z") });
    const a = fake.addMessage({ folderId: "account1://INBOX", subject: "A" });
    const b = fake.addMessage({ folderId: "account1://INBOX", subject: "B" });

    await fu.set(a.id, { due: at("2026-09-27T09:00:00Z") });
    await fu.set(b.id);
    expect(fake.api.messages.tags.create).toHaveBeenCalledTimes(1);
    expect(fake.messages.get(a.id)!.tags).toContain(FOLLOWUP_TAG_KEY);

    const { followups } = await fu.list();
    expect(followups.map((f: { subject: string }) => f.subject)).toEqual(["A", "B"]);
    expect(followups[0].overdue).toBe(true);
    expect(await fu.overdueCount()).toBe(1);

    await fu.clear(a.id);
    expect(fake.messages.get(a.id)!.tags).not.toContain(FOLLOWUP_TAG_KEY);
    expect((await fu.list()).followups).toHaveLength(1);
  });
});

describe("send later (user feature)", () => {
  function setup(now: Date) {
    const fake = createFakeMessenger();
    const store = createStore(fake.api.storage.local);
    const notes: string[] = [];
    let clock = now;
    const sl = createSendLater({ api: fake.api, store, notify: (t: string) => notes.push(t), now: () => clock });
    return { fake, sl, notes, store, setNow: (d: Date) => (clock = d) };
  }

  it("saves the draft, closes compose, sends at the time, then trashes the draft", async () => {
    const { fake, sl, setNow } = setup(at("2026-09-28T09:00:00Z"));
    const tab = await fake.api.compose.beginNew(undefined, { to: ["bob@example.test"], subject: "Report", plainTextBody: "Hi" });
    await sl.schedule(tab.id, at("2026-09-28T10:00:00Z"));
    expect(fake.api.compose.saveMessage).toHaveBeenCalledWith(tab.id, { mode: "draft" });
    expect(fake.api.tabs.remove).toHaveBeenCalledWith(tab.id);

    await sl.processDue();
    expect(fake.forbidden.composeSendMessage).not.toHaveBeenCalled();

    setNow(at("2026-09-28T10:00:01Z"));
    await sl.processDue();
    expect(fake.forbidden.composeSendMessage).toHaveBeenCalledTimes(1);
    expect(fake.forbidden.composeSendMessage.mock.calls[0][1]).toEqual({ mode: "sendNow" });
    expect(await sl.list()).toEqual([]);
    const draft = [...fake.messages.values()].find(m => m.subject === "Report")!;
    expect(draft.folderId).toBe("account1://Trash");
  });

  it("refuses to schedule without recipients", async () => {
    const { fake, sl } = setup(at("2026-09-28T09:00:00Z"));
    const tab = await fake.api.compose.beginNew(undefined, { subject: "x" });
    await expect(sl.schedule(tab.id, at("2026-09-28T10:00:00Z"))).rejects.toThrow(/recipient/);
  });

  it("does not send when Thunderbird was closed past the grace period", async () => {
    const { fake, sl, setNow, notes } = setup(at("2026-09-28T09:00:00Z"));
    const tab = await fake.api.compose.beginNew(undefined, { to: ["bob@example.test"], subject: "Old" });
    await sl.schedule(tab.id, at("2026-09-28T10:00:00Z"));
    setNow(at("2026-09-29T10:00:00Z"));
    await sl.processDue();
    expect(fake.forbidden.composeSendMessage).not.toHaveBeenCalled();
    expect((await sl.list())[0].status).toBe("missed");
    expect(notes.join()).toMatch(/missed/);
  });

  it("never retries a send interrupted mid-flight", async () => {
    const { fake, sl, store } = setup(at("2026-09-28T09:00:00Z"));
    await store.put("sendLater", "k", {
      key: "k",
      status: "sending",
      sendAt: "2026-09-28T08:59:00Z",
      subject: "Maybe sent",
      accountId: "account1",
      headerMessageId: "x@y",
      draftFolderId: "account1://Drafts",
    });
    await sl.processDue();
    expect(fake.forbidden.composeSendMessage).not.toHaveBeenCalled();
    expect((await sl.list())[0].status).toBe("unknown");
  });
});
