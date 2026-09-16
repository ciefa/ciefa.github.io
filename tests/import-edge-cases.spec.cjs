const {
  test,
  expect,
  open,
  importHtml,
  doc,
  comment,
  select,
  state,
  download,
  previewReady,
} = require('./helpers/reviewer.cjs');
const { convert, appLimits } = require('./helpers/importer.cjs');
const f = require('./helpers/bundle-fixtures.cjs');
const fs = require('node:fs');

test.beforeEach(async ({ page }) => open(page));

test('V05 passive root works without a page component', async ({ page }) => {
  await importHtml(page, f.bundle('<x-dc><p>Flowing content</p></x-dc>'));
  await expect(doc(page).locator('x-dc')).toHaveClass('hri-static-root');
  expect(
    await doc(page)
      .locator('x-dc')
      .evaluate((n) => getComputedStyle(n).display),
  ).toBe('block');
});

test('I06 escaped font property and CSS comments keep resource context', async ({ page }) => {
  const html = f.bundle(
    `<style>@font-face{font-family:FixtureFira;s\\72 c/* source */:url('${f.uuid(1)}')}p{font-family:FixtureFira}</style><p>Embedded typeface</p>`,
    { [f.uuid(1)]: f.asset(f.font(), 'font/woff2') },
  );
  await importHtml(page, html);
  expect(
    await doc(page)
      .locator('p')
      .evaluate(async (p) => {
        await p.ownerDocument.fonts.load('16px FixtureFira');
        return p.ownerDocument.fonts.check('16px FixtureFira');
      }),
  ).toBe(true);
});

test('X02 source sentinels stay inactive in static review and both exports', async ({ page }) => {
  const html = f.bundle(
    '<script>parent.sourceRan=true</script><p onclick="parent.sourceRan=true">Synthetic source</p><img src="' +
      f.uuid(1) +
      '" onload="parent.sourceRan=true">',
    { [f.uuid(1)]: f.asset(f.png()) },
  );
  await importHtml(page, html);
  await doc(page).locator('p').click();
  expect(await page.evaluate(() => window.sourceRan)).toBeUndefined();
  const revised = await download(page, '#clean-button'),
    annotated = await download(page, '#save-button');
  for (const file of [revised, annotated]) {
    await importHtml(page, file);
    expect(
      await doc(page)
        .locator('body')
        .evaluate((b) => b.querySelectorAll('script,[onclick],[onload]').length),
    ).toBe(0);
    expect(await page.evaluate(() => window.sourceRan)).toBeUndefined();
  }
});

for (const data of ['{', '{}', 'false', '42', '"text"']) {
  test('I01 malformed annotated state ' + data, async ({ page }) => {
    await importHtml(page, f.plain(), 'before.html');
    await page.locator('#file-input').setInputFiles({
      name: 'bad.html',
      mimeType: 'text/html',
      buffer: Buffer.from(
        '<script id="review-data" type="application/json">' +
          data +
          '</script>' +
          f.documentBundle(),
      ),
    });
    await expect(page.locator('#toast')).toContainText('annotated copy');
    await expect(page.locator('#filename')).toHaveText('before.html');
  });
}

test('I01 annotated state wins over outer bundle markers; duplicates fail', async ({ page }) => {
  const legacy = fs.readFileSync('tests/fixtures/legacy-review.html', 'utf8');
  await importHtml(page, legacy + f.bundle('<p>Wrong document</p>'));
  await expect(page.locator('.card')).toHaveCount(5);
  await page.locator('#file-input').setInputFiles({
    name: 'duplicate.html',
    mimeType: 'text/html',
    buffer: Buffer.from(legacy + '<script id="review-data" type="application/json">null</script>'),
  });
  await expect(page.locator('#toast')).toContainText('annotated copy');
  await expect(page.locator('.card')).toHaveCount(5);
});

test('I03 mixed compression and I04 unsupported MIME', async ({ page }) => {
  const p = f.parts();
  p.manifest[f.uuid(2)] = f.asset(Buffer.from(f.svg), 'image/svg+xml', false);
  await importHtml(page, f.bundle(p.template, p.manifest));
  expect(
    await doc(page)
      .locator('#vector')
      .evaluate((i) => i.naturalWidth),
  ).toBe(16);
  expect(
    (
      await convert(
        page,
        f.bundle('<p>Text</p>', {
          [f.uuid(1)]: f.asset(Buffer.from('a'), 'application/octet-stream'),
        }),
      )
    ).error,
  ).toBe('UNSUPPORTED_BUNDLE');
});

