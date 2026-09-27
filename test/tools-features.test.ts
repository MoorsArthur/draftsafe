import { describe, expect, it, vi } from "vitest";
import { createSnooze } from "../addons/tools/src/features/snooze.js";
import { createFollowups } from "../addons/tools/src/features/followup.js";
import { createSendLater, isValidRecord } from "../addons/tools/src/features/sendlater.js";
import { createStore } from "../addons/tools/src/lib/store.js";
import { fingerprintMessage, normalizeRaw, sha256Hex } from "../addons/tools/src/lib/fingerprint.js";
import { FOLLOWUP_TAG_KEY } from "../addons/shared/lib/constants.js";
import { laterToday, nextMondayMorning, parseWhen, snoozePresets, tomorrowMorning } from "../addons/shared/lib/time.js";
import { normalizeSubject, parseMessageIds, quoteForReply, stripHtml } from "../addons/shared/lib/text.js";
import { createFakeMessenger, type FakeFolder } from "./helpers/fake-messenger.js";

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

  it("quotes the original below the reply in plain text", () => {
    expect(quoteForReply("Yes.", "Can you?\r\n> earlier", "Bob wrote:")).toBe("Yes.\n\nBob wrote:\n> Can you?\n>> earlier\n");
  });
});

// ------------------------------------------------------------------ snooze --

function snoozeSetup(extraFolders: FakeFolder[] = []) {
  const fake = createFakeMessenger({ extraFolders });
  const store = createStore(fake.api.storage.local);
  let now = at("2026-09-28T09:00:00Z");
  const notes: string[] = [];
  const snooze = createSnooze({ api: fake.api, store, notify: (t: string, m: string) => notes.push(`${t}: ${m}`), now: () => now });
  return { fake, store, snooze, notes, setNow: (d: Date) => (now = d) };
}

