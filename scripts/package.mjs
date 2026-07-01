// Rebuilds the install/ folder from the built plugin files and packs it into
// docs/inkless-highlighter.zip, so the download on the site never drifts from
// the source. Run after a build:  npm run package
//
// The zip is written with a tiny dependency-free ZIP encoder (deflate via the
// built-in zlib), so this works the same on every platform.

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const isDir = file.name.endsWith("/");
    const crc = crc32(file.data);
    const deflated = isDir || file.data.length === 0 ? Buffer.alloc(0) : deflateRawSync(file.data);
    const method = deflated.length && !isDir ? 8 : 0;
    const stored = method === 8 ? deflated : file.data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    parts.push(local, nameBuf, stored);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12); // time
    cd.writeUInt16LE(0x21, 14); // date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(stored.length, 20);
    cd.writeUInt32LE(file.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(isDir ? 0x10 : 0, 38); // external attrs (dir flag)
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + stored.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, cdBuf, end]);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const installDir = join(root, "install");

// Copy the built plugin files into install/. data.json is a curated seed and is
// left as-is.
const copied = ["manifest.json", "main.js", "styles.css", "README.md", "LICENSE"];
for (const name of copied) copyFileSync(join(root, name), join(installDir, name));

// Files that go into the distributable folder, laid out as inkless-highlighter/*.
const bundled = ["manifest.json", "main.js", "styles.css", "data.json", "README.md", "LICENSE"];

const entries = [{ name: "inkless-highlighter/", data: Buffer.alloc(0) }];
for (const name of bundled) {
  entries.push({ name: `inkless-highlighter/${name}`, data: readFileSync(join(installDir, name)) });
}

writeFileSync(join(root, "docs", "inkless-highlighter.zip"), makeZip(entries));
console.log(`Packaged ${bundled.length} files into docs/inkless-highlighter.zip`);
