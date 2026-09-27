import { describe, expect, it, vi } from "vitest";
import { createMailOps } from "../addons/bridge/src/bridge/ops.js";
import { createRoutes } from "../addons/bridge/src/bridge/routes.js";
import { createFakeMessenger } from "./helpers/fake-messenger.js";

function setup(opts: { withSaveMessage?: boolean } = {}) {
  const fake = createFakeMessenger({ pageSize: 2, ...opts });
  const ops = createMailOps({ api: fake.api });
  const routes = createRoutes({ ops, version: "t" });
  return { fake, ops, routes };
}

describe("bridge mail operations", () => {
  it("paginates search results with cursors across Thunderbird list pages", async () => {
    const { fake, routes } = setup();
    for (let i = 0; i < 7; i++) fake.addMessage({ folderId: "account1://INBOX", subject: `Invoice ${i}` });
    fake.addMessage({ folderId: "account1://INBOX", subject: "Unrelated" });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r: any = await routes["messages.search"]({ subject: "Invoice", limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...r.messages.map((m: any) => m.subject));
      cursor = r.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6].map(i => `Invoice ${i}`));
    await expect(routes["messages.search"]({ cursor: "doesnotexist" })).rejects.toThrow(/cursor/);
  });

  it("resolves special folder names and maps filters", async () => {
    const { fake, routes } = setup();
    fake.addMessage({ folderId: "account1://INBOX", subject: "In inbox", author: "Bob <bob@x>" });
    fake.addMessage({ folderId: "account1://Archive", subject: "Archived", author: "Bob <bob@x>" });
    const r: any = await routes["messages.search"]({ folder: "inbox", from: "bob@x", unread: true });
    expect(r.messages.map((m: any) => m.subject)).toEqual(["In inbox"]);
    const q = fake.api.messages.query.mock.calls.at(-1)![0];
    expect(q).toMatchObject({ folderId: ["account1://INBOX"], author: "bob@x", unread: true });
  });

  it("returns text bodies, converts HTML, truncates, and lists attachments without content", async () => {
    const { fake, routes } = setup();
    const m = fake.addMessage({
      folderId: "account1://INBOX",
      subject: "Newsletter",
      html: "<p>Hello <b>world</b></p><script>evil()</script>",
      attachments: [{ name: "a.pdf", contentType: "application/pdf", size: 1234, partName: "1.2" }],
      headers: { "in-reply-to": ["<p@x>"], "x-secret": ["no"] },
    });
    const r: any = await routes["messages.get"]({ messageId: m.id });
    expect(r.body).toEqual({ text: "Hello world", truncated: false, sourceType: "text/html" });
    expect(r.attachments).toEqual([{ name: "a.pdf", contentType: "application/pdf", size: 1234, partName: "1.2" }]);
    expect(r.headers).toEqual({ "in-reply-to": ["<p@x>"] });

    const long = fake.addMessage({ folderId: "account1://INBOX", subject: "Long", text: "x".repeat(500) });
    const t: any = await routes["messages.get"]({ messageId: long.id, maxBodyChars: 100 });
    expect(t.body.text).toHaveLength(100);
    expect(t.body.truncated).toBe(true);
  });

  it("prefers messengerUtilities.convertToPlainText when available", async () => {
    const { fake, routes } = setup();
    fake.api.messengerUtilities = { convertToPlainText: async () => "converted" };
    const m = fake.addMessage({ folderId: "account1://INBOX", subject: "H", html: "<p>x</p>" });
    expect(((await routes["messages.get"]({ messageId: m.id })) as any).body.text).toBe("converted");
  });

  it("reports unknown message ids as 404", async () => {
    const { routes } = setup();
    await expect(routes["messages.get"]({ messageId: 999 })).rejects.toMatchObject({ status: 404 });
  });

  it("assembles a thread from References and replies", async () => {
    const { fake, routes } = setup();
    const a = fake.addMessage({ folderId: "account1://INBOX", subject: "Plan", headerMessageId: "a@x", date: new Date("2026-09-01") });
    const b = fake.addMessage({
      folderId: "account1://INBOX", subject: "Re: Plan", headerMessageId: "b@x", date: new Date("2026-09-02"),
      headers: { references: ["<a@x>"], "in-reply-to": ["<a@x>"] },
    });
    fake.addMessage({
      folderId: "account1://INBOX", subject: "Re: Plan", headerMessageId: "c@x", date: new Date("2026-09-03"),
      headers: { references: ["<a@x> <b@x>"] },
    });
    fake.addMessage({ folderId: "account1://INBOX", subject: "Plan B (unrelated)", headerMessageId: "z@x" });
    const r: any = await routes["messages.thread"]({ messageId: b.id });
    expect(r.messages.map((m: any) => m.headerMessageId)).toEqual(["a@x", "b@x", "c@x"]);
    expect(a.id).toBeGreaterThan(0);
  });

  it("sets only existing tags, by key or label, and not the follow-up tag", async () => {
    const { fake, routes } = setup();
    const m = fake.addMessage({ folderId: "account1://INBOX", subject: "T", tags: ["$label1"] });
    await routes["messages.setTags"]({ messageId: m.id, add: ["work"], remove: ["$label1"] });
    expect(fake.messages.get(m.id)!.tags).toEqual(["$label2"]);
    await expect(routes["messages.setTags"]({ messageId: m.id, add: ["Nonexistent"] })).rejects.toThrow(/does not exist/);
    expect(fake.api.messages.tags.create).not.toHaveBeenCalled();
  });

  it("creates a new draft in the background on Thunderbird 153+ (messages.saveMessage)", async () => {
    const { fake, routes } = setup({ withSaveMessage: true });
    const r: any = await routes["drafts.create"]({ to: "bob@example.test", subject: "Hi", body: "Body" });
    expect(r).toMatchObject({ saved: true, sent: false });
    expect(r.draft.folder.id).toBe("account1://Drafts");
    expect((fake.api.messages as any).saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["bob@example.test"], plainTextBody: "Body", isPlainText: true }),
      { mode: "draft" }
    );
    expect(fake.api.compose.beginNew).not.toHaveBeenCalled();
  });

  it("falls back to compose + saveMessage + close on older Thunderbird", async () => {
    const { fake, routes } = setup();
    await routes["drafts.create"]({ to: ["bob@example.test"], subject: "Hi", body: "Body" });
    expect(fake.api.compose.beginNew).toHaveBeenCalled();
    expect(fake.api.compose.saveMessage).toHaveBeenCalledWith(expect.any(Number), { mode: "draft" });
    expect(fake.api.tabs.remove).toHaveBeenCalled();
    expect(fake.composeTabs.size).toBe(0);
  });

  it("creates reply drafts through beginReply details only (no compose permission needed)", async () => {
    const { fake, routes } = setup({ withSaveMessage: true });
    const orig = fake.addMessage({ folderId: "account1://INBOX", subject: "Question", text: "Can you?", headerMessageId: "q@x" });
    const r: any = await routes["drafts.create"]({ replyToMessageId: orig.id, body: "Yes <b>I</b> can", replyAll: true });
    expect(fake.api.compose.beginReply).toHaveBeenCalledTimes(1);
    const [id, type, details] = fake.api.compose.beginReply.mock.calls[0] as unknown as [number, string, any];
    expect([id, type]).toEqual([orig.id, "replyToAll"]);
    expect(details.isPlainText).toBe(true);
    expect(details.plainTextBody).toMatch(/^Yes <b>I<\/b> can\n\nOn .* wrote:\n> Can you\?\n$/);
    expect(details.to).toBeUndefined();
    // Never touched: reading or editing compose windows needs "compose".
    expect(fake.api.compose.getComposeDetails).not.toHaveBeenCalled();
    expect(fake.api.compose.setComposeDetails).not.toHaveBeenCalled();
    expect(fake.api.compose.saveMessage).toHaveBeenCalledWith(expect.any(Number), { mode: "draft" });
    expect(fake.api.tabs.remove).toHaveBeenCalled();
    expect(r.draft.folder.id).toBe("account1://Drafts");
    const saved = [...fake.messages.values()].find(m => m.folderId === "account1://Drafts")!;
    expect(saved.headers?.["In-Reply-To"]).toEqual(["<q@x>"]);
  });

  it("closes the reply compose window even when saving fails", async () => {
    const { fake, routes } = setup({ withSaveMessage: true });
    const orig = fake.addMessage({ folderId: "account1://INBOX", subject: "Q", text: "x" });
    fake.api.compose.saveMessage.mockRejectedValueOnce(new Error("disk full"));
    await expect(routes["drafts.create"]({ replyToMessageId: orig.id, body: "y" })).rejects.toThrow(/disk full/);
    expect(fake.api.tabs.remove).toHaveBeenCalled();
  });

  it("follow-ups are tag-only: set, list, clear", async () => {
    const { fake, routes } = setup();
    const m = fake.addMessage({ folderId: "account1://INBOX", subject: "Chase" });
    expect(await routes["followups.set"]({ messageId: m.id })).toEqual({ messageId: m.id, open: true });
    expect(fake.messages.get(m.id)!.tags).toContain("draftsafe_followup");
    const l: any = await routes["followups.list"]({});
    expect(l.followups.map((f: any) => f.subject)).toEqual(["Chase"]);
    await routes["followups.set"]({ messageId: m.id, done: true });
    expect(fake.messages.get(m.id)!.tags).not.toContain("draftsafe_followup");
    await expect(routes["followups.set"]({ messageId: m.id, due: "2030-01-01" })).rejects.toThrow(/unknown parameter/);
  });

  it("caps HTML input before conversion and caps metadata lists", async () => {
    const { fake, routes } = setup();
    const convert = vi.fn(async (h: string) => h);
    fake.api.messengerUtilities = { convertToPlainText: convert };
    const m = fake.addMessage({
      folderId: "account1://INBOX",
      subject: "S".repeat(5000),
      html: "<p>" + "x".repeat(3_000_000) + "</p>",
      recipients: Array.from({ length: 500 }, (_, i) => `r${i}@x`),
    });
    const r: any = await routes["messages.get"]({ messageId: m.id, maxBodyChars: 1000 });
    expect(convert.mock.calls[0][0].length).toBeLessThanOrEqual(1001 * 8);
    expect(r.body.text.length).toBe(1000);
    expect(r.message.subject.length).toBeLessThanOrEqual(1001);
    expect(r.message.recipients).toHaveLength(51);
    expect(r.message.recipients[50]).toMatch(/450 more/);
  });

  it("stops mutating once the request deadline has passed", async () => {
    const { fake, routes } = setup();
    const ids = [1, 2, 3].map(() => fake.addMessage({ folderId: "account1://INBOX", subject: "x" }).id);
    let checks = 0;
    const ctx = { check: () => { if (++checks > 1) throw Object.assign(new Error("late"), { code: "timeout" }); } };
    await expect(routes["messages.markRead"]({ messageIds: ids, read: true }, ctx)).rejects.toThrow(/late/);
    expect(fake.api.messages.update).toHaveBeenCalledTimes(1);
  });

  it("validates draft input", async () => {
    const { routes } = setup();
    await expect(routes["drafts.create"]({ body: "no recipient" })).rejects.toThrow(/recipient or a subject/);
    await expect(routes["drafts.create"]({ to: ["a@b\r\nBcc: x@y"], body: "x" })).rejects.toThrow(/invalid entry/);
    await expect(routes["drafts.create"]({ to: ["a@b"], subject: "a\nb", body: "x" })).rejects.toThrow(/single line/);
    await expect(routes["drafts.create"]({ to: ["a@b"] })).rejects.toThrow(/body is required/);
    await expect(routes["drafts.create"]({ to: ["a@b"], body: "x".repeat(100_001) })).rejects.toThrow(/at most/);
  });

  it("validates ids, limits and unknown keys on every route", async () => {
    const { routes } = setup();
    await expect(routes["messages.get"]({ messageId: "1" })).rejects.toThrow(/positive integer/);
    await expect(routes["messages.markRead"]({ messageIds: [] })).rejects.toThrow(/1 to 100/);
    await expect(routes["messages.search"]({ limit: 1000 })).rejects.toThrow(/between 1 and 100/);
    await expect(routes["accounts.list"]({ x: 1 })).rejects.toThrow(/unknown parameter/);
    expect((routes as any)["messages.snooze"]).toBeUndefined();
  });

  it("lists accounts with flattened folders and tags", async () => {
    const { routes } = setup();
    const r: any = await routes["accounts.list"]({});
    expect(r.accounts[0]).toMatchObject({ id: "account1", identities: [{ id: "id1", email: "me@example.test" }] });
    expect(r.accounts[0].folders.map((f: any) => f.name)).toContain("Inbox");
    expect(r.tags).toContainEqual({ key: "$label2", label: "Work", color: "#ff9900" });
  });
});
