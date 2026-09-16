const {
  test,
  expect,
  open,
  importHtml,
  doc,
  root,
  previewReady,
} = require('./helpers/reviewer.cjs');
const { convert, limited } = require('./helpers/importer.cjs');
const f = require('./helpers/bundle-fixtures.cjs');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
test.beforeEach(async ({ page }) => open(page));
test('I01 classifications and legacy review precedence', async ({ page }) => {
  await importHtml(page, f.plain());
  await expect(doc(page).locator('#p0')).toContainText('Alpha');
  await importHtml(
    page,
    '<script id="review-data" type="application/json">null</script><p>Unused reviewer wrapper</p>',
  );
  await importHtml(page, fs.readFileSync(path.join(root, 'tests/fixtures/legacy-review.html')));
  await expect(page.locator('.card')).toHaveCount(5);
  await expect(page.locator('.badge.accepted')).toHaveCount(1);
  await importHtml(page, f.documentBundle());
  await expect(doc(page).locator('h1')).toHaveText('Synthetic handbook');
});
for (const [name, html, error] of [
  ['missing', '<script type="__bundler/template">"<p>Hi</p>"</script>', 'INVALID_BUNDLE'],
  [
    'duplicate',
    f.bundle('<p>Hello</p>') + '<script type="__bundler/manifest">{}</script>',
    'INVALID_BUNDLE',
  ],
  [
    'bad JSON',
    '<script type="__bundler/manifest">{</script><script type="__bundler/template">"hello"</script>',
    'INVALID_BUNDLE',
  ],
  ['array manifest', f.bundle('<p>Hello</p>', []), 'INVALID_BUNDLE'],
  ['object template', f.bundle({ html: 'text' }), 'INVALID_BUNDLE'],
  ['bad UUID', f.bundle('<p>Hello</p>', { invalid: f.asset(f.png()) }), 'INVALID_BUNDLE'],
  [
    'bad entry',
    f.bundle('<p>Hello</p>', { [f.uuid(1)]: { mime: 'image/png', data: 12 } }),
    'INVALID_BUNDLE',
  ],
  [
    'bad compression',
    f.bundle('<p>Hello</p>', { [f.uuid(1)]: { ...f.asset(f.png()), compressed: 'yes' } }),
    'INVALID_BUNDLE',
  ],
  [
    'unknown marker',
    f.bundle('<p>Hello</p>') + '<script type="__bundler/future">{}</script>',
    'UNSUPPORTED_BUNDLE',
  ],
  [
    'duplicate mapping',
    f.bundle(
      '<p>Hello</p>',
      { [f.uuid(1)]: { mime: 'text/javascript', data: '' } },
      {
        ext_resources: [
          { id: 'a', uuid: f.uuid(1) },
          { id: 'a', uuid: f.uuid(1) },
        ],
      },
    ),
    'INVALID_BUNDLE',
  ],
])
  test('I02 schema: ' + name, async ({ page }) =>
    expect((await convert(page, html)).error).toBe(error),
  );
for (const compressed of [true, false])
  test(
    'I03 complete ' + (compressed ? 'compressed' : 'uncompressed') + ' bundle',
    async ({ page }) => {
      await importHtml(page, f.documentBundle({ compressed }));
      await expect(doc(page).locator('img')).toHaveCount(2);
      expect(
        await doc(page)
          .locator('body')
          .evaluate(async (body) => {
            await Promise.all([...body.ownerDocument.images].map((i) => i.decode()));
            return [...body.ownerDocument.images].every((i) => i.naturalWidth > 0);
          }),
      ).toBe(true);
      expect(await page.evaluate(() => window.sourceRan)).toBeUndefined();
    },
  );
const badAssets = {
  alphabet: { ...f.asset(f.png()), data: '____' },
  padding: { ...f.asset(f.png()), data: 'A===' },
  truncated: {
    ...f.asset(f.png()),
    data: zlib.gzipSync(f.png()).subarray(0, -5).toString('base64'),
  },
  crc: {
    ...f.asset(f.png()),
    data: (() => {
      const b = zlib.gzipSync(f.png());
      b[b.length - 8] ^= 1;
      return b.toString('base64');
    })(),
  },
  trailing: {
    ...f.asset(f.png()),
    data: Buffer.concat([zlib.gzipSync(f.png()), Buffer.from('junk')]).toString('base64'),
  },
  mime: f.asset(f.png(), 'image/jpeg'),
  font: f.asset(Buffer.from('not a font'), 'font/woff2'),
};
for (const [name, asset] of Object.entries(badAssets))
  test('I04 invalid asset: ' + name, async ({ page }) =>
    expect((await convert(page, f.bundle('<p>Hello</p>', { [f.uuid(1)]: asset }))).error).toBe(
      'INVALID_ASSET',
    ),
  );
