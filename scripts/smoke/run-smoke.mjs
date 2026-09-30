#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real smoke test: a throwaway Thunderbird profile under Xvfb with the
// combined add-on (plus a test-only seeder) installed, driven through the real MCP
// server. Never touches the user's profile or display.
//
//   npm run build && node scripts/smoke/run-smoke.mjs [--keep]
//
// Requires: xvfb-run, xte (xautomation; quits Thunderbird with Ctrl+Q so
// shutdown handlers run), Thunderbird (snap at /snap/bin/thunderbird by default,
// override with THUNDERBIRD=/path/to/a/standalone/binary). The snap profile
// lives under ~/snap/thunderbird/common; a standalone build uses a temporary
// state directory that is removed with the headless session.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { zip } from "../build-xpi.mjs";
import { buildSmokeAddon } from "./build-tools.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEEP = process.argv.includes("--keep");
const TB = process.env.THUNDERBIRD || "/snap/bin/thunderbird";
const home = os.homedir();
const snapCommon = join(home, "snap", "thunderbird", "common");
const smokeBase = TB === "/snap/bin/thunderbird" ? snapCommon : join(os.tmpdir(), "draftsafe-smoke");
const CONN = join(smokeBase, "draftsafe-smoke-mcp", "connection.json");
const REAL_PROFILE = join(home, "snap", "thunderbird", "current", ".config", "thunderbird");
const IDS = { addon: "draftsafe-tools@draftsafe.dev", seed: "draftsafe-smoke-seed@test.invalid" };

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(what, fn, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

// ------------------------------------------------------------- preflight --

// An interactive desktop session can leak a snap Thunderbird window onto the
// user's real display despite Xvfb. Run this only from a separate headless
// login/session with no inherited graphical display.
if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
  console.error("Refusing GUI smoke from an interactive desktop session. Use a separate headless session.");
  process.exit(2);
}
if (existsSync(CONN)) {
  console.error(`${CONN} already exists (a real Draftsafe bridge may be running); refusing to run.`);
  process.exit(2);
}
for (const f of ["draftsafe.xpi", "index.js"]) {
  if (!existsSync(join(root, "dist", f))) {
    console.error(`dist/${f} missing: run npm run build first`);
    process.exit(2);
  }
}
mkdirSync(smokeBase, { recursive: true });
const profile = mkdtempSync(join(smokeBase, "tmp-draftsafe-"));
if (profile.startsWith(REAL_PROFILE)) throw new Error("refusing to use the real profile");
const logFile = join(root, "dist", "smoke-thunderbird.log");
console.log(`profile: ${profile}`);

// ------------------------------------------------------------- SMTP trap --
// Any connection here means Thunderbird tried to send mail.
let smtpConnections = 0;
const trap = net.createServer(sock => {
  smtpConnections++;
  sock.end("421 smoke test: sending is not allowed\r\n");
});
await new Promise(r => trap.listen(0, "127.0.0.1", r));
const trapPort = trap.address().port;

// ---------------------------------------------------------------- profile --

