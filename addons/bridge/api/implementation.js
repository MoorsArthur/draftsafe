/* SPDX-License-Identifier: MIT */
/*
 * Draftsafe loopback bridge: the only privileged code in the add-on.
 *
 * WebExtensions cannot listen on sockets, so this Experiment API does exactly
 * four things and nothing else:
 *   1. start():  open a TCP server socket on 127.0.0.1 (loopback only) on a
 *                random free port;
 *   2. frame HTTP/1.1 requests with hard size and time caps (framing.js);
 *   3. hand each complete request to the background page via onRequest and
 *      write back whatever {status, body} the background page returns;
 *   4. publishConnection(token) / stop(): write or remove the per-user
 *      connection file (fixed path, dir 0700, file 0600). Only the record
 *      this instance wrote is ever removed.
 *
 * It does not parse JSON, check tokens, route requests or touch mail. All of
 * that runs in the unprivileged background page (src/bridge/server.js).
 */

"use strict";

/* exported draftsafeBridge */
/* global ExtensionCommon, ChromeUtils, Components, Services, IOUtils, PathUtils */

var { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
var { setTimeout: dsSetTimeout, clearTimeout: dsClearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);
var dsExtensionCommon =
  typeof ExtensionCommon !== "undefined"
    ? ExtensionCommon
    : ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs").ExtensionCommon;
var { ExtensionError: dsExtensionError } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionUtils.sys.mjs"
).ExtensionUtils;
var dsCc = Components.classes;
var dsCi = Components.interfaces;
var dsCr = Components.results;

var APP_DIR_NAME = "draftsafe-mcp";
var CONNECTION_FILE = "connection.json";
var TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * Directory for the connection file. Must match mcp/src/connection.ts.
 *   snap:     $SNAP_USER_COMMON/draftsafe-mcp        (~/snap/thunderbird/common/...)
 *   Linux:    ${XDG_STATE_HOME:-~/.local/state}/draftsafe-mcp
 *             (flatpak sets XDG_STATE_HOME to ~/.var/app/<id>/.local/state)
 *   macOS:    ~/Library/Application Support/draftsafe-mcp
 *   Windows:  %LOCALAPPDATA%\draftsafe-mcp
 * SNAP_USER_COMMON is checked first because the snap's HOME and XDG dirs can
 * point at a per-revision directory that changes on every snap refresh.
 */
function connectionDir() {
  var env = Services.env;
  var os = Services.appinfo.OS;
  var home = Services.dirsvc.get("Home", dsCi.nsIFile).path;
  if (os === "WINNT") {
    var local = env.get("LOCALAPPDATA") || PathUtils.join(home, "AppData", "Local");
    return PathUtils.join(local, APP_DIR_NAME);
  }
  if (os === "Darwin") {
    return PathUtils.join(home, "Library", "Application Support", APP_DIR_NAME);
  }
  var snapCommon = env.get("SNAP_USER_COMMON");
  if (snapCommon) {
    return PathUtils.join(snapCommon, APP_DIR_NAME);
  }
  var state = env.get("XDG_STATE_HOME");
  if (state && state.startsWith("/")) {
    return PathUtils.join(state, APP_DIR_NAME);
  }
  return PathUtils.join(home, ".local", "state", APP_DIR_NAME);
}

class BridgeConnection {
  constructor(server, transport) {
    this.server = server;
    this.transport = transport;
    this.buffer = "";
    this.done = false;
    this.closed = false;
    this.input = transport.openInputStream(0, 0, 0);
    this.output = transport.openOutputStream(0, 0, 0);
    this.timer = dsSetTimeout(
      () => this.reply(408, { code: "timeout", message: "request not received in time" }),
      server.limits.readTimeoutMs
    );
  }

