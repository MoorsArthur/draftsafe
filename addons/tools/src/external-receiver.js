// SPDX-License-Identifier: MIT
// Classic background script: Thunderbird installs this listener before loading
// the module graph. It also runs first if an event page is ever woken again.
// No message on this channel can approve a request. The listener must return a
// Promise: Thunderbird drops plain return values from onMessageExternal.
(() => {
  const BRIDGE_ID = "draftsafe-bridge@draftsafe.dev";
  const PROTOCOL = 1;
  const HEALTH = "draftsafe.approval.health";
  let handler = null;

  messenger.runtime.onMessageExternal.addListener(async (message, sender) => {
    if (sender?.id !== BRIDGE_ID) return { ok: false, code: "forbidden_sender" };
    if (!message || typeof message !== "object" || message.v !== PROTOCOL) {
      return { ok: false, code: "bad_request" };
    }
    if (message.type === HEALTH && Object.keys(message).every(key => key === "type" || key === "v")) {
      return { ok: true, ready: handler !== null };
    }
    if (!handler) return { ok: false, code: "not_ready" };
    return handler(message, sender);
  });

  // The page and its module share a global; other extensions cannot call it.
  globalThis.draftsafeSetExternalHandler = fn => { handler = fn; };
})();
