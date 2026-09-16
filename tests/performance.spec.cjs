const { test, expect, open, importHtml, comment, previewReady } = require('./helpers/reviewer.cjs');
const f = require('./helpers/bundle-fixtures.cjs');
const os = require('node:os');
let large;
test.use({ trace: 'off', screenshot: 'off' });
test.beforeEach(async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Local performance gates use Chromium');
  test.setTimeout(120000);
  large ||= f.large();
  await open(page);
  testInfo.annotations.push({
    type: 'machine',
    description: JSON.stringify({
      browser: page.context().browser().version(),
      os: os.platform() + ' ' + os.release(),
      cpu: os.cpus()[0]?.model,
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
      availableMemoryGiB: Math.round(os.freemem() / 2 ** 30),
    }),
  });
});
test('P01 @performance full large document import', async ({ page }, testInfo) => {
  const size = Buffer.byteLength(large);
  expect(size).toBeGreaterThan(16 * 1024 * 1024);
  expect(size).toBeLessThan(24 * 1024 * 1024);
  const conversion = await page.evaluate(async (html) => {
    const t = performance.now();
    const result = await bundleImporter.convert(
      bundleImporter.detect(new DOMParser().parseFromString(html, 'text/html')),
      { signal: new AbortController().signal },
    );
    return { ms: performance.now() - t, assets: result.assetCount };
  }, large);
  await page.evaluate(() => {
    window.stageTiming = {};
    new MutationObserver((records) => {
      for (const record of records) {
        if (
          record.type === 'childList' &&
          [...record.addedNodes].some((n) => n.id === 'import-candidate-frame')
        )
          window.stageTiming.start = performance.now();
        if (
          record.type === 'attributes' &&
          record.target.id === 'document-frame' &&
          window.stageTiming.start
        )
          window.stageTiming.end = performance.now();
      }
    }).observe(document.querySelector('.document-stage'), {
      childList: true,
      attributes: true,
      subtree: true,
      attributeFilter: ['id'],
    });
  });
  const start = Date.now();
  await importHtml(page, large);
  const total = Date.now() - start;
  const counts = await page.locator('#document-frame').evaluate((f) => {
    const d = f.contentDocument;
    return {
      headings: d.querySelectorAll('h2').length,
      paragraphs: d.querySelectorAll('p').length,
      images: d.images.length,
      loaded: [...d.images].filter((i) => i.complete && i.naturalWidth).length,
      captions: d.querySelectorAll('figcaption').length,
      cells: d.querySelectorAll('td').length,
      height: d.body.scrollHeight,
    };
  });
  expect(counts).toMatchObject({
    headings: 250,
    paragraphs: 400,
    images: 320,
    loaded: 320,
    captions: 320,
    cells: 20,
  });
  expect(counts.height).toBeGreaterThan(100000);
  expect(total).toBeLessThan(30000);
  testInfo.annotations.push({
    type: 'timing',
    description: JSON.stringify({
      inputBytes: size,
      conversionMs: Math.round(conversion.ms),
      stagingMs: await page.evaluate(() =>
        Math.round(window.stageTiming.end - window.stageTiming.start),
      ),
      totalImportMs: total,
    }),
  });
});
test('P02 @performance preview with 100 comments and 20 suggestions', async ({
  page,
}, testInfo) => {
  await importHtml(page, large);
  for (let i = 0; i < 100; i++)
    await comment(page, {
      selector: '#p' + i,
      note: 'Comment ' + i,
      replacement: i < 20 ? 'Suggested text ' + i : null,
    });
  let start = Date.now();
  await page.locator('#preview-button').click();
  await previewReady(page);
  const preview = Date.now() - start;
  // Bringing an off-screen sidebar card into view is separate from processing
  // the user's decision. Establish an actionable button before starting its gate.
  const accept = page.getByRole('button', { name: 'Accept', exact: true }).first();
  start = Date.now();
  await accept.scrollIntoViewIfNeeded();
  await accept.hover();
  const navigationMs = Date.now() - start;
  start = Date.now();
  await accept.click();
  const clickMs = Date.now() - start;
  await expect(page.frameLocator('#preview-frame').locator('#p0 mark')).toHaveAttribute(
    'data-hr-state',
    'accepted',
  );
  await previewReady(page);
  const update = Date.now() - start;
  testInfo.annotations.push({
    type: 'timing',
    description: JSON.stringify({ previewMs: preview, decisionMs: update, clickMs, navigationMs }),
  });
  expect(preview).toBeLessThan(5000);
  expect(update).toBeLessThan(5000);
});
test('P03 @performance repeated previews, imports, cancellations release documents', async ({
  page,
  context,
}, testInfo) => {
  await importHtml(page, large);
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const before = await cdp.send('Memory.getDOMCounters');
  for (let i = 0; i < 10; i++) {
    await page.locator('#preview-button').click();
    await previewReady(page);
    await page.locator('#preview-button').click();
  }
  for (let i = 0; i < 10; i++) await importHtml(page, f.plain());
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    window.reads = [];
    File.prototype.arrayBuffer = function () {
      return new Promise((resolve) => window.reads.push(() => resolve(original.call(this))));
    };
  });
  for (let i = 0; i < 5; i++) {
    await page.locator('#file-input').setInputFiles({
      name: 'cancel.html',
      mimeType: 'text/html',
      buffer: Buffer.from(f.plain()),
    });
    await page.locator('#cancel-import').click();
    await expect(page.locator('#import-status')).toBeHidden();
    await page.evaluate(() => window.reads.shift()());
  }
  await cdp.send('HeapProfiler.collectGarbage');
  const after = await cdp.send('Memory.getDOMCounters');
  await expect(page.locator('iframe')).toHaveCount(2);
  await expect(page.locator('#import-candidate-frame')).toHaveCount(0);
  expect(after.documents).toBeLessThanOrEqual(before.documents + 2);
  testInfo.annotations.push({ type: 'memory', description: JSON.stringify({ before, after }) });
});
test('P04 @performance cancellation remains responsive during decompression', async ({
  page,
}, testInfo) => {
  await importHtml(page, f.plain(), 'before.html');
  await page.evaluate(() => {
    window.longTasks = [];
    new PerformanceObserver((list) =>
      window.longTasks.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ entryTypes: ['longtask'] });
  });
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'large.html', mimeType: 'text/html', buffer: Buffer.from(large) });
  await expect(page.locator('#import-message')).toContainText('Unpacking');
  const start = Date.now();
  await page.locator('#cancel-import').click();
  await expect(page.locator('#import-status')).toBeHidden();
  const elapsed = Date.now() - start;
  await expect(page.locator('#filename')).toHaveText('before.html');
  testInfo.annotations.push({
    type: 'responsiveness',
    description: JSON.stringify({
      cancelMs: elapsed,
      longTasks: await page.evaluate(() => window.longTasks),
    }),
  });
  expect(elapsed).toBeLessThan(500);
});