test('I08 missing decompression API from page initialization', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'DecompressionStream', { value: undefined }),
  );
  await open(page);
  expect((await convert(page, f.documentBundle())).error).toBe('DECOMPRESSION_UNAVAILABLE');
  await importHtml(page, f.documentBundle({ compressed: false }));
});

test('I09 input and image pixel boundaries', async ({ page }) => {
  const html = f.plain(),
    bytes = Buffer.byteLength(html);
  await appLimits(page, { MAX_INPUT_BYTES: bytes });
  await importHtml(page, html, 'boundary.html');
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'over.html', mimeType: 'text/html', buffer: Buffer.from(html + ' ') });
  await expect(page.locator('#toast')).toContainText('exceeds');
  await expect(page.locator('#filename')).toHaveText('boundary.html');
  for (const limits of [
    { MAX_IMAGE_PIXELS: 48, MAX_TOTAL_IMAGE_PIXELS: 96 },
    { MAX_IMAGE_PIXELS: 47 },
    { MAX_TOTAL_IMAGE_PIXELS: 95 },
  ]) {
    await appLimits(page, limits);
    await importHtml(page, '<p>Previous document</p>', 'before.html');
    const bundle = f.bundle(`<img src="${f.uuid(1)}"><img src="${f.uuid(2)}">`, {
      [f.uuid(1)]: f.asset(f.png(8, 6, 1)),
      [f.uuid(2)]: f.asset(f.png(8, 6, 2)),
    });
    if (limits.MAX_TOTAL_IMAGE_PIXELS === 96) await importHtml(page, bundle);
    else {
      await page
        .locator('#file-input')
        .setInputFiles({ name: 'over.html', mimeType: 'text/html', buffer: Buffer.from(bundle) });
      await expect(page.locator('#toast')).toContainText('exceeds');
      await expect(page.locator('#filename')).toHaveText('before.html');
    }
  }
});