test('I04 browser image and font decode failures roll back', async ({ page }) => {
  await importHtml(page, f.plain(), 'previous.html');
  for (const [mime, data, template] of [
    ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), `<img src="${f.uuid(1)}">`],
    [
      'font/woff2',
      Buffer.from('wOF2garbage'),
      `<style>@font-face{font-family:Broken;src:url(${f.uuid(1)})}p{font-family:Broken}</style><p>Test</p>`,
    ],
  ]) {
    await page.locator('#file-input').setInputFiles({
      name: 'broken.html',
      mimeType: 'text/html',
      buffer: Buffer.from(f.bundle(template, { [f.uuid(1)]: f.asset(data, mime) })),
    });
    await expect(page.locator('#toast')).toContainText('could not be decoded');
    await expect(page.locator('#filename')).toHaveText('previous.html');
  }
});
test('I05 context-aware references and missing assets', async ({ page }) => {
  const id = f.uuid(1);
  const r = await convert(
    page,
    f.bundle(
      `<p id="${id}" class="${id}">${id}</p><!--${id}--><style>p::after{content:"url(${id})"}.image{background:url(${id})}</style><img src="${id}">`,
      { [id]: f.asset(f.png()) },
    ),
  );
  expect(r.error).toBeUndefined();
  expect(r.html).toContain(`>${id}</p>`);
  expect(r.html).toContain(`content:"url(${id})"`);
  expect(r.html).toContain(`<!--${id}-->`);
  expect(r.assetCount).toBe(1);
  expect((await convert(page, f.bundle(`<img src="${f.uuid(9)}">`))).error).toBe('MISSING_ASSET');
  expect(
    (
      await convert(
        page,
        f.bundle(`<img src="${id}">`, { [id]: { mime: 'text/javascript', data: '' } }),
      )
    ).error,
  ).toBe('INVALID_ASSET');
});
test('I06 CSS tokens, grouping, escapes, and data URLs', async ({ page }) => {
  const id = f.uuid(1);
  const r = await convert(
    page,
    f.bundle(
      `<style>/* url(${id}) */ @media(min-width:1px){p{background:u\\72 l('${id}')}}p::after{content:'url(untouched)'}</style><p style="background: url( ${id} )">CSS</p><img src="data:image/png;base64,${f.png().toString('base64')}">`,
      { [id]: f.asset(f.png()) },
    ),
  );
  expect(r.error).toBeUndefined();
  expect(r.html).toContain('/* url(' + id + ') */');
  expect(r.html).toContain("content:'url(untouched)'");
  expect(r.html).toContain('background:url("data:image/png;base64,');
});
for (const [name, html, code] of [
  ['external', '<img src="https://example.invalid/image.png">', 'EXTERNAL_RESOURCE'],
  ['relative', '<img src="picture.png">', 'EXTERNAL_RESOURCE'],
  [
    'css external',
    '<style>p{background:url(https://example.invalid/a)}</style>',
    'EXTERNAL_RESOURCE',
  ],
  ['import', '<style>@import "https://example.invalid/a.css";</style>', 'UNSUPPORTED_BUNDLE'],
  ['stylesheet', '<link rel="stylesheet" href="a.css">', 'UNSUPPORTED_BUNDLE'],
  ['srcset', '<img srcset="a.png 2x">', 'UNSUPPORTED_BUNDLE'],
])
  test('I06 unsupported resource: ' + name, async ({ page }) =>
    expect((await convert(page, f.bundle(html))).error).toBe(code),
  );
