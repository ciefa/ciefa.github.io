const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const uuid = (n) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc(b) {
  let n = 0xffffffff;
  for (const byte of b) n = crcTable[(n ^ byte) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name),
    length = Buffer.alloc(4),
    sum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, sum]);
}
function png(width = 8, height = 6, seed = 1, padding = 0) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let n = seed >>> 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width * 4; x++) {
      n ^= n << 13;
      n ^= n >>> 17;
      n ^= n << 5;
      raw[y * (width * 4 + 1) + 1 + x] = x % 4 === 3 ? 255 : n & 255;
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(padding ? [chunk('tEXt', Buffer.alloc(padding, 65))] : []),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const font = () => fs.readFileSync(path.join(__dirname, '../assets/FiraSans-Regular.woff2'));
function asset(data, mime = 'image/png', compressed = true) {
  return {
    mime,
    compressed,
    data: (compressed ? zlib.gzipSync(data, { mtime: 0 }) : data).toString('base64'),
  };
}
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12" viewBox="0 0 16 12"><defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect id="shape" width="16" height="12" fill="url(#g)"/></svg>';
const json = (x) => JSON.stringify(x).replace(/</g, '\\u003c');
function bundle(template, manifest = {}, extra = {}) {
  return (
    '<!doctype html><meta charset="utf-8"><title>Synthetic bundle</title><div id="loading">Synthetic loader</div><script>window.sourceRan=true</script><script type="__bundler/manifest">' +
    json(manifest) +
    '</script><script type="__bundler/template">' +
    json(template) +
    '</script>' +
    Object.entries(extra)
      .map(([k, v]) => `<script type="__bundler/${k}">${json(v)}</script>`)
      .join('')
  );
}
function parts({ compressed = true, fontFace = true } = {}) {
  const manifest = {
    [uuid(1)]: asset(png(), 'image/png', compressed),
    [uuid(2)]: asset(Buffer.from(svg), 'image/svg+xml', compressed),
    [uuid(4)]: { mime: 'text/javascript', data: 'intentionally not base64', compressed: true },
  };
  if (fontFace) manifest[uuid(3)] = asset(font(), 'font/woff2', compressed);
  const styles = `${fontFace ? `@font-face{font-family:FixtureFira;src:url("${uuid(3)}") format('woff2')}` : ''}body{font:16px/1.6 ${fontFace ? 'FixtureFira,' : ''}sans-serif;color:#203040}p{margin:16px 0}h1{font-size:28px}img{display:block}table{border-collapse:collapse}td,th{border:1px solid #333;padding:8px}doc-page:not(:defined){visibility:hidden}`;
  const content =
    '<h1 id="top">Synthetic handbook</h1><p id="p0">Alpha passage for annotation and replacement.</p><p id="rich">Choose <b>bold words</b> and <i>italic words</i> to review.</p><p id="repeat">Repeated sentence. Repeated sentence.</p><p id="p1">First adjacent paragraph for a broad comment.</p><p id="p2">Second adjacent paragraph for a broad comment.</p><p id="unicode" lang="de">Grüße 👩‍💻 é — العربية</p><pre><code>{{literal example}}</code></pre><ol start="4"><li>Fourth step</li><li>Fifth step</li></ol>' +
    `<figure><img id="image" src="${uuid(1)}" width="80" height="60" alt="Synthetic pixels"><figcaption>Synthetic caption</figcaption></figure><img id="vector" src="${uuid(2)}#shape" alt="Synthetic vector">` +
    '<sc-raw-table id="table"><sc-raw-caption>Sample table</sc-raw-caption><sc-raw-thead><sc-raw-tr><sc-raw-th>Label</sc-raw-th><sc-raw-th>Value</sc-raw-th></sc-raw-tr></sc-raw-thead><sc-raw-tbody><sc-raw-tr><sc-raw-td id="cell">Cell passage to revise.</sc-raw-td><sc-raw-td id="cell2">Another cell.</sc-raw-td></sc-raw-tr></sc-raw-tbody><sc-raw-tfoot><sc-raw-tr><sc-raw-td>Total</sc-raw-td><sc-raw-td>Two</sc-raw-td></sc-raw-tr></sc-raw-tfoot></sc-raw-table><a href="#end" id="jump">Go to end</a><a href="https://example.invalid/destination" id="external">External destination</a><h2 id="end">End marker</h2>';
  const template = `<!doctype html><html lang="en"><head><title>Synthetic document</title><script src="${uuid(4)}"></script></head><body><x-dc><helmet><style>${styles}</style></helmet><doc-page size="a4" margin="0.5in"><footer slot="footer">Synthetic footer</footer>${content}<header slot="header">Synthetic header</header></doc-page></x-dc></body></html>`;
  return { template, manifest };
}
function documentBundle(options) {
  const p = parts(options);
  return bundle(p.template, p.manifest, {
    page_order: [],
    ext_resources: [{ id: 'https://example.invalid/runtime.js', uuid: uuid(4) }],
  });
}
const plain = () =>
  `<!doctype html><meta charset="utf-8"><title>Plain fixture</title><style>body{font:18px/1.8 sans-serif;padding:20px}p{margin:20px 0}</style><h1>Static example</h1><p id="p0">Alpha passage for annotation and replacement.</p><p id="rich">Choose <b>bold words</b> and <i>italic words</i> to review.</p><p id="repeat">Repeated sentence. Repeated sentence.</p><p id="p1">First adjacent paragraph for a broad comment.</p><p id="p2">Second adjacent paragraph for a broad comment.</p><p id="unicode">Grüße 👩‍💻 é — العربية</p><table><tr><td id="cell">Cell passage to revise.</td><td id="cell2">Another cell.</td></tr></table><img src="data:image/png;base64,${png().toString('base64')}" alt="Pixels"><a href="#end">End</a><h2 id="end">End marker</h2>`;
function large() {
  const manifest = {},
    images = [];
  for (let i = 0; i < 320; i++) {
    manifest[uuid(i + 1)] = asset(png(128, 96, i + 1));
    images.push(
      `<figure><img src="${uuid(i + 1)}" alt="Image ${i}"><figcaption>Caption ${i}</figcaption></figure>`,
    );
  }
  manifest[uuid(500)] = asset(font(), 'font/woff2');
  const headings = Array.from({ length: 250 }, (_, i) => `<h2 id="h${i}">Heading ${i}</h2>`).join(
    '',
  );
  const paragraphs = Array.from(
    { length: 400 },
    (_, i) => `<p id="p${i}">Synthetic paragraph ${i} with enough text for a review.</p>`,
  ).join('');
  return bundle(
    `<style>@font-face{font-family:FixtureFira;src:url(${uuid(500)})}body{font:16px FixtureFira}p{min-height:180px}</style><doc-page size="a4">${headings}${paragraphs}${images.join('')}<table><tr>${Array.from({ length: 20 }, (_, i) => `<td>Cell ${i}</td>`).join('')}</tr></table></doc-page>`,
    manifest,
  );
}
module.exports = { uuid, asset, png, svg, font, bundle, parts, documentBundle, plain, large };
