import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
// Bounded synthetic research probe; this is not a production exporter.
const repo = fileURLToPath(new URL("../../", import.meta.url));
if (!process.env.RESEARCH_DEPS_DIR)
  throw new Error(
    "Set RESEARCH_DEPS_DIR as documented in the research report.",
  );
const dependencyDir = path.resolve(process.env.RESEARCH_DEPS_DIR);
const researchRequire = createRequire(path.join(dependencyDir, "package.json"));
const { parse, parseFragment } = await import(
  pathToFileURL(researchRequire.resolve("parse5")).href
);
const { build } = researchRequire("esbuild");
const versions = Object.fromEntries(
  ["parse5", "entities", "esbuild"].map((name) => [
    name,
    JSON.parse(
      fs.readFileSync(
        path.join(dependencyDir, "node_modules", name, "package.json"),
        "utf8",
      ),
    ).version,
  ]),
);
assert.deepEqual(
  versions,
  { parse5: "8.0.0", entities: "6.0.1", esbuild: "0.28.2" },
  "Use the dependency versions specified in the report.",
);
const require = createRequire(path.join(repo, "package.json"));
const { chromium, firefox } = require("@playwright/test");
const helpers = require(path.join(repo, "tests/helpers/reviewer.cjs"));
const fixtures = require(path.join(repo, "tests/helpers/bundle-fixtures.cjs"));
const root =
  fs.mkdtempSync(path.join(os.tmpdir(), "html-reviewer-roundtrip-")) + path.sep;