for (const attack of [
  '<script>window.sourceRan=true</script>',
  '<foreignObject><p>bad</p></foreignObject>',
  '<rect onload="window.sourceRan=true"/>',
  '<use href="https://example.invalid/shape"/>',
  '<g xml:base="https://example.invalid/"/>',
  '<style>rect{fill:url(https://example.invalid/paint)}</style>',
  '<style>@import "https://example.invalid/css";</style>',
])
  test('I07 SVG rejects ' + attack.slice(0, 30), async ({ page }) => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' + attack + '</svg>';
    expect(
      (
        await convert(
          page,
          f.bundle(`<img src="${f.uuid(1)}">`, {
            [f.uuid(1)]: f.asset(Buffer.from(svg), 'image/svg+xml'),
          }),
        )
      ).error,
    ).toBe('INVALID_ASSET');
  });
test('I08 feature detection leaves other formats available', async ({ page }) => {
  await page.evaluate(() =>
    Object.defineProperty(window, 'DecompressionStream', { value: undefined }),
  );
  expect((await convert(page, f.documentBundle())).error).toBe('DECOMPRESSION_UNAVAILABLE');
  await importHtml(page, f.documentBundle({ compressed: false }));
  await importHtml(page, f.plain());
  await importHtml(page, fs.readFileSync(path.join(root, 'tests/fixtures/legacy-review.html')));
});
test('I09 reduced boundary limits use actual importer', async ({ context, page }) => {
  const image = f.png(),
    html = f.bundle(`<img src="${f.uuid(1)}">`, { [f.uuid(1)]: f.asset(image) });
  for (const [name, value] of [
    ['MAX_ASSET_BYTES', image.length],
    ['MAX_TOTAL_ASSET_BYTES', image.length],
    ['MAX_ASSETS', 1],
  ]) {
    for (const delta of [0, -1]) {
      const p = await limited(context, { [name]: value + delta });
      const r = await convert(p, html);
      expect(r.error).toBe(delta ? 'LIMIT_EXCEEDED' : undefined);
      await p.close();
    }
  }
  const template = '<p>Boundary text</p>';
  for (const delta of [0, -1]) {
    const p = await limited(context, { MAX_TEMPLATE_BYTES: Buffer.byteLength(template) + delta });
    expect((await convert(p, f.bundle(template))).error).toBe(delta ? 'LIMIT_EXCEEDED' : undefined);
    await p.close();
  }
  const baseline = await convert(page, html);
  for (const delta of [0, -1]) {
    const p = await limited(context, {
      MAX_NORMALIZED_BYTES: Buffer.byteLength(baseline.html) + delta,
    });
    expect((await convert(p, html)).error).toBe(delta ? 'LIMIT_EXCEEDED' : undefined);
    await p.close();
  }
});
test('I09 production asset, aggregate, count, and template limits', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Expensive production limits exercised in Chromium');
  const over = Buffer.alloc(8 * 1024 * 1024 + 1);
  f.png().copy(over);
  expect(
    (await convert(page, f.bundle('<p>Limit</p>', { [f.uuid(1)]: f.asset(over) }), true)).error,
  ).toBe('LIMIT_EXCEEDED');
  const padded = f.png(1, 1, 1, 8 * 1024 * 1024 - f.png(1, 1).length - 12),
    manifest = {};
  for (let i = 0; i < 5; i++) manifest[f.uuid(i + 1)] = f.asset(padded);
  expect((await convert(page, f.bundle('<p>Limit</p>', manifest), true)).error).toBe(
    'LIMIT_EXCEEDED',
  );
  const many = {};
  for (let i = 0; i < 1025; i++) many[f.uuid(i)] = { mime: 'text/javascript', data: '' };
  expect((await convert(page, f.bundle('<p>Limit</p>', many), true)).error).toBe('LIMIT_EXCEEDED');
  delete many[f.uuid(1024)];
  expect((await convert(page, f.bundle('<p>Limit</p>', many), true)).error).toBeUndefined();
  expect((await convert(page, f.bundle(' '.repeat(2 * 1024 * 1024 + 1)), true)).error).toBe(
    'LIMIT_EXCEEDED',
  );
});
test('I09 production input, normalized growth, and pixel limits', async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Expensive production limits exercised in Chromium');
  await importHtml(page, f.plain(), 'before.html');
  const largePath = testInfo.outputPath('large.html');
  fs.writeFileSync(largePath, Buffer.alloc(64 * 1024 * 1024 + 1, 32));
  await page.locator('#file-input').setInputFiles(largePath);
  await expect(page.locator('#toast')).toContainText('exceeds');
  await expect(page.locator('#filename')).toHaveText('before.html');
  const padded = f.png(1, 1, 1, 1024 * 1024);
  expect(
    (
      await convert(
        page,
        f.bundle(`<img src="${f.uuid(1)}">`.repeat(40), { [f.uuid(1)]: f.asset(padded) }),
        true,
      )
    ).error,
  ).toBe('LIMIT_EXCEEDED');
  const vector =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="4001"><rect width="1" height="1"/></svg>';
  await page.locator('#file-input').setInputFiles({
    name: 'pixels.html',
    mimeType: 'text/html',
    buffer: Buffer.from(
      f.bundle(`<img style="width:1px" src="${f.uuid(1)}">`, {
        [f.uuid(1)]: f.asset(Buffer.from(vector), 'image/svg+xml'),
      }),
    ),
  });
  await expect(page.locator('#import-status')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('exceeds');
});
for (const template of [
  '<future-widget>Hi</future-widget>',
  '<sc-if>Hi</sc-if>',
  '<script data-dc-script>class C {}</script>',
  '<p :value="x">Hi</p>',
  '<p>{{expression}}</p>',
  '<doc-page size="unknown">Hi</doc-page>',
  '<doc-page width="">Hi</doc-page>',
  '<doc-page margin="30in">Hi</doc-page>',
  '<doc-page><div class="page">Hi</div></doc-page>',
  '<doc-page><p slot="other">Hi</p></doc-page>',
])
  test('I10 unsupported document: ' + template.slice(0, 55), async ({ page }) =>
    expect((await convert(page, f.bundle(template))).error).toBe('UNSUPPORTED_BUNDLE'),
  );