const prefs = {
  "xpinstall.signatures.required": false,
  "extensions.autoDisableScopes": 0,
  "extensions.enabledScopes": 15,
  "extensions.experiments.enabled": true,
  "extensions.update.enabled": false,
  "extensions.getAddons.cache.enabled": false,
  "app.update.enabled": false,
  "app.update.auto": false,
  "alerts.useSystemBackend": false,
  "mail.shell.checkDefaultClient": false,
  "mail.provider.suppress_dialog_on_startup": true,
  "mailnews.start_page.enabled": false,
  "mail.rights.version": 1,
  "mail.spotlight.firstRunDone": true,
  "datareporting.policy.dataSubmissionEnabled": false,
  "datareporting.healthreport.uploadEnabled": false,
  "toolkit.telemetry.enabled": false,
  "browser.dom.window.dump.enabled": true,
  "devtools.console.stdout.chrome": true,
  "devtools.console.stdout.content": true,
  "offline.autoDetect": false,
  // Accounts: Local Folders plus a POP3 account that never connects.
  "mail.accountmanager.accounts": "account2,account1",
  "mail.accountmanager.defaultaccount": "account2",
  "mail.accountmanager.localfoldersserver": "server1",
  "mail.account.account1.server": "server1",
  "mail.server.server1.type": "none",
  "mail.server.server1.hostname": "Local Folders",
  "mail.server.server1.name": "Local Folders",
  "mail.server.server1.userName": "nobody",
  "mail.server.server1.directory-rel": "[ProfD]Mail/Local Folders",
  "mail.account.account2.server": "server2",
  "mail.account.account2.identities": "id1",
  "mail.server.server2.type": "pop3",
  "mail.server.server2.hostname": "127.0.0.1",
  "mail.server.server2.port": 1,
  "mail.server.server2.userName": "smoke",
  "mail.server.server2.name": "Smoke Test",
  "mail.server.server2.directory-rel": "[ProfD]Mail/smoke-pop",
  "mail.server.server2.login_at_startup": false,
  "mail.server.server2.check_new_mail": false,
  "mail.server.server2.download_on_biff": false,
  "mail.identity.id1.fullName": "Smoke Tester",
  "mail.identity.id1.useremail": "smoke@example.test",
  "mail.identity.id1.smtpServer": "smtp1",
  "mail.identity.id1.valid": true,
  "mail.identity.id1.compose_html": false,
  "mail.smtpservers": "smtp1",
  "mail.smtp.defaultserver": "smtp1",
  "mail.smtpserver.smtp1.hostname": "127.0.0.1",
  "mail.smtpserver.smtp1.port": trapPort,
  "mail.smtpserver.smtp1.authMethod": 1,
  "mail.smtpserver.smtp1.try_ssl": 0,
};
writeFileSync(
  join(profile, "user.js"),
  Object.entries(prefs)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join("\n") + "\n"
);
mkdirSync(join(profile, "extensions"));
buildSmokeAddon(join(profile, "extensions", `${IDS.addon}.xpi`));
const seedDir = join(root, "scripts", "smoke", "seed");
writeFileSync(
  join(profile, "extensions", `${IDS.seed}.xpi`),
  zip(readdirSync(seedDir).map(f => [join(seedDir, f), f]))
);

// ----------------------------------------------------------- Xvfb + TB ---

// xvfb-run -a picks a free display and an auth file; `snap run` migrates that
// file into the snap's private area. Display variables are scrubbed as a
// second safeguard after the headless-session preflight.
// The snap's desktop-launch switches GTK to Wayland whenever
// $XDG_RUNTIME_DIR/../wayland-0 exists, even with WAYLAND_DISPLAY unset, which
// would put windows on the user's real desktop. DISABLE_WAYLAND plus a
// nonexistent WAYLAND_DISPLAY keeps it on the Xvfb display.
const env = {
  ...process.env,
  DISABLE_WAYLAND: "1",
  WAYLAND_DISPLAY: "draftsafe-no-wayland",
  GDK_BACKEND: "x11",
  MOZ_ENABLE_WAYLAND: "0",
  MOZ_CRASHREPORTER_DISABLE: "1",
  XDG_SESSION_TYPE: "x11",
};
if (TB !== "/snap/bin/thunderbird") {
  env.XDG_STATE_HOME = smokeBase;
  delete env.SNAP_USER_COMMON;
}
for (const k of ["DISPLAY", "XAUTHORITY", "DESKTOP_STARTUP_ID", "XDG_ACTIVATION_TOKEN"]) delete env[k];
const log = [];
const tb = spawn("xvfb-run", ["-a", "-s", "-screen 0 1280x1024x24", TB, "-profile", profile, "-no-remote"], { env, stdio: ["ignore", "pipe", "pipe"] });
tb.stdout.on("data", d => log.push(d.toString()));
tb.stderr.on("data", d => log.push(d.toString()));
let tbExit = null;
tb.on("exit", code => (tbExit = code ?? "signal"));
console.log(`xvfb-run pid ${tb.pid}`);

