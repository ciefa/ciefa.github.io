const f = require("./bundle-fixtures.cjs");
const h = require("./reviewer.cjs");
const json = (x) =>
  JSON.stringify(x)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
function simple(body = '<p id="p0">Alpha word Omega</p>', options = {}) {
  const template =
    "<!doctype html><html><head><title>Unit fixture</title></head><body>" +
    body +
    "</body></html>";
  let source = f
    .bundle(template)
    .replace(
      '<meta charset="utf-8">',
      options.noCharset ? "" : '<meta charset="utf-8">',
    );
  if (options.crlf)
    source =
      "\r\n" +
      source
        .replace(/<script/g, "\r\n<ScRiPt")
        .replace(/<\/script>/g, "</ScRiPt>") +
      "\r\n  ";
  return (options.bom ? "\ufeff" : "") + source;
}
function payload(html) {
  const match = html
    .toString()
    .match(
      /<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/,
    );
  if (!match) throw Error("No review payload");
  return JSON.parse(match[1]);
}
function withPayload(html, value) {
  return html
    .toString()
    .replace(
      /(<script id="review-data" type="application\/json">)[\s\S]*?(<\/script>)/,
      (_, a, b) => a + json(value) + b,
    );
}
async function worker(page, op, payload, workerText = null) {
  return page.evaluate(
    async ({ op, payload, workerText }) => {
      if (payload.text !== undefined) {
        payload.buffer = new TextEncoder().encode(payload.text).buffer;
        delete payload.text;
      }
      const url = URL.createObjectURL(
          new Blob(
            [
              workerText ||
                JSON.parse(
                  document.querySelector("#roundtrip-worker").textContent,
                ),
            ],
            { type: "text/javascript" },
          ),
        ),
        w = new Worker(url);
      try {
        return await new Promise((resolve, reject) => {
          w.onerror = (e) => {
            e.preventDefault();
            reject(Error("Worker failed"));
          };
          w.onmessage = async ({ data }) => {
            if (data.type === "ready") {
              URL.revokeObjectURL(url);
              w.postMessage({ requestId: 1, generation: 1, op, payload });
            } else {
              if (op === "exportOriginal" && data.ok) {
                data.result.bytes = Array.from(
                  new Uint8Array(data.result.buffer || payload.buffer),
                );
                delete data.result.buffer;
              }
              resolve(data);
            }
          };
        });
      } finally {
        w.terminate();
        URL.revokeObjectURL(url);
      }
    },
    { op, payload, workerText },
  );
}
async function modelFixture(page, source = simple()) {
  const result = await worker(page, "analyzeSource", { text: source });
  h.expect(result.ok, JSON.stringify(result)).toBe(true);
  return page.evaluate(
    async ({ result }) => {
      const info = result.result,
        converted = await bundleImporter.convert(info.descriptor, {
          signal: new AbortController().signal,
          projection: info,
        });
      const doc = new DOMParser().parseFromString(converted.html, "text/html"),
        base = roundTripDom.base(doc, info.units);
      const model = {
        format: "local-html-reviewer-v2",
        originalName: "synthetic.html",
        source: info.source,
        baseHtml: base.baseHtml,
        units: info.units.map(({ id, start, end, original }) => ({
          id,
          start,
          end,
          original,
          runs: [{ kind: "text", text: original }],
        })),
        comments: [],
        view: { previewOpen: false, scrollTogether: true },
      };
      const context = { unitOrder: base.unitOrder, sourceUnits: info.units };
      return { model: roundTripModel.validate(model, context), context };
    },
    { result },
  );
}
async function eligible(page, source = simple(), name = "synthetic.html") {
  await h.importHtml(page, source, name);
  await h
    .expect(page.locator("#original-format-status"))
    .toHaveText("Original-format export available");
}
async function originalDialog(page) {
  if (
    !(await page.locator("#original-export-dialog").evaluate((n) => n.open))
  ) {
    await page.locator("#export-menu-button").click();
    await page.locator("#original-export-button").click();
  }
}
async function originalDownload(page) {
  await originalDialog(page);
  return h.download(page, "#original-download-button");
}
async function attach(page, source, name = "renamed.html") {
  await originalDialog(page);
  await page
    .locator("#original-source-input")
    .setInputFiles({
      name,
      mimeType: "text/html",
      buffer: Buffer.from(source),
    });
  await h.expect(page.locator("#original-download-button")).toBeEnabled();
}
function templateOf(source) {
  const match = source
    .toString()
    .match(
      /<script\b[^>]*type="__bundler\/template"[^>]*>([\s\S]*?)<\/script>/i,
    );
  if (!match) throw Error("Missing template");
  return JSON.parse(match[1]);
}
function runtimeBundle() {
  const { template, manifest } = f.parts();
  const html = template.replace(
    '<h1 id="top">',
    '<button id="runtime-button">Run action</button><output id="runtime-output"></output><h1 id="top">',
  );
  const runtime = `(async()=>{const template=JSON.parse(document.querySelector('script[type="__bundler/template"]').textContent),manifest=JSON.parse(document.querySelector('script[type="__bundler/manifest"]').textContent),doc=new DOMParser().parseFromString(template,'text/html');for(const script of doc.querySelectorAll('script'))script.remove();for(const [id,a]of Object.entries(manifest)){if(!a.mime.startsWith('image/')&&!a.mime.startsWith('font/'))continue;let bytes=Uint8Array.from(atob(a.data),c=>c.charCodeAt(0)),blob=new Blob([bytes]);if(a.compressed)blob=await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();a.url=await new Promise(r=>{const reader=new FileReader();reader.onload=()=>r(reader.result);reader.readAsDataURL(new Blob([blob],{type:a.mime}));});}for(const img of doc.querySelectorAll('img')){const [id,fragment]=img.getAttribute('src').split('#');img.src=manifest[id].url+(fragment?'#'+fragment:'');}for(const style of doc.querySelectorAll('style'))for(const [id,a]of Object.entries(manifest))if(a.url)style.textContent=style.textContent.split(id).join(a.url);for(const helmet of doc.querySelectorAll('helmet')){doc.head.append(...helmet.childNodes);helmet.remove();}for(const n of [...doc.querySelectorAll('*')])if(n.localName.startsWith('sc-raw-')){const el=doc.createElement(n.localName.slice(7));for(const a of n.attributes)el.setAttribute(a.name,a.value);el.append(...n.childNodes);n.replaceWith(el);}const page=doc.querySelector('doc-page');page.prepend(page.querySelector('[slot="header"]'));page.append(page.querySelector('[slot="footer"]'));document.head.append(...doc.head.childNodes);document.body.replaceChildren(...doc.body.childNodes);customElements.define('doc-page',class extends HTMLElement{connectedCallback(){this.style.display='block';this.dataset.ready='yes';}});document.querySelector('#runtime-button').onclick=()=>document.querySelector('#runtime-output').textContent='Action completed';window.syntheticReady=true;})()`;
  return f.bundle(html, manifest) + "<script>" + runtime + "</script>";
}
module.exports = {
  ...h,
  ...f,
  simple,
  payload,
  withPayload,
  worker,
  modelFixture,
  eligible,
  originalDialog,
  originalDownload,
  attach,
  templateOf,
  runtimeBundle,
};