test('I10 page bundles and literal code', async ({ page }) => {
  expect((await convert(page, f.bundle('<p>Hi</p>', {}, { page_order: ['page'] }))).error).toBe(
    'UNSUPPORTED_BUNDLE',
  );
  expect(await convert(page, f.bundle(f.bundle('<p>Nested</p>')))).toHaveProperty(
    'error',
    'UNSUPPORTED_BUNDLE',
  );
  expect((await convert(page, f.bundle('<pre><code>{{literal}}</code></pre>'))).html).toContain(
    '{{literal}}',
  );
});
test('I11 encodings and Unicode', async ({ page }) => {
  const text = 'Grüße 👩‍💻 é — العربية';
  for (const buffer of [
    Buffer.from('\ufeff<p>' + text + '</p>'),
    Buffer.concat([Buffer.from([255, 254]), Buffer.from('<p>' + text + '</p>', 'utf16le')]),
  ]) {
    await importHtml(page, buffer);
    await expect(doc(page).locator('p')).toHaveText(text);
  }
  await importHtml(page, Buffer.from('<meta charset="windows-1252"><p>Gr\xfc\xdfe</p>', 'latin1'));
  await expect(doc(page).locator('p')).toHaveText('Grüße');
});
test('V01 text, images, metadata and V03 real table structure', async ({ page }) => {
  await importHtml(page, f.documentBundle());
  await expect(doc(page).locator('h1,h2')).toHaveText(['Synthetic handbook', 'End marker']);
  await expect(doc(page).locator('li')).toHaveText(['Fourth step', 'Fifth step']);
  await expect(doc(page).locator('ol')).toHaveAttribute('start', '4');
  await expect(doc(page).locator('figcaption')).toHaveText('Synthetic caption');
  await expect(doc(page).locator('td,th')).toHaveText([
    'Label',
    'Value',
    'Cell passage to revise.',
    'Another cell.',
    'Total',
    'Two',
  ]);
  await expect(doc(page).locator('#image')).toHaveAttribute('alt', 'Synthetic pixels');
  expect(
    await doc(page)
      .locator('#cell')
      .evaluate((n) => getComputedStyle(n).borderTopWidth),
  ).toBe('1px');
});
test('V02 embedded font is loaded and differs from fallback', async ({ page }) => {
  await importHtml(page, f.documentBundle());
  expect(
    await doc(page)
      .locator('body')
      .evaluate(async (body) => {
        await body.ownerDocument.fonts.ready;
        const canvas = body.ownerDocument.createElement('canvas'),
          c = canvas.getContext('2d');
        c.font = '20px FixtureFira';
        const width = c.measureText('MMMMWWWiiii').width;
        c.font = '20px monospace';
        return (
          [...body.ownerDocument.fonts].every((f) => f.status === 'loaded') &&
          width !== c.measureText('MMMMWWWiiii').width
        );
      }),
  ).toBe(true);
});
for (const size of ['a4', 'letter', 'legal'])
  for (const orientation of ['portrait', 'landscape'])
    test(`V04 layout ${size} ${orientation}`, async ({ page }) => {
      const p = f.parts();
      p.template = p.template.replace('size="a4"', `size="${size}" orientation="${orientation}"`);
      await importHtml(page, f.bundle(p.template, p.manifest));
      const widths = {
        a4: [(210 * 96) / 25.4, (297 * 96) / 25.4],
        letter: [816, 1056],
        legal: [816, 1344],
      };
      async function geometry(frame) {
        const m = await frame.locator('doc-page').evaluate((e) => ({
          width: e.getBoundingClientRect().width,
          view: e.ownerDocument.defaultView.innerWidth,
          padding: parseFloat(getComputedStyle(e).paddingLeft),
          visible: [...e.querySelectorAll('h1,h2,img')].every((n) => {
            const r = n.getBoundingClientRect(),
              s = getComputedStyle(n);
            return (
              r.width > 0 &&
              r.height > 0 &&
              r.left >= -1 &&
              r.right <= e.ownerDocument.defaultView.innerWidth + 1 &&
              s.visibility === 'visible'
            );
          }),
        }));
        const width =
          m.view <= 720
            ? m.view
            : Math.min(widths[size][orientation === 'landscape' ? 1 : 0], m.view - 32);
        expect(Math.abs(m.width - width)).toBeLessThan(2);
        expect(
          Math.abs(m.padding - (m.view <= 720 ? 24 : Math.min(48, m.view * 0.08))),
        ).toBeLessThan(2);
        expect(m.visible).toBe(true);
      }
      await geometry(doc(page));
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 800, height: 900 },
      ]) {
        await page.setViewportSize(viewport);
        await geometry(doc(page));
        expect(
          await doc(page)
            .locator('body')
            .evaluate((b) => b.scrollWidth <= b.ownerDocument.defaultView.innerWidth + 1),
        ).toBe(true);
      }
      await page.locator('#preview-button').click();
      await previewReady(page);
      await geometry(doc(page));
      await geometry(page.frameLocator('#preview-frame'));
    });
