const {
  test,
  expect,
  open,
  importHtml,
  doc,
  select,
  comment,
  download,
  previewReady,
  directFile,
  root,
} = require('./helpers/reviewer.cjs');
const { appLimits } = require('./helpers/importer.cjs');
const f = require('./helpers/bundle-fixtures.cjs');
const fs = require('node:fs');
const path = require('node:path');
test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await open(page);
  await importHtml(page, f.documentBundle());
});
test('A01 mouse selection, plain comment, resolve, reopen, edit, remove', async ({
  page,
  browserName,
  context,
}) => {
  const box = await page.locator('#document-frame').evaluate((frame) => {
    const d = frame.contentDocument,
      n = d.querySelector('#p0').firstChild,
      r = d.createRange();
    r.setStart(n, 0);
    r.setEnd(n, 5);
    const a = r.getBoundingClientRect(),
      b = frame.getBoundingClientRect();
    return { x: b.x + a.x, y: b.y + a.y, w: a.width, h: a.height };
  });
  // Chromium's Playwright drag detector schedules a timer inside the script-free
  // sandbox. Send native pointer input directly so that detector cannot hang.
  if (browserName === 'chromium') {
    const cdp = await context.newCDPSession(page),
      y = box.y + box.h / 2;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 1, y });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x + 1,
      y,
      button: 'left',
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: box.x + box.w - 1,
      y,
      button: 'left',
      buttons: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x + box.w - 1,
      y,
      button: 'left',
      clickCount: 1,
    });
    await cdp.detach();
  } else {
    await page.mouse.move(box.x + 1, box.y + box.h / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w - 1, box.y + box.h / 2, { steps: 8 });
    await page.mouse.up();
  }
  await expect(page.locator('#add-selection')).toBeEnabled();
  await page.locator('#add-selection').click();
  await expect(page.locator('#selected-quote')).toHaveText('Alpha');
  await page.locator('#note-input').fill('Mouse comment');
  await page.locator('#submit-comment').click();
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.locator('.badge')).toHaveText('Resolved');
  await expect(page.locator('#comment-count')).toHaveText('1 · 0 open');
  await page.locator('#comment-filter').selectOption('open');
  await expect(page.locator('.card')).toHaveCount(0);
  await page.locator('#comment-filter').selectOption('all');
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#note-input').fill('Edited note');
  await page.locator('#submit-comment').click();
  await expect(page.locator('.note-text')).toHaveText('Edited note');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('.card')).toHaveCount(0);
});
test('A02 keyboard selection and Unicode suggestion', async ({ page }) => {
  const quote = 'Alpha Grüße 👩‍💻 é';
  await importHtml(page, '<p id="unicode">' + quote + '</p>');
  await doc(page).locator('#unicode').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+Alt+m');
  await expect(page.locator('#composer')).toBeVisible();
  await expect(page.locator('#selected-quote')).toHaveText(quote);
  await page.locator('#note-input').fill('Keyboard note');
  await page.locator('#suggest-toggle').check();
  await page.locator('#replacement-input').fill('Überarbeitet 👩‍💻');
  await page.locator('#submit-comment').click();
  await expect(doc(page).locator('mark')).toHaveText(quote);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(doc(page).locator('#unicode')).toHaveText('Überarbeitet 👩‍💻');
});
test('A03 replacement across inline formatting and exact undo', async ({ page }) => {
  const original = await doc(page).locator('#rich').textContent();
  await comment(page, { selector: '#p1', note: 'Unrelated anchor' });
  await comment(page, { selector: '#rich', start: 7, end: 33, replacement: 'New wording' });
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(doc(page).locator('#rich b')).toContainText('New wording');
  await page.getByRole('button', { name: 'Undo acceptance', exact: true }).click();
  await expect(doc(page).locator('#rich')).toHaveText(original);
  await expect(doc(page).locator('#rich b')).toHaveText('bold words');
  await expect(doc(page).locator('#rich i')).toHaveText('italic words');
  await expect(doc(page).locator('#p1 mark')).toHaveText(
    'First adjacent paragraph for a broad comment.',
  );
});
test('A04 multi-paragraph comments and V03 multi-cell replacement restriction', async ({
  page,
}) => {
  await select(page, '#p1', 0, null, '#p2');
  await page.locator('#add-selection').click();
  await expect(page.locator('#suggest-toggle')).toBeDisabled();
  await page.locator('#note-input').fill('Both paragraphs');
  await page.locator('#submit-comment').click();
  const saved = await download(page, '#save-button');
  await importHtml(page, saved);
  await expect(doc(page).locator('mark[data-hr-id]')).toHaveCount(2);
  await select(page, '#cell', 0, null, '#cell2');
  await page.locator('#add-selection').click();
  await expect(page.locator('#suggest-toggle')).toBeDisabled();
  await page.locator('#cancel-comment').click();
  await comment(page, { selector: '#cell', replacement: 'Cell revision' });
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(doc(page).locator('#cell')).toHaveText('Cell revision');
});
test('A05 repeated passages and overlap prevention', async ({ page }) => {
  await comment(page, { selector: '#repeat', start: 19, end: 37, replacement: 'Second changed.' });
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(doc(page).locator('#repeat')).toHaveText('Repeated sentence. Second changed.');
  await page.getByRole('button', { name: 'Undo acceptance', exact: true }).click();
  await select(page, '#repeat', 19, 37);
  await page.locator('#add-selection').click();
  await expect(page.locator('#toast')).toContainText('overlaps');
  await expect(page.locator('.card')).toHaveCount(1);
});
test('A06 deletion remains reversible and targetable', async ({ page }) => {
  const original = await doc(page).locator('#p0').textContent();
  await comment(page, { replacement: '' });
  await page.locator('#preview-button').click();
  await previewReady(page);
  await expect(page.frameLocator('#preview-frame').locator('#p0')).toHaveText('');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(doc(page).locator('#p0 mark')).toBeVisible();
  await page.getByRole('button', { name: 'Undo acceptance', exact: true }).click();
  await expect(doc(page).locator('#p0')).toHaveText(original);
});
test('A07 decision semantics and plain comments in preview', async ({ page }) => {
  await comment(page, { replacement: 'Changed text' });
  await page.locator('#preview-button').click();
  await previewReady(page);
  await expect(doc(page).locator('#p0')).toContainText('Alpha');
  await expect(page.frameLocator('#preview-frame').locator('#p0')).toHaveText('Changed text');
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.frameLocator('#preview-frame').locator('#p0')).toContainText('Alpha');
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(page.frameLocator('#preview-frame').locator('#p0')).toHaveText('Changed text');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(doc(page).locator('#p0')).toHaveText('Changed text');
  await comment(page, { selector: '#p1', note: 'Plain comment' });
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.frameLocator('#preview-frame').locator('#p1')).toHaveText(
    'First adjacent paragraph for a broad comment.',
  );
});
async function scrollingFixture(page) {
  await importHtml(
    page,
    f.bundle(
      '<style>body{font:16px/1.6 sans-serif;padding:20px}p{min-height:180px}</style>' +
        Array.from(
          { length: 50 },
          (_, i) =>
            `<p id="p${i}">Paragraph ${i}. ${'Words to read. '.repeat(25)}</p>` +
            (i % 10 === 0
              ? `<img src="data:image/png;base64,${f.png().toString('base64')}" width="80" height="60" alt="Scroll fixture">`
              : ''),
        ).join(''),
    ),
  );
  await comment(page, { selector: '#p20', replacement: 'Changed words. '.repeat(150) });
  await page.locator('#preview-button').click();
  await previewReady(page);
}
async function scroll(page, id, pane = 'document-frame') {
  await page
    .locator('#' + pane)
    .evaluate(
      (f, id) =>
        f.contentDocument
          .getElementById(id)
          .scrollIntoView({ block: 'start', behavior: 'instant' }),
      id,
    );
}
test('A08 linked scroll at top, middle and bottom', async ({ page }) => {
  await scrollingFixture(page);
  await scroll(page, 'p10');
  await expect
    .poll(() =>
      page
        .locator('#preview-frame')
        .evaluate((f) =>
          Math.abs(f.contentDocument.getElementById('p10').getBoundingClientRect().top),
        ),
    )
    .toBeLessThan(32);
  for (const top of [0, 1e9]) {
    await page
      .locator('#document-frame')
      .evaluate((f, top) => f.contentWindow.scrollTo(0, top), top);
    await expect
      .poll(() =>
        page.locator('#preview-frame').evaluate((f, top) => {
          const w = f.contentWindow,
            d = f.contentDocument;
          return Math.abs(
            top === 0 ? w.scrollY : d.scrollingElement.scrollHeight - w.innerHeight - w.scrollY,
          );
        }, top),
      )
      .toBeLessThan(2);
  }
  const stable = await page.locator('#preview-frame').evaluate(async (f) => {
    const w = f.contentWindow,
      values = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      values.push(w.scrollY);
    }
    return Math.max(...values) - Math.min(...values);
  });
  expect(stable).toBeLessThanOrEqual(1);
});
test('A09 independent scrolling and preview position preservation', async ({ page }) => {
  await scrollingFixture(page);
  await page.locator('#sync-scroll').uncheck();
  await scroll(page, 'p10', 'preview-frame');
  const left = await page.locator('#document-frame').evaluate((f) => f.contentWindow.scrollY);
  await scroll(page, 'p11', 'preview-frame');
  expect(await page.locator('#document-frame').evaluate((f) => f.contentWindow.scrollY)).toBe(left);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#replacement-input').fill('Different wording');
  await page.locator('#submit-comment').click();
  await expect(page.frameLocator('#preview-frame').locator('#p20')).toHaveText('Different wording');
  expect(
    await page
      .locator('#preview-frame')
      .evaluate((f) =>
        Math.abs(f.contentDocument.getElementById('p11').getBoundingClientRect().top),
      ),
  ).toBeLessThan(32);
});
test('A10 latest preview wins after rapid decisions', async ({ page }) => {
  await comment(page, { replacement: 'Final replacement' });
  await page.locator('#preview-button').click();
  for (let i = 0; i < 5; i++) {
    await page.getByRole('button', { name: 'Accept', exact: true }).click();
    await page.getByRole('button', { name: 'Undo acceptance', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.frameLocator('#preview-frame').locator('#p0')).toHaveText('Final replacement');
  await previewReady(page);
  await expect(page.locator('#preview-status')).toHaveText('No pending replacements');
  await expect(page.locator('.badge')).toHaveText('Accepted');
});
async function mixedReview(page) {
  await comment(page, { replacement: 'ACCEPTED TEXT' });
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await comment(page, { selector: '#p1', replacement: 'PENDING TEXT' });
  await comment(page, { selector: '#p2', replacement: 'REJECTED TEXT' });
  await page.getByRole('button', { name: 'Reject', exact: true }).last().click();
  await comment(page, { selector: '#cell', note: 'Plain note' });
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
}
test('S01 offline annotated reopen through file and importer across three cycles', async ({
  page,
  browser,
}, testInfo) => {
  await mixedReview(page);
  await page.locator('#preview-button').click();
  await page.locator('#sync-scroll').uncheck();
  let saved = await download(page, '#save-button');
  await page.context().close();
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext({ offline: true, serviceWorkers: 'block' }),
      p = await ctx.newPage();
    const requests = [];
    await ctx.route(/^https?:/, (r) => {
      requests.push(r.request().url());
      return r.abort();
    });
    if (i === 1) {
      await open(p);
      await importHtml(p, saved);
    } else await directFile(p, saved, testInfo, 'cycle-' + i);
    await expect(p.locator('.badge')).toHaveText(['Accepted', 'Open', 'Rejected', 'Resolved']);
    await expect(doc(p).locator('#p0')).toHaveText('ACCEPTED TEXT');
    await expect(p.locator('#sync-scroll')).not.toBeChecked();
    await expect(doc(p).locator('style[data-hri-layout]')).toHaveCount(1);
    expect(
      await doc(p)
        .locator('body')
        .evaluate(async (b) => {
          await Promise.all([...b.ownerDocument.images].map((i) => i.decode()));
          await Promise.all([...b.ownerDocument.fonts].map((f) => f.load()));
          return [...b.ownerDocument.images].every((i) => i.naturalWidth > 0);
        }),
    ).toBe(true);
    saved = await download(p, '#save-button');
    expect(requests).toEqual([]);
    await ctx.close();
  }
});
test('S02 revised export applies only accepted suggestions and S04 portable resources', async ({
  page,
  browser,
}, testInfo) => {
  await mixedReview(page);
  const revised = await download(page, '#clean-button'),
    annotated = await download(page, '#save-button');
  await page.context().close();
  const ctx = await browser.newContext({ offline: true, serviceWorkers: 'block' }),
    p = await ctx.newPage();
  await directFile(p, revised, testInfo, 'revised');
  await expect(p.locator('#p0')).toHaveText('ACCEPTED TEXT');
  await expect(p.locator('#p1')).toHaveText('First adjacent paragraph for a broad comment.');
  await expect(p.locator('mark[data-hr-id],script')).toHaveCount(0);
  await expect(p.locator('style[data-hri-layout]')).toHaveCount(1);
  await expect(p.locator('#external')).toHaveAttribute(
    'href',
    'https://example.invalid/destination',
  );
  expect(revised.toString()).not.toContain('blob:');
  await open(p);
  await importHtml(p, revised);
  await expect(p.locator('.card')).toHaveCount(0);
  await importHtml(p, annotated);
  expect(
    await p.evaluate(() => {
      const v = JSON.parse(document.querySelector('#review-data').textContent);
      return v;
    }),
  ).toBeNull();
  expect(
    await doc(p)
      .locator('body')
      .evaluate((b) => !b.querySelector('script')),
  ).toBe(true);
  await ctx.close();
});
test('S03 dangerous-looking comment text stays literal and Unicode survives', async ({
  page,
  browser,
}, testInfo) => {
  const literal = '</script><script>window.sourceRan=true</script> & " \u2028 \u2029 Grüße 👩‍💻 é';
  await comment(page, { selector: '#unicode', note: literal, replacement: literal });
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  const saved = await download(page, '#save-button');
  await page.context().close();
  const ctx = await browser.newContext({ offline: true }),
    p = await ctx.newPage();
  await directFile(p, saved, testInfo, 'literal');
  await expect(p.locator('.note-text')).toHaveText(literal);
  expect(await doc(p).locator('#unicode').textContent()).toBe(literal);
  expect(await p.evaluate(() => window.sourceRan)).toBeUndefined();
  await ctx.close();
});
test('S05 oversized serialization does not clear dirty state', async ({ page }) => {
  await appLimits(page, { MAX_DOWNLOAD_BYTES: 1024 });
  await importHtml(page, f.plain());
  await comment(page, { replacement: 'Changed' });
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.locator('#save-button').click();
  await expect(page.locator('#toast')).toContainText('too large to download');
  await expect(page.locator('#save-state')).toHaveClass(/unsaved/);
  expect(downloads).toBe(0);
  await expect(page.locator('.card')).toHaveCount(1);
});
test('S06 saved legacy states remain valid', async ({ page, browser }, testInfo) => {
  await importHtml(page, fs.readFileSync(path.join(root, 'tests/fixtures/legacy-review.html')));
  await expect(page.locator('.badge')).toHaveText([
    'Accepted',
    'Open',
    'Rejected',
    'Resolved',
    'Open',
  ]);
  const saved = await download(page, '#save-button');
  const ctx = await browser.newContext(),
    p = await ctx.newPage();
  await directFile(p, saved, testInfo, 'legacy-new');
  await expect(p.locator('.badge')).toHaveText([
    'Accepted',
    'Open',
    'Rejected',
    'Resolved',
    'Open',
  ]);
  await expect(doc(p).locator('#p0')).toHaveText('Replacement 0');
  await ctx.close();
});
