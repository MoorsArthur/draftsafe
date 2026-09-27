#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Packs addon/ into dist/draftsafe-mcp.xpi (a plain ZIP). No dependencies,
// deterministic output (sorted entries, fixed timestamps).

import { deflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const addonDir = join(root, "addon");
const out = join(root, "dist", "draftsafe-mcp.xpi");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(addonDir, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`manifest version ${manifest.version} != package.json version ${pkg.version}`);
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir)
    .flatMap(name => {
      const full = join(dir, name);
      if (name.startsWith(".")) return [];
      return statSync(full).isDirectory() ? walk(full) : [full];
    })
    .sort();
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

const locals = [];
const centrals = [];
let offset = 0;
for (const file of walk(addonDir)) {
  const name = Buffer.from(relative(addonDir, file).split(sep).join("/"), "utf8");
  const data = readFileSync(file);
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
end.writeUInt16LE(centrals.length / 2, 8);
end.writeUInt16LE(centrals.length / 2, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([...locals, ...centrals, end]));
console.log(`wrote ${relative(root, out)} (${centrals.length / 2} files)`);
