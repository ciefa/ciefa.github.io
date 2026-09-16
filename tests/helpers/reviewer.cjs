const base = require('@playwright/test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const root = path.resolve(__dirname, '../..'),
  appUrl = pathToFileURL(path.join(root, 'index.html')).href;
const test = base.test.extend({
  webkitEventLimitation: [
    async ({ browserName }, use, testInfo) => {
      // These cases need parent-owned listeners inside the script-blocked frame.
      // K01 separately tracks the upstream defect as an expected failure, so a
      // WebKit fix becomes an unexpected pass and prompts restoring this coverage.
      const needsEvents = /^(?:A\d\d|S0[1-4]|V07|X01|L0[123]|I11 UTF-16BE|S05 oversized)/.test(
        testInfo.title,
      );
      base.test.skip(
        browserName === 'webkit' && needsEvents,
        'WebKit 218086: sandbox blocks parent event handlers; see docs/testing.md',
      );
      await use();
    },
    { auto: true },
  ],
  networkGuard: [
    async ({ context }, use) => {
      const requests = [],
        errors = [];
      const watch = (p) => p.on('pageerror', (e) => errors.push(e.message));
      context.pages().forEach(watch);
      context.on('page', watch);
      await context.route('**/*', (r) => {
        const url = r.request().url();
        if (/^https?:/i.test(url) && !url.startsWith('http://127.0.0.1:')) {
          requests.push(url);
          return r.abort();
        }
        return r.continue();
      });
      await use();
      base.expect(requests, 'external requests').toEqual([]);
      base.expect(errors, 'page exceptions').toEqual([]);
    },
    { auto: true },
  ],
});
let sequence = 0;
async function open(page) {
  await page.goto(appUrl);
}
async function importHtml(page, html, name = `fixture-${++sequence}.html`) {
  const previous = await page.locator('#document-frame').elementHandle();
  await page.locator('#file-input').setInputFiles({
    name,
    mimeType: 'text/html',
    buffer: Buffer.isBuffer(html) ? html : Buffer.from(html),
  });
  await base.expect.poll(() => previous.evaluate((n) => n.isConnected)).toBe(false);
  await previous.dispose();
  await base.expect(page.locator('#import-status')).toBeHidden();
  return page.locator('#filename').textContent();
}
const doc = (page) => page.frameLocator('#document-frame');
async function select(page, selector, start = 0, end = null, endSelector = null) {
  await page.locator('#document-frame').evaluate(
    (iframe, { selector, start, end, endSelector }) => {
      const d = iframe.contentDocument;
      const first = d.querySelector(selector),
        last = endSelector ? d.querySelector(endSelector) : first;
      first.scrollIntoView({ block: 'center' });
      function point(el, offset) {
        const w = d.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          if (offset <= n.length) return [n, offset];
          offset -= n.length;
        }
        throw Error('Selection offset not found');
      }
      const a = point(first, start),
        b = point(last, end === null ? last.textContent.length : end);
      const r = d.createRange();
      r.setStart(...a);
      r.setEnd(...b);
      const s = d.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      d.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    },
    { selector, start, end, endSelector },
  );
  await base.expect(page.locator('#add-selection')).toBeEnabled();
}
async function comment(
  page,
  {
    selector = '#p0',
    start = 0,
    end = null,
    endSelector = null,
    note = 'Synthetic note',
    replacement = null,
  } = {},
) {
  await select(page, selector, start, end, endSelector);
  await page.locator('#add-selection').click();
  await page.locator('#note-input').fill(note);
  if (replacement !== null) {
    await page.locator('#suggest-toggle').check();
    await page.locator('#replacement-input').fill(replacement);
  }
  await page.locator('#submit-comment').click();
}
async function download(page, selector) {
  const pending = page.waitForEvent('download');
  await page.locator(selector).click();
  const file = await pending;
  const stream = await file.createReadStream(),
    chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}
async function previewReady(page) {
  await base.expect(page.locator('#preview-area')).toHaveAttribute('aria-busy', 'false');
  await base.expect(page.locator('#preview-loading')).toBeHidden();
  await base.expect(page.frameLocator('#preview-frame').locator('body')).not.toBeEmpty();
}
async function state(page) {
  return page.evaluate(() => ({
    filename: document.querySelector('#filename').textContent,
    save: document.querySelector('#save-state').textContent,
    html: document.querySelector('#document-frame').contentDocument.body.innerHTML,
    note: document.querySelector('#note-input').value,
    replacement: document.querySelector('#replacement-input').value,
    filter: document.querySelector('#comment-filter').value,
    composerHidden: document.querySelector('#composer').hidden,
    preview: document.querySelector('#preview-button').getAttribute('aria-pressed'),
    scroll: document.querySelector('#document-frame').contentWindow.scrollY,
    previewScroll: document.querySelector('#preview-frame').contentWindow.scrollY,
    sync: document.querySelector('#sync-scroll').checked,
    unsaved: document.querySelector('#save-state').classList.contains('unsaved'),
    sidebar: document.querySelector('#comment-list').innerHTML,
  }));
}
async function directFile(page, buffer, testInfo, label = 'download') {
  const file = testInfo.outputPath(label + '.html');
  await fs.writeFile(file, buffer);
  await page.goto(pathToFileURL(file).href);
}
module.exports = {
  test,
  expect: base.expect,
  root,
  appUrl,
  open,
  importHtml,
  doc,
  select,
  comment,
  download,
  previewReady,
  state,
  directFile,
};
