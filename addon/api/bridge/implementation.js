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
 *      connection file (fixed path, dir 0700, file 0600).
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
        if (!this.done) {
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
    var bytes = this.server.framing.buildResponse(status, bodyText);
    var source = dsCc["@mozilla.org/io/string-input-stream;1"].createInstance(dsCi.nsIStringInputStream);
    source.setByteStringData(bytes);
    try {
      NetUtil.asyncCopy(source, this.output, () => this.close());
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

async function dsRemoveConnectionFile() {
  try {
    await IOUtils.remove(PathUtils.join(connectionDir(), CONNECTION_FILE), { ignoreAbsent: true });
  } catch {
    // Best effort.
  }
}

// The experiment loader looks up this global by name (see manifest.json).
var draftsafeBridge = class extends dsExtensionCommon.ExtensionAPI {
  onShutdown(isAppShutdown) {
    if (dsServer) {
      dsServer.stop();
      dsServer = null;
    }
    // Fire and forget: the token is useless once the socket is closed, but
    // removing the file keeps clients from trying a dead port.
    dsRemoveConnectionFile();
  }

  getAPI(context) {
    var extension = context.extension;
    var getServer = () => {
      if (!dsServer) {
        var framing = {};
        Services.scriptloader.loadSubScript(extension.rootURI.resolve("api/bridge/framing.js"), framing);
        dsServer = new BridgeServer(framing);
      }
      return dsServer;
    };

    return {
      draftsafeBridge: {
        async start() {
          return { port: getServer().start() };
        },

        async stop() {
          if (dsServer) {
            dsServer.stop();
          }
          await dsRemoveConnectionFile();
        },

        async publishConnection(token) {
          if (typeof token !== "string" || !TOKEN_RE.test(token)) {
            throw new dsExtensionError("invalid token format");
          }
          var server = getServer();
          if (!server.port) {
            throw new dsExtensionError("bridge not started");
          }
          var dir = connectionDir();
          var isWindows = Services.appinfo.OS === "WINNT";
          await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
          if (!isWindows) {
            await IOUtils.setPermissions(dir, 0o700);
          }
          var target = PathUtils.join(dir, CONNECTION_FILE);
          var tmp = target + ".tmp";
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
          await IOUtils.writeUTF8(tmp, contents, { mode: "overwrite" });
          if (!isWindows) {
            await IOUtils.setPermissions(tmp, 0o600);
          }
          await IOUtils.move(tmp, target);
          return { path: target };
        },

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