describe("snooze (tools add-on)", () => {
  it("moves to a validated per-account Snoozed folder and wakes to the Inbox, unread", async () => {
    const { fake, snooze, setNow } = snoozeSetup();
    const m = fake.addMessage({ folderId: "account1://Archive", subject: "Later", read: true, headerMessageId: "later@x" });

    const [rec] = await snooze.snooze([m.id], at("2026-09-29T08:00:00Z"));
    expect(fake.api.folders.create).toHaveBeenCalledWith("account1://", "Snoozed");
    expect(rec.snoozeFolderId).toBe("account1://Snoozed");
    const parked = [...fake.messages.values()].find(x => x.headerMessageId === "later@x")!;
    expect(parked.folderId).toBe("account1://Snoozed");

    expect(await snooze.wakeDue()).toBe(0);
    setNow(at("2026-09-29T08:00:30Z"));
    expect(await snooze.wakeDue()).toBe(1);
    const back = [...fake.messages.values()].find(x => x.headerMessageId === "later@x")!;
    expect(back.folderId).toBe("account1://INBOX");
    expect(back.read).toBe(false);
    expect(await snooze.list()).toEqual([]);
  });

  it("Codex High #1: never snoozes into a Trash folder that is named 'Snoozed'", async () => {
    const trashNamedSnoozed = { id: "account1://Snoozed", accountId: "account1", name: "Snoozed", path: "/Snoozed", specialUse: ["trash"] };
    const { fake, snooze } = snoozeSetup([trashNamedSnoozed]);
    const m = fake.addMessage({ folderId: "account1://INBOX", subject: "keep me" });
    await expect(snooze.snooze([m.id], at("2026-09-29T08:00:00Z"))).rejects.toThrow(/not a plain Snoozed folder/);
    expect(fake.api.messages.move).not.toHaveBeenCalled();
    expect(fake.messages.get(m.id)!.folderId).toBe("account1://INBOX");
    expect(await snooze.list()).toEqual([]);
  });

  it("re-validates on wake: a snoozed record whose folder became special-use is not moved", async () => {
    const { fake, snooze, setNow } = snoozeSetup();
    const m = fake.addMessage({ folderId: "account1://INBOX", subject: "x", headerMessageId: "x@x" });
    await snooze.snooze([m.id], at("2026-09-29T08:00:00Z"));
    fake.api.messages.move.mockClear();
    // Someone turns the Snoozed folder into the Junk folder.
    fake.folders.find(f => f.id === "account1://Snoozed")!.specialUse = ["junk"];
    setNow(at("2026-09-29T09:00:00Z"));
    expect(await snooze.wakeDue()).toBe(0);
    expect(fake.api.messages.move).not.toHaveBeenCalled();
  });

  it("wakes only into the Inbox found by special use; without an Inbox the message stays", async () => {
    const { fake, snooze, setNow, notes } = snoozeSetup();
    const m = fake.addMessage({ folderId: "account1://INBOX", subject: "x", headerMessageId: "y@x" });
    await snooze.snooze([m.id], at("2026-09-29T08:00:00Z"));
    fake.folders.find(f => f.id === "account1://INBOX")!.specialUse = [];
    fake.api.messages.move.mockClear();
    setNow(at("2026-09-29T09:00:00Z"));
    expect(await snooze.wakeDue()).toBe(0);
    expect(fake.api.messages.move).not.toHaveBeenCalled();
    expect(notes.join()).toMatch(/no Inbox/);
  });

  it("wake destination is never Trash, Junk or another folder, even with tampered records", async () => {
    const { fake, snooze, store, setNow } = snoozeSetup();
    const m = fake.addMessage({ folderId: "account1://INBOX", subject: "x", headerMessageId: "z@x" });
    await snooze.snooze([m.id], at("2026-09-29T08:00:00Z"));
    // Tamper: point the record's source at Trash and add a destination hint.
    await store.update("snoozes", (map: any) => {
      map["account1|z@x"].originalFolderId = "account1://Trash";
      map["garbage"] = { until: "not a date" };
    });
    setNow(at("2026-09-29T09:00:00Z"));
    await snooze.wakeDue();
    for (const [, dest] of fake.api.messages.move.mock.calls) {
      expect(["account1://INBOX", "account1://Snoozed"]).toContain(dest);
    }
    expect(Object.keys(fake.storage.snoozes as object)).not.toContain("garbage");
  });

  it("refuses to snooze from Trash, Junk, Drafts, Templates, Sent or Outbox", async () => {
    const { fake, snooze } = snoozeSetup([
      { id: "account1://Junk", accountId: "account1", name: "Junk", path: "/Junk", specialUse: ["junk"] },
    ]);
    for (const folderId of ["account1://Trash", "account1://Drafts", "account1://Junk"]) {
      const m = fake.addMessage({ folderId, subject: "x" });
      await expect(snooze.snooze([m.id], at("2026-09-29T08:00:00Z"))).rejects.toThrow(/cannot be snoozed/);
    }
    expect(fake.api.messages.move).not.toHaveBeenCalled();
  });

  it("refuses past times and keeps no record when the move fails", async () => {
    const { fake, snooze } = snoozeSetup();
    const m = fake.addMessage({ folderId: "account1://INBOX", subject: "x" });
    await expect(snooze.snooze([m.id], at("2026-09-28T08:00:00Z"))).rejects.toThrow(/future/);
    fake.api.messages.move.mockRejectedValueOnce(new Error("server says no"));
    await expect(snooze.snooze([m.id], at("2026-09-29T08:00:00Z"))).rejects.toThrow(/server says no/);
    expect(await snooze.list()).toEqual([]);
  });
});

// --------------------------------------------------------------- follow-ups --

describe("follow-ups (tools add-on)", () => {
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
    expect(await fu.overdueCount()).toBe(0);
  });
});

// --------------------------------------------------------------- send later --

function sendLaterSetup(now: Date) {
  const fake = createFakeMessenger();
  const store = createStore(fake.api.storage.local);
  const notes: string[] = [];
  let clock = now;
  const sl = createSendLater({ api: fake.api, store, notify: (t: string, m: string) => notes.push(`${t}: ${m}`), now: () => clock });
  return { fake, sl, notes, store, setNow: (d: Date) => (clock = d) };
}

async function scheduleOne(ctx: ReturnType<typeof sendLaterSetup>, subject: string, when = at("2026-09-28T10:00:00Z")) {
  const tab = await ctx.fake.api.compose.beginNew(undefined, { to: ["bob@example.test"], subject, plainTextBody: `Body of ${subject}` });
  return ctx.sl.schedule(tab.id, when);
}