  start() {
    var pump = dsCc["@mozilla.org/network/input-stream-pump;1"].createInstance(dsCi.nsIInputStreamPump);
    pump.init(this.input, 0, 0, true);
    pump.asyncRead({
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
      onStartRequest: () => {},
      onDataAvailable: (request, stream, offset, count) => this.onData(stream, count),
      onStopRequest: () => {
        // The client hung up. Before a response: abandon the request. After
        // the response was written: this is the normal end of a lingering
        // close (see replyRaw).
        this.inputEnded = true;
        if (!this.done || this.written) {
          this.close();
        }
      },
    });
  }

  onData(stream, count) {
    var bin = dsCc["@mozilla.org/binaryinputstream;1"].createInstance(dsCi.nsIBinaryInputStream);
    bin.setInputStream(stream);
    var chunk = bin.readBytes(count);
    if (this.done) {
      return;
    }
    var limits = this.server.limits;
    if (this.buffer.length + chunk.length > limits.maxHeaderBytes + limits.maxBodyBytes + 4) {
      this.reply(413, { code: "too_large", message: "request too large" });
      return;
    }
    this.buffer += chunk;
    var framed = this.server.framing.frameRequest(this.buffer, limits);
    if (framed.state === "incomplete") {
      return;
    }
    if (framed.state === "error") {
      this.reply(framed.status, { code: "bad_request", message: framed.reason });
      return;
    }
    this.done = true;
    this.buffer = "";
    dsClearTimeout(this.timer);
    this.timer = dsSetTimeout(
      () => this.reply(504, { code: "timeout", message: "handler timed out" }),
      limits.handlerTimeoutMs
    );
    this.server
      .dispatch({
        method: framed.method,
        target: framed.target,
        headers: framed.headers,
        body: framed.body,
        port: this.server.port,
      })
      .then(
        result => {
          if (!result || typeof result.status !== "number" || typeof result.body !== "string") {
            this.reply(500, { code: "internal", message: "invalid handler result" });
            return;
          }
          this.replyRaw(result.status, result.body);
        },
        () => this.reply(500, { code: "internal", message: "handler failed" })
      );
  }

  reply(status, error) {
    this.replyRaw(status, JSON.stringify({ ok: false, error }));
  }

  replyRaw(status, bodyText) {
    if (this.closed || this.responded) {
      return;
    }
    this.responded = true;
    this.done = true;
    dsClearTimeout(this.timer);
    var framing = this.server.framing;
    var limits = this.server.limits;
    var bytes = framing.buildResponse(status, bodyText);
    if (bytes.length > limits.maxResponseBytes + limits.maxHeaderBytes) {
      bytes = framing.buildResponse(
        500,
        JSON.stringify({ ok: false, error: { code: "result_too_large", message: "response too large" } })
      );
    }
    // Write deadline: a client that does not read the response loses the
    // connection instead of holding one of the few slots indefinitely.
    this.timer = dsSetTimeout(() => this.close(), limits.writeTimeoutMs);
    var source = dsCc["@mozilla.org/io/string-input-stream;1"].createInstance(dsCi.nsIStringInputStream);
    source.setByteStringData(bytes);
    try {
      NetUtil.asyncCopy(source, this.output, () => {
        // Lingering close: closing the socket while the client's side still
        // has bytes in flight makes the kernel send a RST, which can destroy
        // the response before the client reads it (seen with Node's fetch
        // under real Thunderbird). Keep reading until the client closes after
        // reading the response (it was told "Connection: close"), or at most
        // lingerMs.
        this.written = true;
        if (this.inputEnded) {
          this.close();
          return;
        }
        dsClearTimeout(this.timer);
        this.timer = dsSetTimeout(() => this.close(), limits.lingerMs);
      });
    } catch {
      this.close();
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    dsClearTimeout(this.timer);
    try {
      this.transport.close(dsCr.NS_OK);
    } catch {
      // Already closed.
    }
    this.server.connections.delete(this);
  }
}

class BridgeServer {
  constructor(framing) {
    this.framing = framing;
    this.limits = framing.LIMITS;
    this.socket = null;
    this.port = 0;
    this.connections = new Set();
    this.listeners = new Set();
  }

