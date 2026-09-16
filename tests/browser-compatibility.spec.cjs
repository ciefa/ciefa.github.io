const { test, expect, open, importHtml } = require('./helpers/reviewer.cjs');
const f = require('./helpers/bundle-fixtures.cjs');

test('K01 sandbox permits parent-owned review event handlers', async ({ page, browserName }) => {
  test.fail(browserName === 'webkit', 'https://bugs.webkit.org/show_bug.cgi?id=218086');
  await open(page);
  await importHtml(page, f.plain());
  const handled = await page.evaluate(() => {
    const doc = document.querySelector('#document-frame').contentDocument;
    let handled = false;
    const listener = () => {
      handled = true;
    };
    doc.addEventListener('synthetic-review-event', listener);
    doc.dispatchEvent(new Event('synthetic-review-event'));
    doc.removeEventListener('synthetic-review-event', listener);
    return handled;
  });
  await expect(page.locator('#browser-notice'))[handled ? 'toBeHidden' : 'toBeVisible']();
  expect(handled).toBe(true);
});
