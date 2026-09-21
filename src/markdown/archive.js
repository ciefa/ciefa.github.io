import { Inflate, zipSync } from "fflate";
import * as L from "./limits.js";
import { check, fail, pathKey, validatePaths } from "./workspace.js";
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function readZip(data) {
  check(data.length <= L.MD_MAX_INPUT_BYTES, "MD_LIMIT");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const bound = (p, n) =>
    check(Number.isSafeInteger(p) && p >= 0 && p + n <= data.length, "MD_ZIP");
  const u16 = (p) => {
    bound(p, 2);
    return view.getUint16(p, true);
  };
  const u32 = (p) => {
    bound(p, 4);
    return view.getUint32(p, true);
  };
  let eocd = -1;
  for (let p = data.length - 22; p >= Math.max(0, data.length - 65557); p--)
    if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === data.length) {
      eocd = p;
      break;
    }
  check(eocd >= 0, "MD_ZIP");
  check(
    u16(eocd + 4) === 0 &&
      u16(eocd + 6) === 0 &&
      u16(eocd + 8) === u16(eocd + 10),
    "MD_ZIP",
  );
  const count = u16(eocd + 10),
    cdSize = u32(eocd + 12),
    cd = u32(eocd + 16);
  check(
    count !== 65535 &&
      cd !== 0xffffffff &&
      cdSize !== 0xffffffff &&
      cd + cdSize === eocd,
    "MD_ZIP",
  );
  check(count <= L.MD_MAX_ZIP_ENTRIES, "MD_LIMIT");
  const extra = (p, n) => {
    const end = p + n;
    bound(p, n);
    while (p < end) {
      check(p + 4 <= end, "MD_ZIP");
      const id = u16(p),
        len = u16(p + 2);
      check(id !== 1 && p + 4 + len <= end, "MD_ZIP");
      p += 4 + len;
    }
  };
  const decode = (p, n, flags) => {
    bound(p, n);
    const raw = data.subarray(p, p + n);
    if (!(flags & 2048))
      check(
        raw.every((b) => b < 128),
        "MD_ZIP",
      );
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        raw,
      );
    } catch {
      fail("MD_ZIP");
    }
  };
  let p = cd,
    total = 0;
  const records = [],
    names = new Set(),
    files = [];
  for (let i = 0; i < count; i++) {
    check(u32(p) === 0x02014b50, "MD_ZIP");
    bound(p, 46);
    const flags = u16(p + 8),
      method = u16(p + 10),
      crc = u32(p + 16),
      compressed = u32(p + 20),
      size = u32(p + 24),
      n = u16(p + 28),
      x = u16(p + 30),
      comment = u16(p + 32),
      offset = u32(p + 42);
    check(
      !(flags & ~(2048 | 8 | 6)) &&
        [0, 8].includes(method) &&
        (method === 8 || !(flags & 6)) &&
        u16(p + 34) === 0,
      "MD_ZIP",
    );
    check(
      size !== 0xffffffff && compressed !== 0xffffffff && offset !== 0xffffffff,
      "MD_ZIP",
    );
    const path = decode(p + 46, n, flags),
      directory = path.endsWith("/"),
      key = pathKey(path, directory);
    check(!names.has(key), "MD_PATH");
    names.add(key);
    const mode = u32(p + 38) >>> 16,
      type = mode & 0xf000;
    check(
      [0, 0x8000, 0x4000].includes(type) &&
        (type !== 0x4000 || directory) &&
        (type !== 0x8000 || !directory),
      "MD_ZIP",
    );
    check(!(u32(p + 38) & 16) || directory, "MD_ZIP");
    extra(p + 46 + n, x);
    bound(p, 46 + n + x + comment);
    check(p + 46 + n + x + comment <= eocd, "MD_ZIP");
    p += 46 + n + x + comment;
    check(size <= L.MD_MAX_SOURCE_BYTES, "MD_LIMIT");
    total += size;
    check(total <= L.MD_MAX_TOTAL_SOURCE_BYTES, "MD_LIMIT");
    if (directory) check(size === 0, "MD_ZIP");
    else {
      check(/\.(md|markdown)$/i.test(path), "MD_INPUT");
      files.push(path);
    }
    check(offset + 30 <= cd && u32(offset) === 0x04034b50, "MD_ZIP");
    const ln = u16(offset + 26),
      lx = u16(offset + 28),
      start = offset + 30 + ln + lx;
    check(
      u16(offset + 6) === flags &&
        u16(offset + 8) === method &&
        decode(offset + 30, ln, flags) === path &&
        ln === n,
      "MD_ZIP",
    );
    extra(offset + 30 + ln, lx);
    check(start + compressed <= cd, "MD_ZIP");
    for (const [at, expected] of [
      [14, crc],
      [18, compressed],
      [22, size],
    ])
      check(
        u32(offset + at) === expected || (flags & 8 && u32(offset + at) === 0),
        "MD_ZIP",
      );
    let end = start + compressed;
    if (flags & 8) {
      // A CRC may equal the descriptor signature: accept the matching layout.
      const match = (q) =>
        q + 12 <= cd &&
        u32(q) === crc &&
        u32(q + 4) === compressed &&
        u32(q + 8) === size;
      if (u32(end) === 0x08074b50 && match(end + 4)) end += 16;
      else {
        check(match(end), "MD_ZIP");
        end += 12;
      }
    }
    records.push({
      path,
      directory,
      offset,
      start,
      end,
      compressed,
      size,
      method,
      crc,
    });
  }
  check(p === eocd && files.length > 0, "MD_ZIP");
  check(files.length <= L.MD_MAX_DOCUMENTS, "MD_LIMIT");
  validatePaths(files);
  for (const file of files) {
    const k = pathKey(file);
    for (const name of names) check(!name.startsWith(k + "/"), "MD_PATH");
  }
  records.sort((a, b) => a.offset - b.offset);
  let end = 0;
  for (const r of records) {
    check(r.offset === end, "MD_ZIP");
    end = r.end;
  }
  check(end === cd, "MD_ZIP");
  const output = [];
  for (const r of records) {
    let decoded;
    if (r.method === 0) {
      check(r.compressed === r.size, "MD_ZIP");
      decoded = data.slice(r.start, r.start + r.compressed);
    } else {
      const chunks = [];
      let length = 0,
        finished = false;
      const stream = new Inflate((chunk, final) => {
        length += chunk.length;
        check(length <= r.size && length <= L.MD_MAX_SOURCE_BYTES, "MD_ZIP");
        chunks.push(chunk.slice());
        finished = final;
      });
      try {
        for (let i = 0; i < r.compressed; i += 1024)
          stream.push(
            data.subarray(
              r.start + i,
              r.start + Math.min(i + 1024, r.compressed),
            ),
            i + 1024 >= r.compressed,
          );
      } catch (e) {
        if (e.code === "MD_ZIP") throw e;
        fail("MD_ZIP");
      }
      // fflate 0.8.3 retains the partially consumed final byte in p and its
      // consumed-bit count in s.p. Require BFINAL and no trailing full bytes.
      check(
        finished &&
          stream.s.f === 1 &&
          stream.p.length === (stream.s.p ? 1 : 0) &&
          length === r.size,
        "MD_ZIP",
      );
      decoded = new Uint8Array(length);
      let at = 0;
      for (const c of chunks) {
        decoded.set(c, at);
        at += c.length;
      }
    }
    check(decoded.length === r.size && crc32(decoded) === r.crc, "MD_ZIP");
    if (!r.directory) output.push({ path: r.path, data: decoded });
  }
  return output;
}
export function writeZip(entries) {
  validatePaths(entries.map((e) => e.path));
  const files = Object.create(null);
  for (const e of entries) files[e.path] = e.data;
  return zipSync(files, { level: 6, mtime: new Date(1980, 0, 1, 0, 0, 0) });
}