const report = { checks: [], engines: [], warnings: [] };
function pass(name, details = {}) {
  report.checks.push({ name, ...details });
}
function all(rootNode) {
  return [rootNode, ...(rootNode.childNodes || []).flatMap(all)];
}
function byId(tree, id) {
  return all(tree).find((n) =>
    n.attrs?.some((a) => a.name === "id" && a.value === id),
  );
}
function ast(html, scriptingEnabled = false) {
  return parse(html, { sourceCodeLocationInfo: true, scriptingEnabled });
}
function textNodes(node) {
  return all(node).filter((n) => n.nodeName === "#text");
}
function textOf(node) {
  return textNodes(node)
    .map((n) => n.value)
    .join("");
}
function splice(source, patches) {
  let last = source.length;
  for (const p of patches.sort((a, b) => b.start - a.start)) {
    assert(p.end <= last && p.start <= p.end);
    source = source.slice(0, p.start) + p.text + source.slice(p.end);
    last = p.start;
  }
  return source;
}
function escapeText(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function json(text) {
  return JSON.stringify(text)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
function patchTextNodes(template, changes) {
  const tree = ast(template);
  const patches = [];
  for (const [id, newText] of Object.entries(changes)) {
    const nodes = textNodes(byId(tree, id));
    assert.equal(nodes.length, 1);
    const n = nodes[0],
      loc = n.sourceCodeLocation;
    const raw = template.slice(loc.startOffset, loc.endOffset);
    const fragment = parseFragment(raw, { scriptingEnabled: false });
    assert(fragment.childNodes.every((n) => n.nodeName === "#text"));
    assert.equal(textOf(fragment), n.value);
    patches.push({
      start: loc.startOffset,
      end: loc.endOffset,
      text: escapeText(newText),
    });
  }
  return splice(template, patches);
}
function markerInfo(html) {
  const markers = all(ast(html, true)).filter(
    (n) =>
      n.tagName === "script" &&
      n.attrs.some(
        (a) => a.name === "type" && a.value === "__bundler/template",
      ),
  );
  assert.equal(markers.length, 1);
  const n = markers[0],
    l = n.sourceCodeLocation;
  return {
    start: l.startTag.endOffset,
    end: l.endTag.startOffset,
    template: JSON.parse(textOf(n)),
  };
}
function restore(html, template) {
  const info = markerInfo(html);
  if (info.template === template) return html;
  return splice(html, [
    { start: info.start, end: info.end, text: json(template) },
  ]);
}
const cases = [
  '<!doctype html><p id="p">A &amp; B &#x1f600; &NotEqualTilde;\r\nC</p>',
  '<pre id="p">\nFirst\r\nsecond</pre>',
  '<x-dc><doc-page><footer slot="footer">Footer</footer><sc-raw-table><sc-raw-tr><sc-raw-td id="p">Cell</sc-raw-td></sc-raw-tr></sc-raw-table><header slot="header">Header</header></doc-page></x-dc>',
  '<p id="p">A<script>ignored()</script>B</p>',
  "<table>Before<tr><td>Cell</td></tr>After</table>",
  '<noscript><p id="p">Fallback</p></noscript><p>Body</p>',
  "<p><b>one<i>two</b>three</i>four</p>",
  '<svg><text id="p">Vector &amp; text</text></svg>',
];
function treeShape(n) {
  if (n.nodeName === "#text") return ["text", n.value];
  if (n.nodeName === "#comment") return ["comment", n.data];
  if (n.nodeName === "#documentType")
    return ["doctype", n.name, n.publicId, n.systemId];
  return [
    n.tagName || n.nodeName,
    n.namespaceURI || null,
    (n.childNodes || []).map(treeShape),
  ];
}
const malformed = cases[4],
  malformedNode = textNodes(ast(malformed)).find(
    (n) => n.value === "BeforeAfter",
  );
assert(malformedNode);
const malformedRaw = malformed.slice(
  malformedNode.sourceCodeLocation.startOffset,
  malformedNode.sourceCodeLocation.endOffset,
);
assert(malformedRaw.includes("<tr>"));
pass("fostered text source span is not necessarily text-only", {
  decoded: malformedNode.value,
  rawSpan: malformedRaw,
});
const baseline =
  '<!doctype html>\r\n<!-- exact outer spacing -->\r\n<meta charset="utf-8"><title>Synthetic export</title><body>';
const template =
  '<!doctype html><html><head><style>doc-page{display:block}</style></head><body><doc-page><p id="a">Repeat &amp; text.</p><p id="b">Repeat &amp; text.</p><p id="rich">Choose <b id="bold">bold words</b> and <i id="italic">italic words</i>.</p><button id="toggle">Toggle</button><img id="image" src="' +
  fixtures.uuid(1) +
  '"></doc-page></body></html>';
const manifest = {
  [fixtures.uuid(1)]: fixtures.asset(fixtures.png(), "image/png", false),
};
const bootstrap = `(()=>{window.bootstrapRuns=(window.bootstrapRuns||0)+1;const m=JSON.parse(document.querySelector('script[type="__bundler/manifest"]').textContent);const t=JSON.parse(document.querySelector('script[type="__bundler/template"]').textContent);customElements.define('doc-page',class extends HTMLElement{connectedCallback(){this.dataset.runtime='ready'}});const d=new DOMParser().parseFromString(t,'text/html');for(const img of d.querySelectorAll('img')){const a=m[img.getAttribute('src')];img.src='data:'+a.mime+';base64,'+a.data}document.body.replaceChildren(...d.body.childNodes);document.querySelector('#toggle').onclick=()=>document.body.dataset.clicked='yes';})();`;
const original =
  baseline +
  '<script type="__bundler/manifest">' +
  json(manifest) +
  '</script><!-- <script type="__bundler/template">"decoy"</script> --><script data-q=">" TYPE="__bundler/template">\r\n' +
  json(template) +
  "\r\n</SCRIPT><script>" +
  bootstrap +
  "</script>";
assert.equal(restore(original, template), original);
const replacement =
  "Edited </script><script>window.unwanted=true</script> & 👩‍💻 é";
const updated = patchTextNodes(template, {
  b: replacement,
  bold: "new wording",
  italic: "",
});
const exported = restore(original, updated),
  before = markerInfo(original),
  after = markerInfo(exported);
assert.equal(original.slice(0, before.start), exported.slice(0, after.start));
assert.equal(original.slice(before.end), exported.slice(after.end));
assert.equal(textOf(byId(ast(updated), "a")), "Repeat & text.");
assert.equal(textOf(byId(ast(updated), "b")), replacement);
pass(
  "two-level source splice preserves outer prefix/suffix and targets duplicate passage",
);
fs.writeFileSync(root + "original.html", original);
fs.writeFileSync(root + "exported.html", exported);
const generated = await build({
  stdin: {
    contents: 'export {parse} from "parse5";',
    resolveDir: dependencyDir,
  },
  bundle: true,
  format: "iife",
  globalName: "ResearchParser",
  platform: "browser",
  minify: true,
  write: false,
});
pass("browser parser bundles without Node shims", {
  bytes: generated.outputFiles[0].contents.length,
  ...versions,
});
for (const [engine, type] of Object.entries({ chromium, firefox })) {
  const browser = await type.launch({ headless: true });
  try {
    const context = await browser.newContext({
      offline: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const errors = [],
      requests = [];
    page.on("pageerror", (e) => errors.push(e.message));
    context.on("request", (r) => {
      if (/^https?:/.test(r.url())) requests.push(r.url());
    });
    await page.goto(pathToFileURL(path.join(repo, "index.html")).href);
    await page.addScriptTag({ content: generated.outputFiles[0].text });
    assert.equal(
      await page.evaluate(() => typeof ResearchParser.parse),
      "function",
    );
    for (const html of cases) {
      const shape = await page.evaluate((html) => {
        function shape(n) {
          if (n.nodeType === 3) return ["text", n.data];
          if (n.nodeType === 8) return ["comment", n.data];
          if (n.nodeType === 10)
            return ["doctype", n.name, n.publicId, n.systemId];
          return [
            n.localName || n.nodeName,
            n.namespaceURI || null,
            [...n.childNodes].map(shape),
          ];
        }
        return shape(new DOMParser().parseFromString(html, "text/html"));
      }, html);
      assert.deepEqual(shape, treeShape(ast(html)));
    }
    const digest = await page.evaluate(async () => ({
      secure: isSecureContext,
      bytes: (await crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3])))
        .byteLength,
    }));
    assert.equal(digest.bytes, 32);
    const converted = await page.evaluate(async (html) => {
      const d = bundleImporter.detect(
        new DOMParser().parseFromString(html, "text/html"),
      );
      return (
        await bundleImporter.convert(d, {
          signal: new AbortController().signal,
        })
      ).html;
    }, exported);
    assert.equal(textOf(byId(ast(converted), "b")), replacement);
    assert.equal(await page.evaluate(() => window.bootstrapRuns || 0), 0);
    const large = fixtures.large();
    const timing = await page.evaluate((html) => {
      const t = performance.now();
      const d = ResearchParser.parse(html, {
        sourceCodeLocationInfo: true,
        scriptingEnabled: true,
      });
      return { ms: performance.now() - t, children: d.childNodes.length };
    }, large);
    await helpers.importHtml(page, fixtures.documentBundle());
    await helpers.comment(page, {
      selector: "#p0",
      start: 0,
      end: 5,
      replacement: "Edited",
    });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    page.on("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    const saved = await helpers.download(page, "#save-button");
    const review = await page.evaluate(
      (s) =>
        JSON.parse(
          new DOMParser()
            .parseFromString(s, "text/html")
            .querySelector("#review-data").textContent,
        ),
      saved.toString(),
    );
    assert.equal(review.comments.length, 0);
    assert(review.documentHtml.includes("Edited passage"));
    for (const name of ["original", "exported"]) {
      await page.goto(pathToFileURL(root + name + ".html").href);
      await page.locator('doc-page[data-runtime="ready"]').waitFor();
      assert.equal(await page.evaluate(() => window.bootstrapRuns), 1);
      assert.equal(
        await page.locator("#b").textContent(),
        name === "exported" ? replacement : "Repeat & text.",
      );
      assert.equal(await page.evaluate(() => window.unwanted), undefined);
      await page.locator("#toggle").click();
      assert.equal(
        await page.locator("body").getAttribute("data-clicked"),
        "yes",
      );
      assert.equal(
        await page
          .locator("#image")
          .evaluate((n) => n.complete && n.naturalWidth > 0),
        true,
      );
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    report.engines.push({
      engine,
      version: browser.version(),
      treeParityCases: cases.length,
      digest,
      largeInputBytes: Buffer.byteLength(large),
      singleLargeParseMs: Math.round(timing.ms),
      acceptedTextSurvivesRemovedComment: true,
      standaloneRuntimeAndImage: true,
      literalReplacement: true,
      externalRequests: requests.length,
      pageErrors: errors.length,
    });
  } finally {
    await browser.close();
  }
}
report.warnings.push(
  "Research spike only: no persisted source mapping, edit ledger, schema migration, cancellation, budget enforcement, or general-purpose exporter implemented. Single timing samples are not benchmarks.",
);
fs.writeFileSync(root + "results.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
