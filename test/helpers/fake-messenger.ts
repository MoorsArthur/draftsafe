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
  attachments?: { name: string; contentType: string; size: number; partName: string }[];
}

export function createFakeMessenger(opts: { pageSize?: number; withSaveMessage?: boolean } = {}) {
  const pageSize = opts.pageSize ?? 2;
  let nextId = 1;
  let nextTab = 100;
  const folders: FakeFolder[] = [
    { id: "account1://INBOX", accountId: "account1", name: "Inbox", path: "/INBOX", specialUse: ["inbox"] },
    { id: "account1://Drafts", accountId: "account1", name: "Drafts", path: "/Drafts", specialUse: ["drafts"] },
    { id: "account1://Trash", accountId: "account1", name: "Trash", path: "/Trash", specialUse: ["trash"] },
    { id: "account1://Archive", accountId: "account1", name: "Archive", path: "/Archive", specialUse: ["archives"] },
  ];
  const root: FakeFolder = { id: "account1://", accountId: "account1", name: "Root", path: "/" };
  const messages = new Map<number, FakeMessage>();
  const lists = new Map<string, FakeMessage[]>();
  const tags = [
    { key: "$label1", tag: "Important", color: "#ff0000", ordinal: "" },
    { key: "$label2", tag: "Work", color: "#ff9900", ordinal: "" },
  ];
  const composeTabs = new Map<number, Record<string, unknown>>();
  const storage: Record<string, unknown> = {};

  const folderById = (id: string) => folders.find(f => f.id === id);
  const header = (m: FakeMessage) => ({
    id: m.id,
    headerMessageId: m.headerMessageId,
    subject: m.subject,
    author: m.author,
    recipients: m.recipients,
    ccList: [],
    bccList: [],
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

  const forbidden = {
    composeSendMessage: vi.fn(async () => ({ mode: "sendNow", messages: [] })),
    composeBeginForward: vi.fn(async () => ({ id: nextTab++ })),
    messagesDelete: vi.fn(async () => undefined),
    messagesSendMessage: vi.fn(async () => ({ mode: "sendNow", messages: [] })),
    messagesArchive: vi.fn(async () => undefined),
  };

  const api = {
    runtime: { id: "draftsafe-mcp@draftsafe.dev" },
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
          rootFolder: { ...root, subFolders: folders.filter(f => f.accountId === "account1") },
        },
      ]),
      get: vi.fn(async (id: string) => (id === "account1" ? { id, name: "Work", type: "imap", rootFolder: root } : null)),
    },
    folders: {
      query: vi.fn(async (q: { accountId?: string; specialUse?: string[] }) =>
        folders.filter(
          f =>
            (!q.accountId || f.accountId === q.accountId) &&
            (!q.specialUse || q.specialUse.every(u => f.specialUse?.includes(u)))
        )
      ),
      getSubFolders: vi.fn(async (id: string) => (id === root.id ? folders.filter(f => f.accountId === "account1") : [])),
      create: vi.fn(async (parentId: string, name: string) => {
        const f: FakeFolder = { id: `${parentId}${name}`, accountId: "account1", name, path: `/${name}` };
        folders.push(f);
        return f;
      }),
    },
    messages: {
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
              const m = addMessage({ folderId: "account1://Drafts", subject: String(details.subject ?? ""), text: String(details.plainTextBody ?? "") });
              return { mode: "draft", messages: [header(m)] };
            }),
            sendMessage: forbidden.messagesSendMessage,
          }
        : {}),
    },
    compose: {
      beginNew: vi.fn(async (_id?: number, details?: Record<string, unknown>) => {
        const tab = nextTab++;
        composeTabs.set(tab, { isPlainText: true, plainTextBody: "", subject: "", to: [], ...(details ?? {}) });
        return { id: tab, type: "messageCompose" };
      }),
      beginReply: vi.fn(async (id: number) => {
        const m = messages.get(id)!;
        const tab = nextTab++;
        composeTabs.set(tab, {
          isPlainText: false,
          body: `<html><body><blockquote>${m.text ?? ""}</blockquote></body></html>`,
          subject: `Re: ${m.subject}`,
          to: [m.author],
          identityId: "id1",
        });
        return { id: tab, type: "messageCompose" };
      }),
      beginForward: forbidden.composeBeginForward,
      getComposeDetails: vi.fn(async (tab: number) => ({ ...composeTabs.get(tab)! })),
      setComposeDetails: vi.fn(async (tab: number, d: Record<string, unknown>) => {
        composeTabs.set(tab, { ...composeTabs.get(tab)!, ...d });
      }),
      saveMessage: vi.fn(async (tab: number) => {
        const d = composeTabs.get(tab)!;
        const m = addMessage({
          folderId: "account1://Drafts",
          subject: String(d.subject ?? ""),
          text: String(d.plainTextBody ?? d.body ?? ""),
        });
        return { mode: "draft", messages: [header(m)] };
      }),
      sendMessage: forbidden.composeSendMessage,
    },
    tabs: { remove: vi.fn(async (tab: number) => void composeTabs.delete(tab)) },
    messengerUtilities: undefined as undefined | { convertToPlainText: (html: string) => Promise<string> },
  };

  return { api, messages, folders, composeTabs, storage, addMessage, forbidden, root };
}