  start() {
    if (this.socket) {
      return this.port;
    }
    var socket = dsCc["@mozilla.org/network/server-socket;1"].createInstance(dsCi.nsIServerSocket);
    // port -1: pick a free port; loopbackOnly: true binds 127.0.0.1 only.
    socket.init(-1, true, 16);
    socket.asyncListen({
      QueryInterface: ChromeUtils.generateQI(["nsIServerSocketListener"]),
      onSocketAccepted: (serv, transport) => {
        if (this.connections.size >= this.limits.maxConnections) {
          try {
            transport.close(dsCr.NS_ERROR_ABORT);
          } catch {
            // ignore
          }
          return;
        }
        var conn = new BridgeConnection(this, transport);
        this.connections.add(conn);
        conn.start();
      },
      onStopListening: () => {},
    });
    this.socket = socket;
    this.port = socket.port;
    return this.port;
  }

  dispatch(request) {
    var fire = this.listeners.values().next().value;
    if (!fire) {
      return Promise.resolve({
        status: 503,
        body: JSON.stringify({ ok: false, error: { code: "not_ready", message: "add-on not ready" } }),
      });
    }
    // fire.async() resolves with the background listener's return value.
    return fire.async(request);
  }

  stop() {
    for (var conn of [...this.connections]) {
      conn.close();
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
    }
    this.socket = null;
    this.port = 0;
  }
}

var dsServer = null;
// The token this instance published. Several Thunderbird profiles share the
// connection path; an instance only ever removes the record it wrote itself.
var dsPublishedToken = null;

async function dsRemoveConnectionFile() {
  var token = dsPublishedToken;
  dsPublishedToken = null;
  if (!token) {
    return;
  }
  try {
    var target = PathUtils.join(connectionDir(), CONNECTION_FILE);
    var current = JSON.parse(await IOUtils.readUTF8(target));
    if (current && current.token === token) {
      await IOUtils.remove(target, { ignoreAbsent: true });
    }
  } catch {
    // Absent, unreadable or replaced by another instance: leave it alone.
  }
}

function dsRemoveConnectionFileSync() {
  var token = dsPublishedToken;
  dsPublishedToken = null;
  if (!token) {
    return;
  }
  try {
    var file = dsCc["@mozilla.org/file/local;1"].createInstance(dsCi.nsIFile);
    file.initWithPath(PathUtils.join(connectionDir(), CONNECTION_FILE));
    if (!file.exists() || file.isSymlink()) {
      return;
    }
    var stream = dsCc["@mozilla.org/network/file-input-stream;1"].createInstance(dsCi.nsIFileInputStream);
    stream.init(file, -1, 0, 0);
    var text;
    try {
      text = NetUtil.readInputStreamToString(stream, Math.min(stream.available(), 4096), { charset: "UTF-8" });
    } finally {
      stream.close();
    }
    var current = JSON.parse(text);
    if (current && current.token === token) {
      file.remove(false);
    }
  } catch {
    // Absent, unreadable or replaced by another instance: leave it alone.
  }
}

function dsRandomName() {
  // A random v4 UUID; only used to make the temporary file name unpredictable.
  return Services.uuid.generateUUID().toString().replace(/[{}-]/g, "");
}

function dsIsSymlink(path) {
  try {
    var file = dsCc["@mozilla.org/file/local;1"].createInstance(dsCi.nsIFile);
    file.initWithPath(path);
    return file.exists() && file.isSymlink();
  } catch {
    return true; // Cannot tell: treat as unsafe.
  }
}

// loadSubScript() refuses the add-on's own jar:file: URI ("untrusted URI"),
// so framing.js is loaded through a resource:// alias that exists only for
// the duration of this synchronous call.
var RESOURCE_HOST = "draftsafe-bridge";
function dsLoadFraming(extension) {
  var res = Services.io.getProtocolHandler("resource").QueryInterface(dsCi.nsISubstitutingProtocolHandler);
  res.setSubstitution(RESOURCE_HOST, extension.rootURI);
  try {
    var framing = {};
    Services.scriptloader.loadSubScript("resource://" + RESOURCE_HOST + "/bridge/api/framing.js", framing);
    return framing;
  } finally {
    res.setSubstitution(RESOURCE_HOST, null);
  }
}

// Thunderbird replaces any non-ExtensionError thrown by an Experiment with
// "An unexpected error occurred". Keep the real reason; it only reaches the
// background page, which never forwards internal errors to HTTP clients.
async function dsExplain(step, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof dsExtensionError) {
      throw e;
    }
    throw new dsExtensionError(step + ": " + ((e && e.message) || String(e)));
  }
}