test('V05 passive DOM and V06 flowing print layout', async ({ page, browserName }) => {
  await importHtml(page, f.documentBundle());
  await expect(doc(page).locator('doc-page')).toBeVisible();
  expect(
    await doc(page)
      .locator('doc-page')
      .evaluate(
        (n) => !n.shadowRoot && !n.ownerDocument.defaultView.customElements.get('doc-page'),
      ),
  ).toBe(true);
  const tags = await doc(page)
    .locator('doc-page')
    .evaluate((n) => [n.firstElementChild.tagName, n.lastElementChild.tagName]);
  expect(tags).toEqual(['HEADER', 'FOOTER']);
  await page.emulateMedia({ media: 'print' });
  expect(
    await doc(page)
      .locator('doc-page')
      .evaluate((n) => ({
        padding: getComputedStyle(n).padding,
        shadow: getComputedStyle(n).boxShadow,
      })),
  ).toEqual({ padding: '0px', shadow: 'none' });
  await expect(doc(page).locator('#end')).toBeVisible();
  if (browserName === 'chromium') {
    const pdf = await page.pdf();
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  }
});
test('V07 internal links work and external navigation stays blocked', async ({ page }) => {
  await importHtml(page, f.documentBundle());
  await doc(page).locator('#jump').click();
  await expect
    .poll(() =>
      doc(page)
        .locator('body')
        .evaluate((b) => b.ownerDocument.defaultView.scrollY),
    )
    .toBeGreaterThan(0);
  const url = page.url();
  await doc(page).locator('#external').click();
  expect(page.url()).toBe(url);
});