const sends = (fake: ReturnType<typeof createFakeMessenger>) => fake.forbidden.composeSendMessage;

describe("draft fingerprint", () => {
  it("ignores X-Mozilla-* bookkeeping headers and line-ending style, covers everything else", async () => {
    const a = "X-Mozilla-Status: 0001\r\nX-Mozilla-Keys: \r\n  $label1\r\nSubject: Hi\r\nTo: a@b\r\n\r\nBody\r\n";
    const b = "Subject: Hi\nTo: a@b\n\nBody\n";
    expect(normalizeRaw(a)).toBe(normalizeRaw(b));
    expect(await sha256Hex(normalizeRaw(a))).toBe(await sha256Hex(normalizeRaw(b)));
    expect(await sha256Hex(normalizeRaw("Subject: Hi\nTo: evil@x\n\nBody\n"))).not.toBe(await sha256Hex(normalizeRaw(b)));
    expect(await sha256Hex(normalizeRaw("Subject: Hi\nTo: a@b\n\nBody!\n"))).not.toBe(await sha256Hex(normalizeRaw(b)));
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("is stable when the draft's read flag changes", async () => {
    const fake = createFakeMessenger();
    const m = fake.addMessage({ folderId: "account1://Drafts", subject: "x", text: "y" });
    const before = await fingerprintMessage(fake.api, m.id);
    fake.messages.get(m.id)!.read = true;
    expect(await fingerprintMessage(fake.api, m.id)).toBe(before);
  });
});

describe("send later (tools add-on)", () => {
  it("saves the draft, closes compose, sends at the time, then trashes the draft", async () => {
    const ctx = sendLaterSetup(at("2026-09-28T09:00:00Z"));
    const { fake, sl, setNow } = ctx;
    const rec = await scheduleOne(ctx, "Report");
    expect(rec.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.to).toEqual(["bob@example.test"]);
    expect(fake.api.tabs.remove).toHaveBeenCalled();

    await sl.processDue();
    expect(sends(fake)).not.toHaveBeenCalled();

    setNow(at("2026-09-28T10:00:01Z"));
    await sl.processDue();
    expect(sends(fake)).toHaveBeenCalledTimes(1);
    expect(sends(fake).mock.calls[0][1]).toEqual({ mode: "sendNow" });
    expect(await sl.list()).toEqual([]);
    const draft = [...fake.messages.values()].find(m => m.subject === "Report")!;
    expect(draft.folderId).toBe("account1://Trash");
  });

  it("refuses to schedule without recipients", async () => {
    const { fake, sl } = sendLaterSetup(at("2026-09-28T09:00:00Z"));
    const tab = await fake.api.compose.beginNew(undefined, { subject: "x" });
    await expect(sl.schedule(tab.id, at("2026-09-28T10:00:00Z"))).rejects.toThrow(/recipient/);
  });

  it("Codex High #4: a record cancelled while another send is in flight is never sent", async () => {
    const ctx = sendLaterSetup(at("2026-09-28T09:00:00Z"));
    const { fake, sl, setNow } = ctx;
    const a = await scheduleOne(ctx, "First");
    const b = await scheduleOne(ctx, "Second");
    setNow(at("2026-09-28T10:00:01Z"));

    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    sends(fake).mockImplementationOnce(async () => {
      await gate; // the first send hangs...
      return { mode: "sendNow", messages: [] };
    });
    const run = sl.processDue();
    await vi.waitFor(() => expect(sends(fake)).toHaveBeenCalledTimes(1));

    // ...while the user cancels the second one: must succeed and stick.
    expect(await sl.cancel(b.key)).toBe(true);
    // The in-flight one cannot be cancelled.
    await expect(sl.cancel(a.key)).rejects.toThrow(/being sent/);

    release();
    await run;
    expect(sends(fake)).toHaveBeenCalledTimes(1);
    const sentSubjects = sends(fake).mock.calls.map(c => fake.composeTabs.get(c[0] as number)?.subject);
    expect(sentSubjects).not.toContain("Second");
    expect(await sl.list()).toEqual([]);
    // A later tick does not resurrect it either.
    await sl.processDue();
    expect(sends(fake)).toHaveBeenCalledTimes(1);
  });

  it("Codex High #3: a stored record with an invalid sendAt is never sent", async () => {
    const ctx = sendLaterSetup(at("2026-09-28T09:00:00Z"));
    const { fake, sl, store } = ctx;
    const rec = await scheduleOne(ctx, "Tampered");
    await store.update("sendLater", (map: any) => {
      map[rec.key].sendAt = "garbage";
    });
    await sl.processDue();
    await sl.processDue();
    expect(sends(fake)).not.toHaveBeenCalled();
    expect((await sl.list())[0].status).toBe("invalid");
  });

  it.each([
    ["missing fingerprint", (r: any) => delete r.fingerprint],
    ["key does not match identity", (r: any) => (r.headerMessageId = "other@x")],
    ["unknown status", (r: any) => (r.status = "go")],
    ["recipients not a list", (r: any) => (r.to = "evil@x")],
  ])("rejects a persisted record with %s", async (_, mutate) => {
    const ctx = sendLaterSetup(at("2026-09-28T09:00:00Z"));
    const { fake, sl, store, setNow } = ctx;
    const rec = await scheduleOne(ctx, "X");
    await store.update("sendLater", (map: any) => void mutate(map[rec.key]));
    setNow(at("2026-09-28T10:00:01Z"));
    await sl.processDue();
    expect(sends(fake)).not.toHaveBeenCalled();
  });

  it("Codex High #3: an injected record for a message the user never scheduled is not sent", async () => {
    const ctx = sendLaterSetup(at("2026-09-28T09:00:00Z"));
    const { fake, sl, store } = ctx;
    const victim = fake.addMessage({ folderId: "account1://Drafts", subject: "Never approved", headerMessageId: "v@x" });
    await store.put("sendLater", "account1|v@x", {
      key: "account1|v@x", accountId: "account1", headerMessageId: "v@x", draftFolderId: "account1://Drafts",
      identityId: null, subject: "Never approved", to: ["me@example.test"], cc: [], bcc: [],
      fingerprint: "f".repeat(64), sendAt: "2026-09-28T08:59:00Z", status: "scheduled", createdAt: "2026-09-28T08:00:00Z",
    });
    await sl.processDue();
    expect(sends(fake)).not.toHaveBeenCalled();
    expect(fake.messages.get(victim.id)!.folderId).toBe("account1://Drafts");
    expect((await sl.list())[0]).toMatchObject({ status: "failed" });
  });

  it("Codex High #3: swapping the draft for another message with the same Message-ID is detected", async () => {
    const ctx = sendLaterSetup(at("2026-09-28T09:00:00Z"));
    const { fake, sl, setNow, notes } = ctx;
    const rec = await scheduleOne(ctx, "Original");
    // Replace the draft: delete it and put a different message with the same id there.
    const original = [...fake.messages.values()].find(m => m.headerMessageId === rec.headerMessageId)!;
    fake.messages.delete(original.id);
    fake.addMessage({ folderId: "account1://Drafts", subject: "Original", headerMessageId: rec.headerMessageId, recipients: ["attacker@evil.test"], text: "changed" });
    setNow(at("2026-09-28T10:00:01Z"));
    await sl.processDue();
    expect(sends(fake)).not.toHaveBeenCalled();
    expect(notes.join()).toMatch(/changed after it was scheduled/);
  });

  it("refuses when two drafts share the Message-ID (ambiguous)", async () => {
    const ctx = sendLaterSetup(at("2026-09-28T09:00:00Z"));
    const { fake, sl, setNow, notes } = ctx;
    const rec = await scheduleOne(ctx, "Dup");
    fake.addMessage({ folderId: "account1://Drafts", subject: "Dup", headerMessageId: rec.headerMessageId });
    setNow(at("2026-09-28T10:00:01Z"));
    await sl.processDue();
    expect(sends(fake)).not.toHaveBeenCalled();
    expect(notes.join()).toMatch(/more than one draft/);
  });

  it("refuses when the draft folder is no longer a Drafts folder", async () => {
    const ctx = sendLaterSetup(at("2026-09-28T09:00:00Z"));
    const { fake, sl, setNow } = ctx;
    await scheduleOne(ctx, "Moved");
    fake.folders.find(f => f.id === "account1://Drafts")!.specialUse = [];
    setNow(at("2026-09-28T10:00:01Z"));
    await sl.processDue();
    expect(sends(fake)).not.toHaveBeenCalled();
  });

  it("refuses when the reopened compose window shows different recipients", async () => {
    const ctx = sendLaterSetup(at("2026-09-28T09:00:00Z"));
    const { fake, sl, setNow } = ctx;
    await scheduleOne(ctx, "Recip");
    fake.api.compose.getComposeDetails.mockImplementationOnce(async () => ({ to: ["someone-else@x"], cc: [], bcc: [], subject: "Recip" }));
    setNow(at("2026-09-28T10:00:01Z"));
    await sl.processDue();
    expect(sends(fake)).not.toHaveBeenCalled();
    expect((await sl.list())[0].status).toBe("failed");
  });

  it("does not send when Thunderbird was closed past the grace period", async () => {
    const ctx = sendLaterSetup(at("2026-09-28T09:00:00Z"));
    const { fake, sl, setNow, notes } = ctx;
    await scheduleOne(ctx, "Old");
    setNow(at("2026-09-29T10:00:00Z"));
    await sl.processDue();
    expect(sends(fake)).not.toHaveBeenCalled();
    expect((await sl.list())[0].status).toBe("missed");
    expect(notes.join()).toMatch(/missed/);
  });

  it("never retries a send interrupted mid-flight", async () => {
    const ctx = sendLaterSetup(at("2026-09-28T09:00:00Z"));
    const { fake, sl, store } = ctx;
    const rec = await scheduleOne(ctx, "Maybe sent", at("2026-09-28T09:00:40Z"));
    await store.update("sendLater", (map: any) => void (map[rec.key].status = "sending"));
    await sl.processDue();
    expect(sends(fake)).not.toHaveBeenCalled();
    expect((await sl.list())[0].status).toBe("unknown");
  });

  it("state machine property: under random interleavings of cancel and ticks, a cancelled record is never sent", async () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 25; round++) {
      const ctx = sendLaterSetup(at("2026-09-28T09:00:00Z"));
      const { fake, sl, setNow } = ctx;
      const recs = [];
      for (let i = 0; i < 4; i++) recs.push(await scheduleOne(ctx, `R${round}-${i}`));
      setNow(at("2026-09-28T10:00:01Z"));
      sends(fake).mockImplementation(async () => {
        await new Promise(r => setTimeout(r, Math.floor(rand() * 3)));
        return { mode: "sendNow", messages: [] };
      });
      const cancelled = new Set<string>();
      const ops: Promise<unknown>[] = [sl.processDue()];
      for (const r of recs) {
        if (rand() < 0.5) {
          ops.push(
            new Promise(res => setTimeout(res, Math.floor(rand() * 4))).then(() =>
              sl.cancel(r.key).then(ok => ok && cancelled.add(r.subject), () => undefined)
            )
          );
        }
      }
      ops.push(sl.processDue());
      await Promise.all(ops);
      await sl.processDue();
      const sentSubjects = sends(fake).mock.calls.map(c => fake.composeTabs.get(c[0] as number)?.subject);
      for (const s of cancelled) expect(sentSubjects, `round ${round}`).not.toContain(s);
      expect(new Set(sentSubjects).size).toBe(sentSubjects.length); // never twice
    }
  });

  it("isValidRecord accepts exactly well-formed records", () => {
    const ok = {
      key: "a|m@x", accountId: "a", headerMessageId: "m@x", draftFolderId: "a://Drafts", identityId: null, subject: "s",
      to: ["x@y"], cc: [], bcc: [], fingerprint: "0".repeat(64), sendAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z",
      status: "scheduled",
    };
    expect(isValidRecord(ok, "a|m@x")).toBe(true);
    expect(isValidRecord(ok, "a|other")).toBe(false);
    expect(isValidRecord({ ...ok, createdAt: "x" }, "a|m@x")).toBe(false);
    expect(isValidRecord(null, "a|m@x")).toBe(false);
  });
});