// The experiment loader looks up this global by name (see manifest.json).
var draftsafeBridge = class extends dsExtensionCommon.ExtensionAPI {
  onShutdown(isAppShutdown) {
    if (dsServer) {
      dsServer.stop();
      dsServer = null;
    }
    // Synchronous: on app shutdown an async IOUtils call may never complete,
    // which would leave a stale record pointing at a dead port.
    dsRemoveConnectionFileSync();
  }

  getAPI(context) {
    var extension = context.extension;
    var getServer = () => {
      if (!dsServer) {
        dsServer = new BridgeServer(dsLoadFraming(extension));
      }
      return dsServer;
    };

    return {
      draftsafeBridge: {
        async start() {
          return dsExplain("start", () => ({ port: getServer().start() }));
        },

        async stop() {
          if (dsServer) {
            dsServer.stop();
          }
          await dsRemoveConnectionFile();
        },

        publishConnection: token => dsExplain("publishConnection", async () => {
          if (typeof token !== "string" || !TOKEN_RE.test(token)) {
            throw new dsExtensionError("invalid token format");
          }
          var server = getServer();
          if (!server.port) {
            throw new dsExtensionError("bridge not started");
          }
          var dir = connectionDir();
          var isWindows = Services.appinfo.OS === "WINNT";
          if (dsIsSymlink(dir)) {
            throw new dsExtensionError("connection directory is a symlink; refusing to use it");
          }
          await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
          var info = await IOUtils.stat(dir);
          if (info.type !== "directory") {
            throw new dsExtensionError("connection path is not a directory");
          }
          if (!isWindows) {
            await IOUtils.setPermissions(dir, 0o700);
          }
          var target = PathUtils.join(dir, CONNECTION_FILE);
          if (dsIsSymlink(target)) {
            throw new dsExtensionError("connection file is a symlink; refusing to replace it");
          }
          // Unpredictable temporary name, created exclusively (fails if it
          // exists), then renamed over the target.
          var tmp = PathUtils.join(dir, "." + CONNECTION_FILE + "." + dsRandomName() + ".tmp");
          var contents = JSON.stringify({
            version: 1,
            port: server.port,
            token,
            addonId: extension.id,
            addonVersion: extension.version,
            createdAt: new Date().toISOString(),
          });
          // The directory is already 0700, so the brief window before the
          // chmod below does not expose the token to other users.
          await IOUtils.writeUTF8(tmp, contents, { mode: "create" });
          try {
            if (!isWindows) {
              await IOUtils.setPermissions(tmp, 0o600);
            }
            await IOUtils.move(tmp, target);
          } catch (e) {
            await IOUtils.remove(tmp, { ignoreAbsent: true }).catch(() => {});
            throw e;
          }
          dsPublishedToken = token;
          return { path: target };
        }),

        onRequest: new dsExtensionCommon.EventManager({
          context,
          name: "draftsafeBridge.onRequest",
          register: fire => {
            var server = getServer();
            server.listeners.add(fire);
            return () => server.listeners.delete(fire);
          },
        }).api(),
      },
    };
  }
};
