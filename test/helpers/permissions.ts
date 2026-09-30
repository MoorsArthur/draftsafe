// The bridge's permission contract, shared by the permission and fuzz tests.

export const BRIDGE_PERMISSIONS = [
  "accountsRead",
  "messagesRead",
  "messagesUpdate",
  "messagesTags",
  "messagesTagsList",
  "messages.save",
  "compose.save",
].sort();

/** Permissions that could send, move or delete mail, or edit compose windows. */
export const FORBIDDEN_PERMISSIONS = [
  "compose",
  "compose.send",
  "messages.send",
  "messagesDelete",
  "messagesMove",
  "messagesImport",
  "messagesModifyPermanent",
  "accountsFolders",
  "accountsIdentities",
  "sensitiveDataUpload",
  "nativeMessaging",
  "downloads",
  "tabs",
  "<all_urls>",
];

/**
 * Every MailExtension function the bridge is allowed to use, with the
 * permissions Thunderbird 156 requires for it (namespace + function level),
 * taken from the API schemas in omni.ja. "experiment" = its own Experiment API.
 */
export const API_PERMISSIONS: Record<string, string[]> = {
  "runtime.getManifest": [],
  "runtime.sendMessage": [],
  "folders.getFolderInfo": ["accountsRead"],
  "accounts.list": ["accountsRead"],
  "folders.query": ["accountsRead"],
  "messages.get": ["messagesRead"],
  "messages.query": ["messagesRead"],
  "messages.continueList": ["messagesRead"],
  "messages.abortList": ["messagesRead"],
  "messages.getHeaders": ["messagesRead"],
  "messages.getFull": ["messagesRead"],
  "messages.listInlineTextParts": ["messagesRead"],
  "messages.listAttachments": ["messagesRead"],
  "messages.update": ["messagesRead", "messagesUpdate"],
  "messages.saveMessage": ["messagesRead", "messages.save"],
  "messages.tags.list": ["messagesTagsList"],
  "messages.tags.create": ["messagesTags"],
  "compose.beginNew": [],
  "compose.beginReply": [],
  "compose.saveMessage": ["compose.save"],
  "tabs.remove": [],
  "tabs.onRemoved.addListener": [],
  "notifications.create": ["notifications"],
  "messengerUtilities.convertToPlainText": [],
  "draftsafeBridge.start": ["experiment"],
  "draftsafeBridge.publishConnection": ["experiment"],
  "draftsafeBridge.onRequest.addListener": ["experiment"],
};
