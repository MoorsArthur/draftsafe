import { describe, expect, it, vi } from "vitest";
import { createMailOps } from "../addons/bridge/src/bridge/ops.js";
import { createRoutes } from "../addons/shared/lib/mail-routes.js";
import { createDeadline } from "../addons/shared/lib/validate.js";
import { createFakeMessenger } from "./helpers/fake-messenger.js";

function setup(opts: Parameters<typeof createFakeMessenger>[0] = {}) {
  const fake = createFakeMessenger({ pageSize: 2, ...opts });
  const ops = createMailOps({ api: fake.api });
  const routes = createRoutes({ ops, version: "t" });
  return { fake, ops, routes };
}

describe("bridge mail operations", () => {
  it("lists folder counts without scanning every message", async () => {
    const { fake, routes } = setup();
    for (let i = 0; i < 40; i++) fake.addMessage({ folderId: "account1://INBOX", subject: `Mail ${i}` });
    const result: any = await routes["folders.detailed"]({});
    const inbox = result.folders.find((folder: any) => folder.id === "account1://INBOX");
    expect(inbox).toMatchObject({ count: 40, unread: 40, oldest: null, newest: null });
    expect(fake.api.messages.query).not.toHaveBeenCalled();
    expect(fake.api.messages.continueList).not.toHaveBeenCalled();
  });

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
    expect(pages).toBe(4);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6].map(i => `Invoice ${i}`));
    await expect(routes["messages.search"]({ cursor: "doesnotexist" })).rejects.toThrow(/cursor/);
  });

  it("requests only the needed Thunderbird page and does not prefetch the next page", async () => {
    const { fake, routes } = setup();
    for (let i = 0; i < 30; i++) fake.addMessage({ folderId: "account1://INBOX", subject: `Item ${i}` });
    const result: any = await routes["messages.search"]({ subject: "Item", limit: 4 });
    expect(result.messages).toHaveLength(2);
    expect(result.nextCursor).toBeTruthy();
    expect(fake.api.messages.query).toHaveBeenCalledWith(expect.objectContaining({ messagesPerPage: 4 }));
    expect(fake.api.messages.continueList).not.toHaveBeenCalled(); // first results return immediately
  });

  it("returns a partial fast page promptly and defers classification until get_message", async () => {
    const { fake, routes } = setup();
    for (let i = 0; i < 7; i++) fake.addMessage({ folderId: "account1://INBOX", subject: `Invoice ${i}` });
    const first: any = await routes["messages.search"]({ subject: "Invoice", limit: 4, fast: true });
    expect(first.messages).toHaveLength(2); // Thunderbird may return before its nominal page fills.
    expect(first.complete).toBe(false);
    expect(first.nextCursor).toBeTruthy();
    expect(first.messages[0]).toMatchObject({ classificationLoaded: false, hasListUnsubscribe: null });
    expect(fake.api.messages.query).toHaveBeenCalledWith(expect.objectContaining({ messagesPerPage: 4, autoPaginationTimeout: 400 }));
    expect(fake.api.messages.getFull).not.toHaveBeenCalled();
    const second: any = await routes["messages.search"]({ cursor: first.nextCursor });
    expect(second.messages[0].classificationLoaded).toBe(false);
    expect(fake.api.messages.getFull).not.toHaveBeenCalled();
  });

  it("finds recipients from sent mail and optional contacts without picking an ambiguous person", async () => {
    const { fake, routes } = setup({ extraFolders: [{ id: "account1://Sent", accountId: "account1",
      name: "Sent", path: "/Sent", specialUse: ["sent"] }] });
    fake.addMessage({ folderId: "account1://Sent", subject: "Hi", recipients: ["Alex One <alex.one@example.test>"] });
    fake.addMessage({ folderId: "account1://Sent", subject: "Again", recipients: ["Alex One <alex.one@example.test>"] });
    fake.api.permissions.contains.mockResolvedValue(true);
    fake.api.contacts.quickSearch.mockResolvedValue([
      { properties: { DisplayName: "Alex Two", PrimaryEmail: "alex.two@example.test" } },
    ]);
    const result: any = await routes["recipients.find"]({ query: "alex", limit: 10 });
    expect(result.candidates.map((candidate: any) => candidate.email)).toEqual([
      "alex.two@example.test", "alex.one@example.test",
    ]);
    expect(result.ambiguous).toBe(true);
    expect(result.contactsEnabled).toBe(true);
    expect(fake.api.contacts.quickSearch).toHaveBeenCalled();
  });

  it("does not query contacts before the Thunderbird permission is granted", async () => {
    const { fake, routes } = setup({ extraFolders: [{ id: "account1://Sent", accountId: "account1",
      name: "Sent", path: "/Sent", specialUse: ["sent"] }] });
    fake.addMessage({ folderId: "account1://Sent", subject: "Hi", recipients: ["Jane <jane@example.test>"] });
    const result: any = await routes["recipients.find"]({ query: "jane" });
    expect(result).toMatchObject({ contactsEnabled: false, contactsSearched: false, ambiguous: false });
    expect(result.candidates.map((candidate: any) => candidate.email)).toEqual(["jane@example.test"]);
    expect(fake.api.contacts.quickSearch).not.toHaveBeenCalled();
    await expect(routes["recipients.find"]({ query: " " })).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("reports a completed empty search only when Thunderbird has no cursor", async () => {
    const { routes } = setup();
    const result: any = await routes["messages.search"]({ subject: "NoSuchSubject", fast: true });
    expect(result).toMatchObject({ messages: [], nextCursor: null, complete: true });
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

  it("checks the search deadline after Thunderbird's query returns", async () => {
    const { fake, routes } = setup();
    let clock = 0;
    fake.api.messages.query.mockImplementationOnce(async () => {
      clock = 80_001;
      return { messages: [], id: null };
    });
    await expect(routes["messages.search"]({ query: "Kioz", limit: 10 }, createDeadline(80_000, () => clock)))
      .rejects.toMatchObject({ code: "timeout", status: 504 });
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

  it("saves an HTML reply draft with Thunderbird's signature, quote and threading", async () => {
    const { fake, routes } = setup({ withSaveMessage: true, withHtmlSignature: true });
    const orig = fake.addMessage({ folderId: "account1://INBOX", subject: "Question", text: "Can you?", headerMessageId: "q@x" });
    const r: any = await routes["drafts.create"]({ replyToMessageId: orig.id, body: "Yes <b>I</b> can", replyAll: true });
    expect(fake.api.compose.beginReply).toHaveBeenCalledTimes(1);
    const [id, type, details] = fake.api.compose.beginReply.mock.calls[0] as unknown as [number, string, any];
    expect([id, type]).toEqual([orig.id, "replyToAll"]);
    expect(details).toEqual({ identityId: "id1" });
    expect(details.to).toBeUndefined();
    expect(fake.api.compose.getComposeDetails).toHaveBeenCalledTimes(1);
    expect(fake.api.compose.setComposeDetails).toHaveBeenCalledTimes(1);
    expect(fake.api.compose.saveMessage).toHaveBeenCalledWith(expect.any(Number), { mode: "draft" });
    expect(fake.api.tabs.remove).toHaveBeenCalled();
    expect(r.draft.folder.id).toBe("account1://Drafts");
    const saved = [...fake.messages.values()].find(m => m.folderId === "account1://Drafts")!;
    expect(saved.text).toBe('<html><body><p>Yes &lt;b&gt;I&lt;/b&gt; can</p><blockquote>Can you?</blockquote><div class="moz-signature"><img src="cid:logo">Arthur</div></body></html>');
    expect(saved.headers?.["In-Reply-To"]).toEqual(["<q@x>"]);
  });

  it("saves a plain-text reply draft without a signature and keeps its quote", async () => {
    const { fake, routes } = setup({ withSaveMessage: true, plainTextCompose: true });
    const orig = fake.addMessage({ folderId: "account1://INBOX", subject: "Question", text: "Can you?" });
    await routes["drafts.create"]({ replyToMessageId: orig.id, body: "Yes, I can." });
    const saved = [...fake.messages.values()].find(m => m.folderId === "account1://Drafts")!;
    expect(saved.text).toBe("Yes, I can.\n\nOn Alice wrote:\n> Can you?");
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