// Our Thunderbird main process only: matched by the unique temporary profile
// path, excluding xvfb-run itself (killing it would take the X server down
// first and turn a graceful quit into a crash) and content processes.
function ourThunderbirdPids() {
  let out = "";
  try {
    out = execFileSync("pgrep", ["-af", "--", `-profile ${profile}`], { encoding: "utf8" });
  } catch {
    return [];
  }
  return out
    .split("\n")
    .map(l => /^(\d+) (.*)$/.exec(l))
    .filter(m => m && Number(m[1]) !== tb.pid && Number(m[1]) !== process.pid && !/xvfb-run|-contentproc|pgrep/.test(m[2]))
    .map(m => Number(m[1]));
}

function ourDisplayEnv() {
  const xvfbLine = execFileSync("pgrep", ["-a", "-P", String(tb.pid), "Xvfb"], { encoding: "utf8" }).trim();
  const display = /\s(:\d+)\s/.exec(xvfbLine)?.[1];
  const auth = /-auth\s+(\S+)/.exec(xvfbLine)?.[1];
  if (!display || display === process.env.DISPLAY || !auth) throw new Error("unsafe X display");
  return { PATH: process.env.PATH, DISPLAY: display, XAUTHORITY: auth };
}

function clickOnOurDisplay(point) {
  execFileSync("xte", [`mousemove ${point.x} ${point.y}`, "mouseclick 1"], {
    env: ourDisplayEnv(),
  });
}

