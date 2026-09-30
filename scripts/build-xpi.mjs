#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Packs the single Draftsafe add-on into dist/draftsafe.xpi (plain ZIP).
// No dependencies, deterministic output (sorted entries, fixed timestamps).
//
// Layout: addons/app/manifest.json becomes the XPI's manifest.json. The
// background import closure plus HTML, icon and Experiment assets are packed
// under their source directories. The obsolete external receiver is omitted.

import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const addonsDir = join(root, "addons");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function walk(dir) {
  return readdirSync(dir)
    .flatMap(name => {
      const full = join(dir, name);
      if (name.startsWith(".")) return [];
      return statSync(full).isDirectory() ? walk(full) : [full];
    })
    .sort();
}

const IMPORT_RE = /(?:import|export)\s[^"'`;]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

/** Relative import targets of a JS module. */
export function importsOf(file) {
  const src = readFileSync(file, "utf8");
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec.startsWith(".")) {
      throw new Error(`${relative(root, file)}: non-relative import "${spec}" is not allowed in an add-on`);
    }
    out.push(resolve(dirname(file), spec));
  }
  return out;
}

/** Every file that goes into the add-on's XPI, as [absolute path, zip path]. */
export function addonEntries(name) {
  const own = join(addonsDir, name);
  const entries = new Map();
  const add = (abs, zipPath) => entries.set(zipPath, abs);
  for (const file of walk(own)) {
    const rel = relative(own, file).split(sep).join("/");
    add(file, rel === "manifest.json" ? "manifest.json" : `${name}/${rel}`);
  }
  if (name === "app") {
    for (const dir of ["bridge/api", "tools/src/ui", "tools/icons"]) {
      for (const file of walk(join(addonsDir, dir))) {
        const rel = relative(addonsDir, file).split(sep).join("/");
        add(file, rel);
      }
    }
  }
  // Imported modules are packed recursively; HTML-referenced scripts above
  // seed the queue as well as the app background module.
  const queue = [...entries.values()].filter(f => f.endsWith(".js"));
  const seen = new Set(queue);
  while (queue.length) {
    for (const target of importsOf(queue.shift())) {
      const rel = relative(addonsDir, target).split(sep).join("/");
      const allowed = name === "app" ? ["app/", "bridge/", "tools/", "shared/"] : [`${name}/`, "shared/"];
      if (!allowed.some(prefix => rel.startsWith(prefix))) {
        throw new Error(`${name}: import of ${rel} leaves the add-on source tree`);
      }
      if (!existsSync(target)) {
        throw new Error(`${name}: missing import ${rel}`);
      }
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
        add(target, rel);
      }
    }
  }
  return [...entries.entries()].map(([zipPath, abs]) => [abs, zipPath]).sort((a, b) => (a[1] < b[1] ? -1 : 1));
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [abs, zipPath] of files) {
    const name = Buffer.from(zipPath, "utf8");
    const data = readFileSync(abs);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function buildXpis() {
  mkdirSync(join(root, "dist"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(addonsDir, "app", "manifest.json"), "utf8"));
  if (manifest.version !== pkg.version) {
    throw new Error(`app manifest version ${manifest.version} != package.json version ${pkg.version}`);
  }
  const files = addonEntries("app");
  const out = join(root, "dist", "draftsafe.xpi");
  writeFileSync(out, zip(files));
  for (const old of ["draftsafe-mcp.xpi", "draftsafe-bridge.xpi", "draftsafe-tools.xpi"]) {
    rmSync(join(root, "dist", old), { force: true });
  }
  console.log(`wrote ${relative(root, out)} (${files.length} files)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildXpis();
}
