// In-memory stand-in for the Thunderbird `messenger` API, just enough for the
// add-on's modules. Mimics two important real behaviours: message ids change
// when a message moves, and lists are paginated.

import { vi } from "vitest";

export interface FakeFolder {
  id: string;
  accountId: string;
  name: string;
  path: string;
  specialUse?: string[];
  subFolders?: FakeFolder[];
}

export interface FakeMessage {
  id: number;
  headerMessageId: string;
  folderId: string;
  subject: string;
  author: string;
  recipients: string[];
  date: Date;
  read: boolean;
  flagged: boolean;
  tags: string[];
  text?: string;
  html?: string;
  headers?: Record<string, string[]>;
  ccList?: string[];
  bccList?: string[];
  attachments?: { name: string; contentType: string; size: number; partName: string }[];
}

export function createFakeMessenger(opts: { pageSize?: number; withSaveMessage?: boolean; extraFolders?: FakeFolder[] } = {}) {
  const pageSize = opts.pageSize ?? 2;
  let nextId = 1;
  let nextTab = 100;
  const folders: FakeFolder[] = [
    { id: "account1://INBOX", accountId: "account1", name: "Inbox", path: "/INBOX", specialUse: ["inbox"] },
    { id: "account1://Drafts", accountId: "account1", name: "Drafts", path: "/Drafts", specialUse: ["drafts"] },
    { id: "account1://Trash", accountId: "account1", name: "Trash", path: "/Trash", specialUse: ["trash"] },
    { id: "account1://Archive", accountId: "account1", name: "Archive", path: "/Archive", specialUse: ["archives"] },
    ...(opts.extraFolders ?? []),
  ];
  const root: FakeFolder = { id: "account1://", accountId: "account1", name: "Root", path: "/" };
  const messages = new Map<number, FakeMessage>();
  const lists = new Map<string, FakeMessage[]>();
  const tags = [
    { key: "$label1", tag: "Important", color: "#ff0000", ordinal: "" },
    { key: "$label2", tag: "Work", color: "#ff9900", ordinal: "" },
  ];
  const composeTabs = new Map<number, Record<string, unknown>>();
  const tabRemovedListeners = new Set<(tabId: number) => void>();
  const storage: Record<string, unknown> = {};

  const folderById = (id: string) => folders.find(f => f.id === id);
  function folderTree(f: FakeFolder): FakeFolder {
    return { ...f, subFolders: folders.filter(child => child.accountId === f.accountId && child.path !== f.path && (child.path.slice(0, child.path.lastIndexOf("/")) || "/") === f.path).map(folderTree) };
  }
  const header = (m: FakeMessage) => ({
    id: m.id,
    headerMessageId: m.headerMessageId,
    subject: m.subject,
    author: m.author,
    recipients: m.recipients,
    ccList: m.ccList ?? [],
    bccList: m.bccList ?? [],
    date: m.date,
    read: m.read,
    flagged: m.flagged,
    tags: [...m.tags],
    external: false,
    folder: { ...folderById(m.folderId)! },
  });

  function page(all: FakeMessage[]) {
    const first = all.slice(0, pageSize).map(header);
    const rest = all.slice(pageSize);
    if (!rest.length) return { id: null, messages: first };
    const id = `list-${lists.size + 1}-${Math.random()}`;
    lists.set(id, rest);
    return { id, messages: first };
  }

  function addMessage(m: Partial<FakeMessage> & { folderId: string; subject: string }): FakeMessage {
    const msg: FakeMessage = {
      id: nextId++,
      headerMessageId: m.headerMessageId ?? `msg${nextId}@example.test`,
      author: "Alice <alice@example.test>",
      recipients: ["me@example.test"],
      date: new Date("2026-09-01T10:00:00Z"),
      read: false,
      flagged: false,
      tags: [],
      ...m,
    } as FakeMessage;
    messages.set(msg.id, msg);
    return msg;
  }

  /** RFC 822 text of a message, with a local-folder X-Mozilla-Status line. */
  function raw(m: FakeMessage) {
    const lines = [
      `X-Mozilla-Status: ${m.read ? "0001" : "0000"}`,
      `Message-ID: <${m.headerMessageId}>`,
      `Subject: ${m.subject}`,
      `From: ${m.author}`,
      `To: ${m.recipients.join(", ")}`,
    ];
    if (m.ccList?.length) lines.push(`Cc: ${m.ccList.join(", ")}`);
    for (const [k, v] of Object.entries(m.headers ?? {})) lines.push(`${k}: ${v.join(" ")}`);
    return `${lines.join("\r\n")}\r\n\r\n${m.text ?? m.html ?? ""}`;
  }

  function saveDraftFrom(d: Record<string, unknown>) {
    const list = (v: unknown) => ([] as unknown[]).concat(v ?? []).map(String);
    return addMessage({
      folderId: "account1://Drafts",
      subject: String(d.subject ?? ""),
      text: String(d.plainTextBody ?? d.body ?? ""),
      recipients: list(d.to),
      ccList: list(d.cc),
      bccList: list(d.bcc),
      headers: d.inReplyTo ? { "In-Reply-To": [`<${d.inReplyTo}>`] } : undefined,
    });
  }

  const forbidden = {
    composeSendMessage: vi.fn(async () => ({ mode: "sendNow", messages: [] })),
    composeBeginForward: vi.fn(async () => ({ id: nextTab++ })),
    messagesDelete: vi.fn(async () => undefined),
    messagesSendMessage: vi.fn(async () => ({ mode: "sendNow", messages: [] })),
    messagesArchive: vi.fn(async () => undefined),
  };

  const api = {
    runtime: { id: "draftsafe-mcp@draftsafe.dev", sendMessage: vi.fn(async (_id: string, msg: any): Promise<any> => msg.type === "draftsafe.approval.health" ? { ok: true, ready: true } : msg.type === "draftsafe.approval.request" ? { ok: true, requestId: "r" } : { ok: true, status: "done", outcome: { status: "denied" } }) },
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in storage ? { [key]: structuredClone(storage[key]) } : {})),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) storage[k] = structuredClone(v);
        }),
      },
    },
    accounts: {
      list: vi.fn(async () => [
        {
          id: "account1",
          name: "Work",
          type: "imap",
          identities: [{ id: "id1", name: "Me", email: "me@example.test" }],
          rootFolder: folderTree(root),
        },
      ]),
      get: vi.fn(async (id: string) => (id === "account1" ? { id, name: "Work", type: "imap", rootFolder: folderTree(root) } : null)),
    },
    folders: {
      query: vi.fn(async (q: { accountId?: string; specialUse?: string[] }) =>
        folders.filter(
          f =>
            (!q.accountId || f.accountId === q.accountId) &&
            (!q.specialUse || q.specialUse.every(u => f.specialUse?.includes(u)))
        )
      ),
      get: vi.fn(async (id: string) => {
        const f = folderById(id);
        if (!f) throw new Error(`Folder not found: ${id}`);
        return { ...f };
      }),
      getSubFolders: vi.fn(async (id: string) =>
        id === root.id ? folders.filter(f => f.accountId === "account1" && f.path.split("/").length === 2).map(f => ({ ...f })) : []
      ),
      getFolderInfo: vi.fn(async (id: string) => ({ totalMessageCount: [...messages.values()].filter(m => m.folderId === id).length, unreadMessageCount: [...messages.values()].filter(m => m.folderId === id && !m.read).length })),
      move: vi.fn(async (id: string, into: string) => {
        const f = folderById(id)!; const parent = folderById(into)!;
        f.path = `${parent.path}/${f.name}`; f.id = `${parent.id}/${f.name}`; return f;
      }),
      rename: vi.fn(async (id: string, name: string) => { const f = folderById(id)!; f.name = name; return f; }),
      create: vi.fn(async (parentId: string, name: string) => {
        const parent = parentId === root.id ? root : folderById(parentId)!;
        const path = `${parent.path === "/" ? "" : parent.path}/${name}`;
        const f: FakeFolder = { id: `account1:/${path}`, accountId: "account1", name, path };
        folders.push(f);
        return f;
      }),
    },
    messages: {
      list: vi.fn(async (folderId: string) => page([...messages.values()].filter(m => m.folderId === folderId))),
      get: vi.fn(async (id: number) => {
        const m = messages.get(id);
        if (!m) throw new Error(`Message not found: ${id}`);
        return header(m);
      }),
      query: vi.fn(async (q: Record<string, unknown>) => {
        let all = [...messages.values()];
        if (q.headerMessageId) all = all.filter(m => m.headerMessageId === q.headerMessageId);
        if (q.folderId) {
          const ids = ([] as string[]).concat(q.folderId as string | string[]);
          all = all.filter(m => ids.includes(m.folderId));
        }
        if (q.accountId) all = all.filter(m => folderById(m.folderId)?.accountId === q.accountId);
        if (q.unread !== undefined) all = all.filter(m => m.read !== q.unread);
        if (q.subject) all = all.filter(m => m.subject.includes(q.subject as string));
        if (q.author) all = all.filter(m => m.author.includes(q.author as string));
        if (q.fullText) all = all.filter(m => `${m.subject} ${m.text ?? ""}`.includes(q.fullText as string));
        if (q.tags) {
          const wanted = Object.keys((q.tags as { tags: Record<string, boolean> }).tags);
          all = all.filter(m => wanted.every(t => m.tags.includes(t)));
        }
        return page(all);
      }),
      continueList: vi.fn(async (id: string) => {
        const rest = lists.get(id);
        lists.delete(id);
        if (!rest) throw new Error("unknown list");
        return page(rest);
      }),
      abortList: vi.fn(async (id: string) => {
        lists.delete(id);
      }),
      update: vi.fn(async (id: number, props: { read?: boolean; tags?: string[] }) => {
        const m = messages.get(id);
        if (!m) throw new Error("not found");
        if (props.read !== undefined) m.read = props.read;
        if (props.tags) m.tags = [...props.tags];
      }),
      move: vi.fn(async (ids: number[], folderId: string) => {
        if (!folderById(folderId)) throw new Error(`no folder ${folderId}`);
        for (const id of ids) {
          const m = messages.get(id);
          if (!m) throw new Error("not found");
          messages.delete(id);
          // Like Thunderbird: a moved message gets a new id.
          const moved = { ...m, id: nextId++, folderId };
          messages.set(moved.id, moved);
        }
      }),
      listInlineTextParts: vi.fn(async (id: number) => {
        const m = messages.get(id)!;
        const parts = [];
        if (m.text !== undefined) parts.push({ contentType: "text/plain", content: m.text });
        if (m.html !== undefined) parts.push({ contentType: "text/html", content: m.html });
        return parts;
      }),
      listAttachments: vi.fn(async (id: number) => messages.get(id)?.attachments ?? []),
      getRaw: vi.fn(async (id: number) => {
        const m = messages.get(id);
        if (!m) throw new Error("not found");
        return raw(m);
      }),
      getFull: vi.fn(async (id: number) => ({ headers: messages.get(id)?.headers ?? {} })),
      tags: {
        list: vi.fn(async () => tags.map(t => ({ ...t }))),
        create: vi.fn(async (key: string, tag: string, color: string) => {
          tags.push({ key, tag, color, ordinal: "" });
          return key;
        }),
      },
      delete: forbidden.messagesDelete,
      archive: forbidden.messagesArchive,
      ...(opts.withSaveMessage
        ? {
            saveMessage: vi.fn(async (details: Record<string, unknown>) => {
              const m = saveDraftFrom(details);
              return { mode: "draft", messages: [header(m)] };
            }),
            sendMessage: forbidden.messagesSendMessage,
          }
        : {}),
    },
    compose: {
      beginNew: vi.fn(async (id?: number, details?: Record<string, unknown>) => {
        const tab = nextTab++;
        const from = id ? messages.get(id) : undefined;
        const base = from
          ? { isPlainText: true, plainTextBody: from.text ?? "", subject: from.subject, to: from.recipients, cc: from.ccList ?? [], bcc: from.bccList ?? [] }
          : { isPlainText: true, plainTextBody: "", subject: "", to: [] };
        composeTabs.set(tab, { ...base, ...(details ?? {}) });
        return { id: tab, type: "messageCompose" };
      }),
      // Like Thunderbird: details passed to beginReply replace the auto-quoted body.
      beginReply: vi.fn(async (id: number, _type?: string, details?: Record<string, unknown>) => {
        const m = messages.get(id)!;
        const tab = nextTab++;
        composeTabs.set(tab, {
          isPlainText: false,
          body: `<html><body><blockquote>${m.text ?? ""}</blockquote></body></html>`,
          subject: `Re: ${m.subject}`,
          to: [m.author],
          identityId: "id1",
          inReplyTo: m.headerMessageId,
          ...(details ?? {}),
        });
        return { id: tab, type: "messageCompose" };
      }),
      beginForward: forbidden.composeBeginForward,
      getComposeDetails: vi.fn(async (tab: number) => ({ ...composeTabs.get(tab)! })),
      setComposeDetails: vi.fn(async (tab: number, d: Record<string, unknown>) => {
        composeTabs.set(tab, { ...composeTabs.get(tab)!, ...d });
      }),
      saveMessage: vi.fn(async (tab: number) => {
        const m = saveDraftFrom(composeTabs.get(tab)!);
        return { mode: "draft", messages: [header(m)] };
      }),
      sendMessage: forbidden.composeSendMessage,
    },
    tabs: {
      remove: vi.fn(async (tab: number) => {
        composeTabs.delete(tab);
        for (const listener of tabRemovedListeners) listener(tab);
      }),
      onRemoved: { addListener: vi.fn((listener: (tabId: number) => void) => tabRemovedListeners.add(listener)) },
    },
    notifications: { create: vi.fn(async (_id: string, _details: Record<string, unknown>) => _id) },
    messengerUtilities: undefined as undefined | { convertToPlainText: (html: string) => Promise<string> },
  };

  return { api, messages, folders, composeTabs, storage, addMessage, forbidden, root, header };
}
