const {
  test,
  expect,
  open,
  importHtml,
  doc,
  comment,
  download,
  directFile,
  previewReady,
} = require('./helpers/reviewer.cjs');
const { convert } = require('./helpers/importer.cjs');
const f = require('./helpers/bundle-fixtures.cjs');
const http = require('node:http');
const fs = require('node:fs');
test.beforeEach(async ({ page }) => open(page));
test('X01 source scripts and handlers never execute during review or reopen', async ({
  page,
  browser,
}, testInfo) => {
  const html = f.bundle(
    '<script>window.sourceRan=true;parent.sourceRan=true</script><p id="p0" onclick="window.sourceRan=true">Synthetic text to select.</p><img src="' +
      f.uuid(1) +
      '" onload="parent.sourceRan=true"><a id="js" href="javascript:window.sourceRan=true">Click</a><form action="https://example.invalid/post"><button>Submit</button></form>',
    { [f.uuid(1)]: f.asset(f.png()) },
  );
  await importHtml(page, html);
  await doc(page).locator('#p0').click();
  await doc(page).locator('#js').click();
  await doc(page).getByRole('button', { name: 'Submit' }).click();
  expect(await page.evaluate(() => window.sourceRan)).toBeUndefined();
  expect(
    await doc(page)
      .locator('body')
      .evaluate((b) => b.ownerDocument.defaultView.sourceRan),
  ).toBeUndefined();
  await comment(page, { replacement: 'Safe change' });
  await page.locator('#preview-button').click();
  const annotated = await download(page, '#save-button'),
    revised = await download(page, '#clean-button');
  const ctx = await browser.newContext({ offline: true, serviceWorkers: 'block' }),
    p = await ctx.newPage();
  await directFile(p, annotated, testInfo, 'safe-review');
  await expect(p.locator('.card')).toHaveCount(1);
  expect(await p.evaluate(() => window.sourceRan)).toBeUndefined();
  await directFile(p, revised, testInfo, 'safe-revised');
  await p.locator('#js').click();
  expect(await p.evaluate(() => window.sourceRan)).toBeUndefined();
  await ctx.close();
});
test('X02 static resource probes are blocked before and after serialization', async ({ page }) => {
  const probe = 'https://example.invalid/probe';
  await importHtml(
    page,
    `<base href="${probe}/"><style>@import '${probe}.css';p{background:url('${probe}.png')}</style><link rel="stylesheet" href="${probe}.css"><p>Network probes</p><img src="${probe}.jpg"><iframe src="${probe}"></iframe><object data="${probe}"></object><video src="${probe}.mp4"></video><svg><image href="${probe}.svg"/></svg><form action="${probe}"><button>Submit</button></form>`,
  );
  await doc(page).getByRole('button', { name: 'Submit' }).click();
  await page.locator('#preview-button').click();
  await expect(page.locator('#preview-area')).toBeVisible();
});
test('X03 every frame retains sandbox and CSP; loopback app works', async ({ page }) => {
  await importHtml(page, f.documentBundle());
  await page.locator('#preview-button').click();
  await previewReady(page);
  for (const id of ['document-frame', 'preview-frame']) {
    await expect(page.locator('#' + id)).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(
      await page
        .locator('#' + id)
        .evaluate(
          (f) =>
            f.contentDocument.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
        ),
    ).toContain("script-src 'none'");
  }
  const html = fs.readFileSync('index.html');
  const server = http.createServer((req, res) => {
    if (req.url !== '/') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await page.goto('http://127.0.0.1:' + server.address().port + '/');
    await importHtml(page, f.documentBundle());
    await expect(doc(page).locator('h1')).toHaveText('Synthetic handbook');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test('X04 hostile JSON keys do not change prototypes', async ({ page }) => {
  const manifest = JSON.parse('{"__proto__":{"polluted":true}}');
  expect((await convert(page, f.bundle('<p>Prototype test</p>', manifest))).error).toBe(
    'INVALID_BUNDLE',
  );
  expect(await page.evaluate(() => ({}).polluted)).toBeUndefined();
});
