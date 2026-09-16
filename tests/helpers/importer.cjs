const fs = require('node:fs');
const path = require('node:path');
const source = () => fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
async function convert(page, html, summary = false) {
  return page.evaluate(
    async ({ html, summary }) => {
      try {
        const d = bundleImporter.detect(new DOMParser().parseFromString(html, 'text/html'));
        if (!d) return { ordinary: true };
        const r = await bundleImporter.convert(d, { signal: new AbortController().signal });
        return summary
          ? { assetCount: r.assetCount, decodedBytes: r.decodedBytes, length: r.html.length }
          : r;
      } catch (e) {
        return { error: e.code || e.name };
      }
    },
    { html, summary },
  );
}
async function limited(context, limits) {
  let script = source().match(/<script id="bundle-importer">([\s\S]*?)<\/script>/)[1];
  for (const [name, value] of Object.entries(limits)) {
    const regex = new RegExp('const ' + name + ' = [^;]+;', 'g');
    if ([...script.matchAll(regex)].length !== 1) throw Error('Missing unique limit ' + name);
    script = script.replace(regex, 'const ' + name + ' = ' + value + ';');
  }
  const p = await context.newPage();
  await p.setContent(
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';img-src data:;font-src data:\"><script>" +
      script +
      '</script>',
  );
  return p;
}
async function appLimits(page, limits) {
  let html = source();
  for (const [name, value] of Object.entries(limits)) {
    const regex = new RegExp('const ' + name + ' = [^;]+;', 'g');
    if ([...html.matchAll(regex)].length !== 1) throw Error('Missing unique limit ' + name);
    html = html.replace(regex, 'const ' + name + ' = ' + value + ';');
  }
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}
module.exports = { convert, limited, appLimits, source };
