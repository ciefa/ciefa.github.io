const reviewer = require("./reviewer.cjs");
const { buildSync } = require("esbuild");
const Module = require("node:module");
const path = require("node:path");
const { deflateRawSync } = require("node:zlib");
function moduleOf(file) {
  const filename = path.join(reviewer.root, file),
    m = new Module(filename, module);
  m.filename = filename;
  m.paths = module.paths;
  m._compile(
    buildSync({
      entryPoints: [filename],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
    }).outputFiles[0].text,
    filename,
  );
  return m.exports;
}
const ws = moduleOf("src/markdown/workspace.js"),
  archives = moduleOf("src/markdown/archive.js"),
  model = moduleOf("src/roundtrip/model.js");
function zip(entries, options = {}) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path),
      raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.text || ""),
      method = e.method ?? 8,
      flags = e.flags ?? 2048 | (e.descriptor ? 8 : 0);
    const data = Buffer.concat([
        method === 0 ? raw : deflateRawSync(raw),
        e.trailing || Buffer.alloc(0),
      ]),
      crc = archives.crc32(raw),
      size = e.size ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!e.descriptor) {
      local.writeUInt32LE(e.crc ?? crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(name.length, 26);
    let desc = Buffer.alloc(0);
    if (e.descriptor) {
      const sig = e.descriptor === "signed";
      desc = Buffer.alloc(sig ? 16 : 12);
      if (sig) desc.writeUInt32LE(0x08074b50);
      const p = sig ? 4 : 0;
      desc.writeUInt32LE(e.crc ?? crc, p);
      desc.writeUInt32LE(data.length, p + 4);
      desc.writeUInt32LE(size, p + 8);
    }
    const record = Buffer.concat([local, name, data, desc]);
    locals.push(record);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(3 * 256 + 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(e.crc ?? crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(e.attrs ?? 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += record.length;
  }
  const cd = Buffer.concat(central),
    comment = Buffer.from(options.comment || ""),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, end, comment]);
}
async function openMarkdown(
  page,
  files = [{ name: "alpha.md", text: "# Example\n\nAlpha beta.\n" }],
) {
  await page
    .locator("#file-input")
    .setInputFiles(
      files.map((f) => ({
        name: f.name,
        mimeType: f.name.endsWith(".zip") ? "application/zip" : "text/markdown",
        buffer: f.buffer || Buffer.from(f.text || ""),
      })),
    );
  await reviewer.expect(page.locator("#markdown-panel")).toBeVisible();
  await reviewer.expect(page.locator("#import-status")).toBeHidden();
  await reviewer.expect(page.locator("#save-button")).toBeEnabled();
}
async function mdDownload(page, selector = "#markdown-zip-button") {
  if (
    selector !== "#save-button" &&
    (await page.locator("#export-menu").isHidden())
  )
    await page.locator("#export-menu-button").click();
  return reviewer.download(page, selector);
}
const payload = (buffer) =>
  JSON.parse(
    buffer
      .toString()
      .match(
        /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/,
      )[1],
  );
const withPayload = (buffer, value) =>
  Buffer.from(
    buffer
      .toString()
      .replace(
        /(<script id="review-data" type="application\/json">)[\s\S]*?(<\/script>)/,
        (_, a, b) => a + JSON.stringify(value).replace(/</g, "\\u003c") + b,
      ),
  );
module.exports = {
  ...reviewer,
  moduleOf,
  ws,
  archives,
  model,
  zip,
  openMarkdown,
  mdDownload,
  payload,
  withPayload,
};