let mcp = null;
try {
  const conn = await waitFor("the bridge's connection file", () => tbExit === null && existsSync(CONN) && CONN, 120_000).catch(e => {
    throw new Error(`${e.message}; thunderbird exit=${tbExit}`);
  });
  const mode = statSync(conn).mode & 0o777;
  const dirMode = statSync(dirname(conn)).mode & 0o777;
  check("bridge started and published its connection file", true, `file ${mode.toString(8)}, dir ${dirMode.toString(8)}`);
  check("connection file is private (600 in a 700 dir)", mode === 0o600 && dirMode === 0o700);

  // Transport soak: many sequential requests must all be answered.
  {
    const { port, token } = JSON.parse(readFileSync(conn, "utf8"));
    const errors = [];
    for (let i = 0; i < 60; i++) {
      await fetch(`http://127.0.0.1:${port}/v1/health`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      })
        .then(r => r.text().then(t => (r.status === 200 ? null : errors.push(`${i}: ${r.status} ${t.slice(0, 80)}`))))
        .catch(e => errors.push(`${i}: ${e.cause?.code || e.message}`));
    }
    const rawErrors = [];
    for (let i = 0; i < 40; i++) {
      const body = "{}";
      const req = `POST /v1/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
      const res = await new Promise(resolve => {
        const sock = net.connect(port, "127.0.0.1");
        let got = "";
        let err = null;
        sock.on("data", d => (got += d));
        sock.on("error", e => (err = e.code));
        sock.on("close", () => resolve({ got, err }));
        sock.write(req);
      });
      if (res.err || !res.got.startsWith("HTTP/1.1 200")) rawErrors.push(`${i}: err=${res.err} bytes=${res.got.length} ${JSON.stringify(res.got.slice(0, 40))}`);
    }
    check("bridge answers 40 raw single-write requests", rawErrors.length === 0, rawErrors.slice(0, 5).join("; "));
    check("bridge answers 60 sequential requests without dropping one", errors.length === 0, errors.slice(0, 5).join("; "));
  }

  // ------------------------------------------------------------ MCP client --
  mcp = new Client({ name: "draftsafe-smoke", version: "1" });
  await mcp.connect(
    new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "index.js")], env: { ...process.env, DRAFTSAFE_CONNECTION_FILE: conn }, stderr: "pipe" })
  );
  const unwrap = r => {
    const text = r.content[0].text;
    const m = /<<<UNTRUSTED_MAIL_DATA ([0-9a-f]+)>>>\n([\s\S]*)\n<<<END_UNTRUSTED_MAIL_DATA \1>>>/.exec(text);
    if (!m) throw new Error(`not wrapped: ${text.slice(0, 300)}`);
    return JSON.parse(m[2]);
  };
  const tool = async (name, args = {}, choice = "apply", beforeClick) => {
    const logStart = log.length;
    let settled = false;
    const pending = mcp.callTool({ name, arguments: args }, undefined, { timeout: 730_000 }).finally(() => { settled = true; });
    void pending.catch(() => {}); // cleanup must still run if the UI driver fails
    if (name.startsWith("request_") || ["set_tags", "mark_read", "set_followup", "create_draft"].includes(name)) {
      const geometry = await waitFor("approval page", () => {
        const match = /DRAFTSAFE_SMOKE_READY:(\d+),(\d+),(\d+),(\d+)/.exec(log.slice(logStart).join(""));
        if (match) return { apply: { x: +match[1], y: +match[2] }, deny: { x: +match[3], y: +match[4] } };
        return settled ? { refused: true } : null;
      }, 30_000);
      if (!geometry.refused) {
        if (beforeClick) await beforeClick();
        clickOnOurDisplay(geometry[choice]);
      }
    }
    const r = await pending;
    if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
    return unwrap(r);
  };

  const { tools } = await mcp.listTools();
  check("MCP lists sixteen read, approval and compose tools", tools.length === 16 && !tools.some(t => /send|delete|move|snooze|forward/.test(t.name)), tools.map(t => t.name).join(","));

  const accounts = await tool("list_accounts");
  const pop = accounts.accounts.find(a => a.identities.length);
  check("list_accounts returns the test account and folders", !!pop && pop.folders.length > 0, `${accounts.accounts.length} accounts; ${pop?.folders.map(f => f.name).join(", ")}`);
  check("tools add-on created the shared Follow up tag", accounts.tags.some(t => t.key === "draftsafe_followup"));

  const inbox = await waitFor("seeded messages", async () => {
    const r = await tool("search_messages", { folder: "inbox", account_id: pop.id });
    return r.messages.length >= 3 ? r : null;
  }, 60_000);
  check("search_messages finds the three seeded messages", inbox.messages.length === 3, inbox.messages.map(m => m.subject).join(" | "));

  const injected = inbox.messages.find(m => m.subject === "Prompt injection test");
  const lunch = inbox.messages.find(m => m.subject === "Lunch on Friday?");
  const raw = await mcp.callTool({ name: "get_message", arguments: { message_id: injected.id } });
  const rawText = raw.content[0].text;
  const begin = rawText.indexOf("<<<UNTRUSTED_MAIL_DATA");
  check("get_message returns the body inside the untrusted-data block", begin > 0 && rawText.indexOf("IGNORE ALL PREVIOUS") > begin);
  const full = unwrap(raw);
  check("get_message returns headers and plain-text body", full.body.text.includes("attacker@evil.test") && full.headers["message-id"]?.[0]?.includes("pi@smoke.test"));

  const thread = await tool("get_thread", { message_id: lunch.id });
  check("get_thread works", thread.messages.length >= 1);

  await tool("set_tags", { message_id: lunch.id, add: ["Important"] });
  const tagged = await tool("search_messages", { tag: "$label1" });
  check("set_tags adds an existing tag", tagged.messages.some(m => m.subject === "Lunch on Friday?"));

  await tool("mark_read", { message_id: lunch.id, read: true });
  const unread = await tool("search_messages", { folder: "inbox", account_id: pop.id, unread: true });
  check("mark_read marks read", !unread.messages.some(m => m.subject === "Lunch on Friday?"), `${unread.messages.length} unread left`);

  await tool("set_followup", { message_id: lunch.id });
  const fu = await tool("list_followups");
  check("set_followup / list_followups use the shared tag", fu.followups.some(m => m.subject === "Lunch on Friday?"));
  await tool("set_followup", { message_id: lunch.id, done: true });

  const newDraft = await tool("create_draft", {
    to: ["someone@example.test"],
    subject: "Smoke draft (new)",
    body: "This is a new draft from the smoke test. It must never be sent.",
  });
  check("create_draft (new) saves and reports sent:false", newDraft.status === "approved" && newDraft.saved === true && newDraft.sent === false, newDraft.draft?.folder?.name);

  const reply = await tool("create_draft", { reply_to_message_id: inbox.messages.find(m => m.subject === "Quarterly report").id, body: "Thanks, looks good." });
  check("create_draft (reply) saves via a compose window and reports sent:false", reply.saved === true && reply.sent === false, reply.draft?.subject);

  const drafts = await tool("search_messages", { folder: "drafts" });
  const draftSubjects = drafts.messages.map(m => m.subject);
  check("both drafts are in Drafts", draftSubjects.includes("Smoke draft (new)") && draftSubjects.some(s => /Quarterly report/.test(s)), draftSubjects.join(" | "));
  const sentQ = await mcp.callTool({ name: "search_messages", arguments: { folder: "sent" } });
  const outboxQ = await mcp.callTool({ name: "search_messages", arguments: { folder: "outbox" } });
  const count = r => (r.isError ? 0 : unwrap(r).messages.length);
  check("nothing in Sent or Outbox (via the bridge)", count(sentQ) === 0 && count(outboxQ) === 0, `sent ${sentQ.isError ? "no folder" : count(sentQ)}, outbox ${outboxQ.isError ? "no folder" : count(outboxQ)}`);

  // Approval boundaries with real trusted X11 pointer clicks on our Xvfb only.
  const detailed = await tool("list_folders_detailed", { account_id: pop.id });
  check("detailed folders use counts without scanning dates", detailed.folders.some(f =>
    f.specialUse.includes("inbox") && f.count === 3 && f.oldest === null && f.newest === null));
  const request = { batches: [{ message_ids: [lunch.id], action: "trash", reason: "Smoke approval boundary" }] };
  const denied = await tool("request_cleanup", request, "deny", async () => {
    const stillInbox = await tool("get_message", { message_id: lunch.id });
    check("synthetic click does not approve", stillInbox.message.folder.specialUse.includes("inbox"));
  });
  check("deny changes nothing", denied.status === "denied" && (await tool("get_message", { message_id: lunch.id })).message.folder.specialUse.includes("inbox"));
  await sleep(21_000); // denial cooldown is a release safety rule
  const allowed = await tool("request_trash", request);
  const trashed = await tool("search_messages", { folder: "trash", account_id: pop.id });
  check("real click moves only approved messages to special-use Trash", allowed.batches?.[0]?.moved === 1 && trashed.messages.some(m => m.subject === lunch.subject));
  const moved = await tool("request_cleanup", { batches: [{ message_ids: [injected.id], action: "move", folder: "Review/Source", create_folder: true, reason: "Create reviewed destination" }] });
  check("approved move creates two-level user folder", moved.batches?.[0]?.moved === 1);
  const tree = await tool("list_folders_detailed", { account_id: pop.id });
  const source = tree.folders.find(f => f.path === "/Review/Source");
  const parent = tree.folders.find(f => f.path === "/Review");
  const created = await tool("request_folder_changes", { changes: [{ action: "create", folder: parent.id, new_name: "Target" }] });
  check("approved folder create works", created.changes?.[0]?.result === "done");
  const target = (await tool("list_folders_detailed", { account_id: pop.id })).folders.find(f => f.path === "/Review/Target");
  const merged = await tool("request_folder_changes", { changes: [{ action: "merge", folder: source.id, into: target.id }] });
  const mergedMessages = await tool("search_messages", { folder: target.id });
  check("approved merge moves messages and removes empty source recoverably", merged.changes?.[0]?.result === "done" && mergedMessages.messages.some(m => m.subject === injected.subject));
  const forbiddenMove = await tool("request_cleanup", { batches: [{ message_ids: [mergedMessages.messages[0].id], action: "move", folder: "Trash", reason: "Must refuse special destination" }] });
  check("move to special-use folder refused without approval", forbiddenMove.status === "refused" && forbiddenMove.code === "forbidden_folder");
  const inboxFolder = detailed.folders.find(f => f.specialUse.includes("inbox"));
  const renameRequest = { changes: [{ action: "rename", folder: inboxFolder.id, new_name: "Renamed" }] };
  const duringCooldown = await tool("request_folder_changes", renameRequest);
  check("refused request starts the denial cooldown", duringCooldown.status === "refused" && duringCooldown.code === "cooldown");
  await sleep(21_000);
  const forbiddenRename = await tool("request_folder_changes", renameRequest);
  check("special-use folder rename refused", forbiddenRename.status === "refused" && forbiddenRename.code === "forbidden_folder",
    JSON.stringify(forbiddenRename));

  // ---------------------------------------------------- forbidden attempts --
  const forbiddenTool = await mcp.callTool({ name: "send_message", arguments: { message_id: lunch.id } }).catch(e => ({ isError: true, content: [{ text: String(e) }] }));
  check("MCP: a send tool does not exist", forbiddenTool.isError === true);

  const { port, token } = JSON.parse(readFileSync(conn, "utf8"));
  const post = (route, body, headers = {}, method = "POST") =>
    fetch(`http://127.0.0.1:${port}/v1/${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }).then(async r => ({ status: r.status, body: await r.text() }));
  const probes = [
    ["messages.send", { messageId: lunch.id }, {}, "POST", 404],
    ["compose.sendMessage", { tabId: 1 }, {}, "POST", 404],
    ["messages.delete", { messageIds: [lunch.id] }, {}, "POST", 404],
    ["messages.move", { messageIds: [lunch.id], destination: "trash" }, {}, "POST", 404],
    ["messages.snooze", { messageId: lunch.id, preset: "tomorrow" }, {}, "POST", 404],
    ["drafts.create", { to: ["x@example.test"], body: "x", send: true }, {}, "POST", 400],
    ["drafts.create", { to: ["x@example.test"], body: "x", mode: "sendNow" }, {}, "POST", 400],
    ["health", {}, { Origin: "https://evil.example" }, "POST", 403],
    ["health", {}, { Authorization: "Bearer " + "A".repeat(43) }, "POST", 401],
    ["health", {}, {}, "GET", 405],
  ];
  for (const [route, body, headers, method, want] of probes) {
    const r = await post(route, body, headers, method).catch(e => ({ status: `network error: ${e.cause?.code || e.cause?.message || e.message}` }));
    check(`HTTP ${method} /v1/${route}${Object.keys(headers).length ? " " + Object.keys(headers).join(",") : ""}${body.send || body.mode ? " +send flag" : ""} is refused`, r.status === want, `got ${r.status}`);
  }
  const prepared = await tool("open_compose_for_review", {
    to: ["recipient@example.test"], subject: "Agent-prepared smoke message", body: "Review this message in Thunderbird."
  });
  check("agent-prepared email opens for review and reports sent:false", prepared.status === "awaiting_user_send" && prepared.sent === false);
  await sleep(1000);
  check("opening the composer made no SMTP connection", smtpConnections === 0, `${smtpConnections} connections`);
  const secondOpen = await mcp.callTool({ name: "open_compose_for_review", arguments: {
    to: ["recipient@example.test"], subject: "Duplicate", body: "Should be blocked."
  } });
  check("another agent composer is blocked while the first remains open", secondOpen.isError === true && /compose_busy/.test(secondOpen.content[0].text), secondOpen.content[0].text.slice(0, 180));
  // Only a real pointer click on Thunderbird's native Send button may reach
  // SMTP. This throwaway account points to the local rejecting trap.
  clickOnOurDisplay({ x: 42, y: 46 });
  const attemptedSend = await waitFor("the local SMTP trap", () => smtpConnections > 0, 15_000).catch(() => false);
  check("native Send click alone attempts SMTP to the local trap", attemptedSend && smtpConnections === 1, `${smtpConnections} connections`);
  // Dismiss Thunderbird's expected SMTP failure, then close the unsent
  // composer like a user. An agent cannot trigger this click through MCP.
  clickOnOurDisplay({ x: 712, y: 438 });
  await sleep(1000);
  clickOnOurDisplay({ x: 400, y: 250 });
  execFileSync("xte", ["keydown Control_L", "key w", "keyup Control_L"], { env: ourDisplayEnv() });
  await sleep(1000);
  const reopened = await mcp.callTool({ name: "open_compose_for_review", arguments: {
    to: ["recipient@example.test"], subject: "Second reviewed message", body: "Second window after closing the first."
  } });
  check("closing the first composer releases the one-window guard", reopened.isError !== true && unwrap(reopened).status === "awaiting_user_send", reopened.content[0].text.slice(0, 180));
  check("agent calls never attempt a second SMTP connection", smtpConnections === 1, `${smtpConnections} connections`);
  if (reopened.isError !== true) {
    clickOnOurDisplay({ x: 400, y: 250 });
    execFileSync("xte", ["keydown Control_L", "key w", "keyup Control_L"], { env: ourDisplayEnv() });
    await sleep(700);
  }
  const replyAccount = (await tool("list_accounts")).accounts.find(a => a.identities.length);
  const replyMessage = await waitFor("seeded reply source", async () => {
    const found = await tool("search_messages", { folder: "inbox", account_id: replyAccount.id });
    return found.messages.find(m => m.subject === "Quarterly report");
  }, 30_000);
  const reviewedReply = await tool("open_compose_for_review", {
    reply_to_message_id: replyMessage.id, body: "Thanks, I reviewed the report."
  });
  const replyWindows = execFileSync("xwininfo", ["-root", "-tree"], { encoding: "utf8", env: ourDisplayEnv() });
  check("threaded reply opens in Thunderbird for review", reviewedReply.status === "awaiting_user_send" && reviewedReply.sent === false &&
    /Write: Re: Quarterly report - Thunderbird/.test(replyWindows));
  check("opening the reply made no SMTP connection", smtpConnections === 1, `${smtpConnections} connections`);
  clickOnOurDisplay({ x: 400, y: 250 });
  execFileSync("xte", ["keydown Control_L", "key w", "keyup Control_L"], { env: ourDisplayEnv() });
  await sleep(700);
  // Replies ask whether to save an unsent draft when closed. Discard this
  // synthetic smoke message so shutdown is clean.
  clickOnOurDisplay({ x: 222, y: 433 });
  await sleep(700);
  const afterReplyClose = execFileSync("xwininfo", ["-root", "-tree"], { encoding: "utf8", env: ourDisplayEnv() });
  check("discarding the reply closes its composer", !/Write: Re: Quarterly report - Thunderbird/.test(afterReplyClose));
} catch (e) {
  check("smoke run completed", false, String(e && e.stack || e));
} finally {
  if (mcp) await mcp.close().catch(() => {});
  // Graceful quit of OUR instance only (by pid), so shutdown hooks run.
  // Quit like a user (Ctrl+Q on OUR Xvfb display) so extension shutdown
  // handlers run; Thunderbird does not handle SIGTERM gracefully.
  if (tbExit === null) {
    try {
      const xvfbLine = execFileSync("pgrep", ["-a", "-P", String(tb.pid), "Xvfb"], { encoding: "utf8" }).trim();
      const disp = /\s(:\d+)\s/.exec(xvfbLine)?.[1];
      const auth = /-auth\s+(\S+)/.exec(xvfbLine)?.[1];
      if (disp && disp !== process.env.DISPLAY) {
        // Approval popups occupy the center of the Xvfb screen. Click the
        // main-window corner so Ctrl+Q reaches Thunderbird's mail window.
        execFileSync("xte", ["mousemove 100 100", "mouseclick 1", "keydown Control_L", "key q", "keyup Control_L"], {
          env: { PATH: process.env.PATH, DISPLAY: disp, ...(auth ? { XAUTHORITY: auth } : {}) },
        });
        await waitFor("thunderbird to quit", () => tbExit !== null, 3_000).catch(() => {});
        if (tbExit === null) {
          // Thunderbird can ask for confirmation before quitting.
          execFileSync("xte", ["key Return"], {
            env: { PATH: process.env.PATH, DISPLAY: disp, ...(auth ? { XAUTHORITY: auth } : {}) },
          });
          await waitFor("thunderbird to quit", () => tbExit !== null, 27_000).catch(() => {});
        }
        if (tbExit === null) {
          console.log(execFileSync("xwininfo", ["-root", "-tree"], {
            encoding: "utf8",
            env: { PATH: process.env.PATH, DISPLAY: disp, ...(auth ? { XAUTHORITY: auth } : {}) },
          }).slice(0, 3000));
        }
      }
    } catch (e) {
      console.log(`graceful quit failed: ${e.message}`);
    }
  }
  if (tbExit === null) {
    for (const pid of ourThunderbirdPids()) process.kill(pid, "SIGTERM");
    await waitFor("thunderbird to exit", () => tbExit !== null, 30_000).catch(() => {
      for (const pid of ourThunderbirdPids()) process.kill(pid, "SIGKILL");
    });
  }
  await sleep(1000);
  check("connection file removed on shutdown (own record only)", !existsSync(CONN), `Thunderbird exit=${tbExit}`);
  trap.close();
  writeFileSync(logFile, log.join(""));
}

// ------------------------------------------------------- on-disk checks ---

function mboxes(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) mboxes(p, out);
    else if (!/\.(msf|dat|json)$/.test(e.name) && e.name !== "filterlog.html") out.push(p);
  }
  return out;
}
const files = mboxes(join(profile, "Mail"));
const read = name => files.filter(f => f.split("/").pop() === name).map(f => readFileSync(f, "latin1")).join("\n");
const draftsText = read("Drafts");
check("on disk: Drafts mbox holds both drafts", draftsText.includes("Smoke draft (new)") && /Subject: Re: Quarterly report/.test(draftsText));
check("on disk: the reply draft carries In-Reply-To <q1@smoke.test>", /In-Reply-To: <q1@smoke\.test>/i.test(draftsText));
check("on disk: no Sent mail and an empty Outbox", !read("Sent").includes("Subject:") && !read("Unsent Messages").includes("Subject:"),
  files.map(f => f.slice(profile.length + 1)).join(", "));