test('I09 production aggregate pixel limit', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Production limit exercised in Chromium');
  const manifest = {},
    images = [];
  for (let i = 0; i < 5; i++) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="4000"><rect width="1" height="1" fill="rgb(${i},0,0)"/></svg>`;
    manifest[f.uuid(i)] = f.asset(Buffer.from(svg), 'image/svg+xml');
    images.push(`<img style="width:1px" src="${f.uuid(i)}">`);
  }
  await importHtml(page, f.plain(), 'before.html');
  await page.locator('#file-input').setInputFiles({
    name: 'over.html',
    mimeType: 'text/html',
    buffer: Buffer.from(f.bundle(images.join(''), manifest)),
  });
  await expect(page.locator('#toast')).toContainText('exceeds');
  await expect(page.locator('#filename')).toHaveText('before.html');
});

test('I11 UTF-16BE and newline variants preserve quote and replacement', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = 'Grüße 👩‍💻 é' + newline + 'Next line';
    const bytes = Buffer.from('<pre id="p0">' + text + '</pre>', 'utf16le');
    bytes.swap16();
    await importHtml(page, Buffer.concat([Buffer.from([254, 255]), bytes]));
    await comment(page, { replacement: 'Neue Zeile 👩‍💻' });
    expect(await page.locator('.card .quote').textContent()).toBe('Grüße 👩‍💻 é\nNext line');
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    const saved = await download(page, '#save-button');
    await importHtml(page, saved);
    await expect(doc(page).locator('#p0')).toHaveText('Neue Zeile 👩‍💻');
  }
});

async function pauseDecoder(page) {
  await page.evaluate(() => {
    const Original = DecompressionStream;
    window.releaseDecoder = null;
    window.restoreDecoder = () => {
      window.DecompressionStream = Original;
    };
    window.DecompressionStream = class {
      constructor(format) {
        const stream = new Original(format);
        let first = true;
        const gate = new TransformStream({
          transform(chunk, controller) {
            if (!first) {
              controller.enqueue(chunk);
              return;
            }
            first = false;
            return new Promise((resolve) => {
              window.releaseDecoder = () => {
                try {
                  controller.enqueue(chunk);
                } catch {}
                resolve();
              };
            });
          },
        });
        this.writable = stream.writable;
        this.readable = stream.readable.pipeThrough(gate);
      }
    };
  });
}

async function pauseFrame(page) {
  await page.evaluate(() => {
    const append = Element.prototype.append;
    window.releaseFrame = null;
    Element.prototype.append = function (...nodes) {
      const candidate = nodes.find((n) => n.id === 'import-candidate-frame');
      if (candidate) {
        const loaded = candidate.onload;
        candidate.onload = null;
        window.releaseFrame = () => {
          loaded();
        };
        Element.prototype.append = append;
      }
      return append.apply(this, nodes);
    };
  });
}

for (const phase of ['decoder', 'frame'])
  test('L03 cancel pending ' + phase + ' preserves draft', async ({ page }) => {
    await importHtml(page, f.plain(), 'before.html');
    await select(page, '#p0');
    await page.locator('#add-selection').click();
    await page.locator('#note-input').fill('Keep this draft');
    page.on('dialog', (d) => d.accept());
    const before = await state(page);
    if (phase === 'decoder') await pauseDecoder(page);
    else await pauseFrame(page);
    await page.locator('#file-input').setInputFiles({
      name: 'pending.html',
      mimeType: 'text/html',
      buffer: Buffer.from(f.documentBundle()),
    });
    await page.waitForFunction(
      (phase) => !!window[phase === 'decoder' ? 'releaseDecoder' : 'releaseFrame'],
      phase,
    );
    if (phase === 'frame')
      await expect(page.locator('#import-candidate-frame')).toHaveAttribute(
        'sandbox',
        'allow-same-origin',
      );
    await page.locator('#cancel-import').click();
    await expect(page.locator('#import-status')).toBeHidden();
    await expect(page.locator('#import-candidate-frame')).toHaveCount(0);
    expect(await state(page)).toEqual(before);
    await page.evaluate((phase) => {
      if (phase === 'decoder') {
        window.restoreDecoder();
        window.releaseDecoder();
      } else window.releaseFrame();
    }, phase);
    await page.locator('#submit-comment').click();
    await expect(doc(page).locator('#p0 mark')).toHaveCount(1);
    await importHtml(page, f.documentBundle());
    await expect(doc(page).locator('h1')).toHaveText('Synthetic handbook');
  });

test('L06 staging deadline is controlled by the browser clock', async ({ page }) => {
  await importHtml(page, f.plain(), 'before.html');
  await page.clock.install();
  await pauseFrame(page);
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'pending.html', mimeType: 'text/html', buffer: Buffer.from(f.plain()) });
  await page.waitForFunction(() => !!window.releaseFrame);
  await page.clock.fastForward(10001);
  await expect(page.locator('#toast')).toContainText('took too long');
  await expect(page.locator('#filename')).toHaveText('before.html');
  await expect(page.locator('#import-candidate-frame')).toHaveCount(0);
  await page.evaluate(() => window.releaseFrame());
});

test('L05 completion leaves an open help dialog focused', async ({ page }) => {
  await importHtml(page, f.plain());
  await pauseFrame(page);
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'pending.html', mimeType: 'text/html', buffer: Buffer.from(f.plain()) });
  await page.waitForFunction(() => !!window.releaseFrame);
  await page.locator('#help-button').click();
  await page.evaluate(() => window.releaseFrame());
  await expect(page.locator('#import-status')).toBeHidden();
  await expect(page.locator('#help-dialog')).toBeVisible();
  expect(
    await page.evaluate(() =>
      document.querySelector('#help-dialog').contains(document.activeElement),
    ),
  ).toBe(true);
});

test('V07 preview links and suggestion focus', async ({ page }) => {
  await importHtml(page, f.documentBundle());
  await comment(page, { replacement: 'New passage' });
  await page.locator('#preview-button').click();
  await previewReady(page);
  await page.frameLocator('#preview-frame').locator('#jump').click();
  await expect
    .poll(() => page.locator('#preview-frame').evaluate((f) => f.contentWindow.scrollY))
    .toBeGreaterThan(0);
  await page.frameLocator('#preview-frame').locator('mark').click();
  await expect(page.locator('.card')).toHaveClass(/active/);
});

test('S05 exact output byte boundary remains openable', async ({ page }) => {
  await importHtml(page, f.plain(), 'boundary.html');
  const saved = await download(page, '#save-button');
  // Changing the limit declaration changes the saved reviewer itself. Find the
  // fixed point before running the exact-boundary download through the real UI.
  let size = saved.length;
  for (let i = 0; i < 3; i++)
    size = Buffer.byteLength(
      saved
        .toString()
        .replace(/const MAX_DOWNLOAD_BYTES = [^;]+;/, 'const MAX_DOWNLOAD_BYTES = ' + size + ';'),
    );
  await appLimits(page, { MAX_DOWNLOAD_BYTES: size });
  await importHtml(page, f.plain(), 'boundary.html');
  const boundary = await download(page, '#save-button');
  expect(boundary.length).toBe(size);
  await importHtml(page, boundary);
  await expect(doc(page).locator('#p0')).toContainText('Alpha');
});
