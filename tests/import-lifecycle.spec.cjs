const {
  test,
  expect,
  open,
  importHtml,
  doc,
  select,
  comment,
  state,
} = require('./helpers/reviewer.cjs');
const f = require('./helpers/bundle-fixtures.cjs');
test.beforeEach(async ({ page }) => {
  await open(page);
  await importHtml(page, f.plain(), 'current.html');
});
async function draft(page) {
  await comment(page, { selector: '#p1', note: 'Existing comment' });
  await select(page, '#p0');
  await page.locator('#add-selection').click();
  await page.locator('#note-input').fill('Unfinished draft');
}
async function deferRead(page) {
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    window.pendingReads = new Map();
    File.prototype.arrayBuffer = function () {
      const self = this;
      if (this.name.startsWith('slow'))
        return new Promise((resolve, reject) =>
          window.pendingReads.set(this.name, {
            release: () => resolve(original.call(self)),
            reject: () => reject(new Error('Delayed failure')),
          }),
        );
      return original.call(this);
    };
  });
}
async function choose(page, name, html = f.plain()) {
  await page
    .locator('#file-input')
    .setInputFiles({ name, mimeType: 'text/html', buffer: Buffer.from(html) });
}
test('L01 dismiss discard preserves complete draft and model', async ({ page }) => {
  await draft(page);
  const before = await state(page);
  page.once('dialog', (d) => d.dismiss());
  await choose(page, 'replacement.html', f.documentBundle());
  expect(await state(page)).toEqual(before);
  await page.locator('#submit-comment').click();
  await expect(page.locator('.card')).toHaveCount(2);
});
for (const [name, html, message] of [
  ['resource reference', f.bundle('<img src="missing.png">'), 'not embedded'],
  [
    'gzip',
    f.bundle('<img src="' + f.uuid(1) + '">', {
      [f.uuid(1)]: { mime: 'image/png', compressed: true, data: f.png().toString('base64') },
    }),
    'could not be decoded',
  ],
  [
    'image decoding',
    f.bundle('<img src="' + f.uuid(1) + '">', {
      [f.uuid(1)]: f.asset(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    }),
    'could not be decoded',
  ],
  [
    'font decoding',
    f.bundle(
      '<style>@font-face{font-family:Broken;src:url(' + f.uuid(1) + ')}</style><p>Text</p>',
      { [f.uuid(1)]: f.asset(Buffer.from('wOF2garbage'), 'font/woff2') },
    ),
    'could not be decoded',
  ],
])
  test('L02 failed ' + name + ' preserves draft anchors', async ({ page }) => {
    await draft(page);
    page.on('dialog', (d) => d.accept());
    const before = await state(page);
    await choose(page, 'invalid.html', html);
    await expect(page.locator('#toast')).toContainText(message);
    await expect(page.locator('#import-status')).toBeHidden();
    expect(await state(page)).toEqual(before);
    await page.locator('#submit-comment').click();
    await expect(doc(page).locator('#p0 mark')).toHaveCount(1);
  });
test('L03 cancel pending read and retain candidate identity at commit', async ({ page }) => {
  await draft(page);
  page.on('dialog', (d) => d.accept());
  await deferRead(page);
  const before = await state(page);
  await choose(page, 'slow-cancel.html');
  await expect(page.locator('#import-status')).toBeVisible();
  await page.locator('#cancel-import').click();
  await expect(page.locator('#import-status')).toBeHidden();
  expect(await state(page)).toEqual(before);
  await page.evaluate(() => window.pendingReads.get('slow-cancel.html').release());
  await page.locator('#submit-comment').click();
  await page.evaluate(() => {
    new MutationObserver(() => {
      const f = document.querySelector('#import-candidate-frame');
      if (f && !f.dataset.watched) {
        f.dataset.watched = 'yes';
        f.addEventListener('load', () => {
          window.candidateDocument = f.contentDocument;
          window.candidateLoads = (window.candidateLoads || 0) + 1;
        });
      }
    }).observe(document.querySelector('.document-stage'), { childList: true });
  });
  await importHtml(page, f.documentBundle());
  expect(
    await page.evaluate(
      () =>
        window.candidateDocument === document.querySelector('#document-frame').contentDocument &&
        window.candidateLoads === 1,
    ),
  ).toBe(true);
});
test('L04 latest file or example wins over delayed success or failure', async ({ page }) => {
  await deferRead(page);
  for (const action of ['release', 'reject']) {
    await choose(page, 'slow-' + action + '.html');
    await expect(page.locator('#import-status')).toBeVisible();
    await importHtml(page, f.documentBundle(), 'winner-' + action + '.html');
    await page.evaluate(({ name, action }) => window.pendingReads.get(name)[action](), {
      name: 'slow-' + action + '.html',
      action,
    });
    await expect(page.locator('#filename')).toHaveText('winner-' + action + '.html');
    await expect(page.locator('#import-status')).toBeHidden();
  }
  await choose(page, 'slow-example.html');
  await page.locator('#demo-button').evaluate((b) => b.click());
  await expect(page.locator('#filename')).toHaveText('example-handbook.html');
  await page.evaluate(() => window.pendingReads.get('slow-example.html').release());
  await expect(page.locator('#filename')).toHaveText('example-handbook.html');
});
test('L05 busy controls, shortcuts, help and escape', async ({ page }) => {
  await deferRead(page);
  await choose(page, 'slow-ui.html');
  await expect(page.locator('#workspace')).toHaveAttribute('aria-busy', 'true');
  for (const id of ['save-button', 'clean-button', 'preview-button', 'add-selection'])
    await expect(page.locator('#' + id)).toBeDisabled();
  await expect(page.locator('#open-button')).toBeEnabled();
  await page.keyboard.press('Control+s');
  await page.locator('#help-button').click();
  await expect(page.locator('#help-dialog')).toBeVisible();
  await page.locator('#close-help').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#import-status')).toBeHidden();
  await expect(page.locator('#filename')).toHaveText('current.html');
  await page.evaluate(() => window.pendingReads.get('slow-ui.html').release());
});
test('L06 timeouts roll back and invalid second file does not cancel job', async ({ page }) => {
  await page.clock.install();
  await importHtml(page, f.plain(), 'current.html');
  await deferRead(page);
  await choose(page, 'slow-timeout.html');
  await page.locator('#file-input').setInputFiles({
    name: 'invalid.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Synthetic text'),
  });
  await expect(page.locator('#toast')).toContainText('Choose an');
  await expect(page.locator('#import-status')).toBeVisible();
  await page.clock.fastForward(30001);
  await expect(page.locator('#toast')).toContainText('took too long');
  await expect(page.locator('#import-status')).toBeHidden();
  await expect(page.locator('#filename')).toHaveText('current.html');
  await page.evaluate(() => window.pendingReads.get('slow-timeout.html').release());
});