const ext = JSON.parse(readFileSync(join(profile, "extensions.json"), "utf8"));
const byId = Object.fromEntries(ext.addons.map(a => [a.id, a]));
const addon = byId[IDS.addon];
const addonPerms = addon?.userPermissions?.permissions ?? [];
check("Thunderbird installed and enabled the single add-on", addon?.active === true, `active=${addon?.active} appDisabled=${addon?.appDisabled}`);
check("combined permissions include Send later but exclude permanent delete",
  addonPerms.includes("compose.send") && !addonPerms.includes("messagesDelete"), addonPerms.join(","));
const tbLog = log.join("");
const addonErrors = tbLog.split("\n").filter(l => /draftsafe/i.test(l) && /error|failed|exception/i.test(l) && !/draftsafe-smoke/.test(l));
check("no Draftsafe errors in Thunderbird's console output", addonErrors.length === 0, addonErrors.slice(0, 3).join(" / "));
console.log("\n--- console lines mentioning draftsafe ---\n" + tbLog.split("\n").filter(l => /draftsafe/i.test(l)).slice(0, 20).join("\n"));

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Log: ${logFile}`);
writeFileSync(join(root, "dist", "smoke-report.json"), JSON.stringify({ when: new Date().toISOString(), addonPermissions: addonPerms, results }, null, 2));
if (!KEEP) {
  rmSync(profile, { recursive: true, force: true });
  console.log(`removed ${profile}`);
}
process.exit(failed.length ? 1 : 0);
