const {
  test,
  expect,
  open,
  simple,
  eligible,
  comment,
  doc,
  download,
  payload,
  withPayload,
  originalDownload,
  attach,
  templateOf,
  directFile,
  originalDialog,
} = require("./helpers/roundtrip-fixtures.cjs");
test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "WebKit 218086 blocks review listeners.");
  await open(page);
});
test("RT03 accept remove re-edit save reopen accept and undo restores retained wording", async ({
  page,
}, testInfo) => {
  const source = simple();
  await eligible(page, source);
  await comment(page, { start: 6, end: 10, replacement: "Edited" });
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(doc(page).locator("#p0")).toHaveText("Alpha Edited Omega");
  await comment(page, { start: 6, end: 12, replacement: "Final" });
  const saved = await download(page, "#save-button");
  await directFile(page, saved, testInfo);
  await expect(page.locator(".card")).toHaveCount(1);
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await attach(page, source);
  expect(templateOf(await originalDownload(page))).toContain(
    "Alpha Final Omega",
  );
  await page.locator("#original-cancel-button").click();
  await page
    .getByRole("button", { name: "Undo acceptance", exact: true })
    .click();
  await expect(doc(page).locator("#p0")).toHaveText("Alpha Edited Omega");
  expect(templateOf(await originalDownload(page))).toContain(
    "Alpha Edited Omega",
  );
});
test("RT07 deleted unit survives save, undo and accepted removal", async ({
  page,
}, testInfo) => {
  const source = simple('<p id="p0">word</p>');
  await eligible(page, source);
  await comment(page, { replacement: "" });
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  const saved = await download(page, "#save-button");
  expect(payload(saved).units[0].runs[0].text).toBe("");
  await directFile(page, saved, testInfo);
  await expect(page.locator(".card")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Undo acceptance", exact: true })
    .click();
  await expect(doc(page).locator("#p0")).toHaveText("word");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  expect(payload(await download(page, "#save-button")).units[0].runs).toEqual([
    { kind: "text", text: "" },
  ]);
  await attach(page, source);
  expect(templateOf(await originalDownload(page))).toContain('<p id="p0"></p>');
});
test("RT11 RT22 three offline cycles retain adjacent source identities", async ({
  page,
}, testInfo) => {
  const source = simple(
    '<p id="p0">A<script>window.mustNotRun=true</script>B</p>',
  );
  await eligible(page, source);
  for (let i = 0; i < 3; i++) {
    await page
      .locator("#document-frame")
      .evaluate((f) => f.contentDocument.body.normalize());
    const saved = await download(page, "#save-button"),
      p = payload(saved);
    expect(p.units.map((u) => u.original)).toEqual(["A", "B"]);
    expect(p).not.toHaveProperty("documentHtml");
    expect(p.units[0]).not.toHaveProperty("path");
    if (i % 2 === 0) {
      await directFile(page, saved, testInfo, "cycle" + i);
      await expect(doc(page).locator("#p0")).toHaveText("AB");
    } else await eligible(page, saved, "review.html");
  }
  await comment(page, { start: 1, end: 2, replacement: "Final" });
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await attach(page, source);
  expect(templateOf(await originalDownload(page))).toContain(
    "A<script>window.mustNotRun=true</script>Final",
  );
});
test("RT20 source identity alone cannot bless a tampered projection", async ({
  page,
}, testInfo) => {
  const source = simple('<p id="p0">Alpha</p><p id="p1">Bravo</p>');
  await eligible(page, source);
  const saved = await download(page, "#save-button"),
    p = payload(saved);
  p.baseHtml = p.baseHtml.replace('id="p0"', 'id="p0" style="color:red"');
  await directFile(page, withPayload(saved, p), testInfo, "tampered");
  await expect(doc(page).locator("#p0")).toHaveText("Alpha");
  await originalDialog(page);
  await page.locator("#original-source-input").setInputFiles({
    name: "original.html",
    mimeType: "text/html",
    buffer: Buffer.from(source),
  });
  await expect(page.locator("#original-export-progress")).toContainText(
    "does not reproduce",
  );
  await expect(page.locator("#original-download-button")).toBeDisabled();
});
test("RT21 corrupt saved model does not replace current review", async ({
  page,
}) => {
  await eligible(page);
  const saved = await download(page, "#save-button"),
    p = payload(saved);
  p.units[0].start++;
  await page.locator("#file-input").setInputFiles({
    name: "invalid.html",
    mimeType: "text/html",
    buffer: Buffer.from(withPayload(saved, p)),
  });
  await expect(page.locator("#toast")).toContainText(
    "saved text mappings are invalid",
  );
  await expect(doc(page).locator("#p0")).toHaveText("Alpha word Omega");
});
test("RT01 resolve and accept-undo leave the original byte identical", async ({
  page,
}) => {
  const source = simple(undefined, { bom: true, crlf: true });
  await eligible(page, source);
  await comment(page, { start: 0, end: 5, note: "Resolved comment" });
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await comment(page, { start: 6, end: 10, replacement: "Changed" });
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await page
    .getByRole("button", { name: "Undo acceptance", exact: true })
    .click();
  expect(await originalDownload(page)).toEqual(Buffer.from(source));
});
test("RT22 saved review moves between fresh Chromium and Firefox contexts offline", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(
    browserName !== "chromium",
    "Run the cross-engine transfer once with both engines.",
  );
  const { firefox, chromium } = require("@playwright/test");
  const source = simple();
  await eligible(page, source);
  await comment(page, { start: 6, end: 10, replacement: "Portable" });
  let saved = await download(page, "#save-button");
  for (let i = 0; i < 3; i++) {
    const browser = await (i % 2 ? chromium : firefox).launch(),
      context = await browser.newContext({
        offline: true,
        acceptDownloads: true,
      }),
      next = await context.newPage();
    const errors = [];
    next.on("pageerror", (e) => errors.push(e.message));
    try {
      await directFile(next, saved, testInfo, "cross-engine-" + i);
      await expect(next.locator(".card")).toHaveCount(1);
      await expect(doc(next).locator("#p0")).toHaveText("Alpha word Omega");
      saved = await download(next, "#save-button");
      expect(payload(saved).units[0].runs[1].text).toBe("word");
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }
});
test("RT12 literal CR survives acceptance, preview, save, static export and new baseline", async ({
  page,
}, testInfo) => {
  const source = simple('<p id="p0">word</p>');
  await eligible(page, source);
  await comment(page, { replacement: "x\ry" });
  // A textarea normalizes line endings; exercise a literal CR through the actual
  // validated model in the portable payload, as another reviewer may supply it.
  let saved = await download(page, "#save-button"),
    value = payload(saved);
  value.comments[0].replacement = "x\ry";
  saved = withPayload(saved, value);
  await directFile(page, saved, testInfo, "cr-review");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  expect(await doc(page).locator("#p0").textContent()).toBe("x\ry");
  const next = await download(page, "#save-button");
  await directFile(page, next, testInfo, "cr-accepted");
  await expect(page.locator(".card")).toHaveCount(1);
  expect(await doc(page).locator("#p0").textContent()).toBe("x\ry");
  await page.locator("#preview-button").click();
  await expect.poll(() => page.frameLocator("#preview-frame").locator("#p0").textContent()).toBe("x\ry");
  const staticOut = await download(page, "#clean-button");
  expect(staticOut.toString()).toContain("x&#13;y");
  await attach(page, source);
  const restored = await originalDownload(page);
  await page.locator("#original-cancel-button").click();
  await eligible(page, restored, "new-baseline.html");
  expect(await doc(page).locator("#p0").textContent()).toBe("x\ry");
});
