const {
  test,
  expect,
  open,
  doc,
  comment,
  previewReady,
  directFile,
  zip,
  archives,
  openMarkdown,
  mdDownload,
  payload,
  withPayload,
  select,
} = require("./helpers/markdown-fixtures.cjs");
test.beforeEach(async ({ page }) => open(page));
test("MD01 MD03 MD16 multiple documents ZIP and offline saved originals", async ({
  page,
}, testInfo) => {
  const entries = [
    { path: "z/a.md", text: "# Later\r\n" },
    { path: "a/a.md", text: "\ufeff# Earlier\n\nText\n" },
    { path: "cafe\u0301.md", text: "" },
  ];
  await openMarkdown(page, [{ name: "synthetic.zip", buffer: zip(entries) }]);
  await expect(page.locator("#markdown-documents button")).toHaveText([
    "a/a.md",
    "cafe\u0301.md",
    "z/a.md",
  ]);
  expect(
    (await page.locator("#document-frame").boundingBox()).height,
  ).toBeGreaterThan(500);
  const output = archives.readZip(await mdDownload(page));
  for (const e of output)
    expect(Buffer.from(e.data)).toEqual(
      Buffer.from(entries.find((x) => x.path === e.path).text),
    );
  const saved = await mdDownload(page, "#save-button");
  expect(payload(saved).documents).toHaveLength(3);
  await directFile(page, saved, testInfo);
  await expect(page.locator("#filename")).toHaveText("a/a.md");
  const again = archives.readZip(await mdDownload(page));
  expect(again).toEqual(output);
});
test("MD02 MD04 MD05 MD06 independent edits survive switching removal and reopen", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(
    browserName === "webkit",
    "WebKit 218086 blocks source annotation listeners.",
  );
  await openMarkdown(page, [
    { name: "b.md", text: "Alpha beta\n" },
    { name: "a.md", text: "Alpha beta\n" },
  ]);
  await comment(page, {
    selector: "#markdown-source",
    start: 0,
    end: 5,
    replacement: "First",
  });
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "b.md", exact: true }).click();
  await expect(page.locator("#filename")).toHaveText("b.md");
  await expect(page.locator("#save-state")).toHaveClass(/unsaved/);
  await comment(page, {
    selector: "#markdown-source",
    start: 0,
    end: 5,
    replacement: "Second",
  });
  await previewReady(page);
  await expect(
    page.frameLocator("#preview-frame").locator("body"),
  ).toContainText("Second beta");
  let out = archives.readZip(await mdDownload(page));
  expect(Buffer.from(out[0].data).toString()).toBe("First beta\n");
  expect(Buffer.from(out[1].data).toString()).toBe("Alpha beta\n");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await page.getByRole("button", { name: "a.md", exact: true }).click();
  await expect(doc(page).locator("#markdown-source")).toHaveText(
    "First beta\n",
  );
  await comment(page, {
    selector: "#markdown-source",
    start: 0,
    end: 5,
    replacement: "Final",
  });
  const saved = await mdDownload(page, "#save-button");
  await directFile(page, saved, testInfo);
  await expect(page.locator(".card")).toHaveCount(1);
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  expect((await mdDownload(page, "#markdown-current-button")).toString()).toBe(
    "Final beta\n",
  );
  await page
    .getByRole("button", { name: "Undo acceptance", exact: true })
    .click();
  expect((await mdDownload(page, "#markdown-current-button")).toString()).toBe(
    "First beta\n",
  );
  out = archives.readZip(await mdDownload(page));
  expect(Buffer.from(out[1].data).toString()).toBe("Second beta\n");
});
test("MD07 MD08 CRLF source replacements deletion and undo", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(
    browserName === "webkit",
    "WebKit 218086 blocks source annotation listeners.",
  );
  await openMarkdown(page, [
    { name: "a.md", text: "\ufeffAlpha\r\nBeta\nTail" },
  ]);
  await comment(page, {
    selector: "#markdown-source",
    start: 0,
    end: 5,
    replacement: "One\nTwo",
  });
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  expect(await mdDownload(page, "#markdown-current-button")).toEqual(
    Buffer.from("\ufeffOne\r\nTwo\r\nBeta\nTail"),
  );
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await comment(page, { selector: "#markdown-source", replacement: "" });
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  const saved = await mdDownload(page, "#save-button");
  await directFile(page, saved, testInfo);
  await expect(page.locator(".card")).toHaveCount(1);
  expect(await mdDownload(page, "#markdown-current-button")).toEqual(
    Buffer.from("\ufeff"),
  );
  await page
    .getByRole("button", { name: "Undo acceptance", exact: true })
    .click();
  expect(await mdDownload(page, "#markdown-current-button")).toEqual(
    Buffer.from("\ufeffOne\r\nTwo\r\nBeta\nTail"),
  );
});
test("MD09 invalid inactive document is rejected without replacing workspace", async ({
  page,
}) => {
  await openMarkdown(page, [
    { name: "a.md", text: "Alpha" },
    { name: "b.md", text: "Beta" },
  ]);
  const saved = await mdDownload(page, "#save-button"),
    w = payload(saved);
  w.documents[1].source.sha256 = "0".repeat(64);
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "bad.html",
      mimeType: "text/html",
      buffer: withPayload(saved, w),
    });
  await expect(page.locator("#toast")).toContainText("invalid");
  await expect(page.locator("#filename")).toHaveText("a.md");
  await expect(page.locator("#markdown-documents button")).toHaveCount(2);
});
test("MD10 unfinished draft and unsaved workspace prompts protect edits", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "WebKit 218086 blocks source annotation listeners.",
  );
  await openMarkdown(page, [
    { name: "a.md", text: "Alpha" },
    { name: "b.md", text: "Beta" },
  ]);
  await select(page, "#markdown-source", 0, 5);
  await page.locator("#add-selection").click();
  await page.locator("#note-input").fill("Unfinished");
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "b.md", exact: true }).click();
  await expect(page.locator("#filename")).toHaveText("a.md");
  await expect(page.locator("#note-input")).toHaveValue("Unfinished");
  await page.locator("#submit-comment").click();
  page.once("dialog", (d) => d.dismiss());
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "other.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("Other"),
    });
  await expect(page.locator("#filename")).toHaveText("a.md");
  await expect(page.locator(".card")).toHaveCount(1);
});
test("MD11 MD12 bad selection/archive preserves open documents", async ({
  page,
}) => {
  await openMarkdown(page);
  for (const buffer of [
    zip([{ path: "../a.md" }]),
    zip([{ path: "a.md" }, { path: "image.png" }]),
    Buffer.from("not a ZIP"),
  ]) {
    await page
      .locator("#file-input")
      .setInputFiles({ name: "bad.zip", mimeType: "application/zip", buffer });
    await expect(page.locator("#toast")).toContainText("Could not open");
    await expect(page.locator("#import-status")).toBeHidden();
    await expect(page.locator("#filename")).toHaveText("alpha.md");
  }
  await page.locator("#file-input").setInputFiles([
    { name: "a.md", mimeType: "text/markdown", buffer: Buffer.from("A") },
    { name: "b.html", mimeType: "text/html", buffer: Buffer.from("B") },
  ]);
  await expect(page.locator("#toast")).toContainText("Choose Markdown");
});
test("MD15 preview is inert and templates remain literal", async ({ page }) => {
  const source =
    '# Safe\n\n<script>window.bad=true</script>\n\n![remote](https://example.invalid/image.png)\n\n[unsafe](javascript:alert(1))\n\n{{ example_label("some_key") }}\n\n**bold** &amp; text';
  await openMarkdown(page, [{ name: "a.md", text: source }]);
  await previewReady(page);
  const preview = page.frameLocator("#preview-frame");
  await expect(preview.locator("strong")).toHaveText("bold");
  await expect(preview.locator("body")).toContainText(
    '{{ example_label("some_key") }}',
  );
  await expect(preview.locator("img,script,iframe")).toHaveCount(0);
  await expect(preview.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.bad)).toBeUndefined();
  expect((await mdDownload(page, "#markdown-current-button")).toString()).toBe(
    source,
  );
});
test("MD06 rejected suggestions excluded and empty sources remain files", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "WebKit 218086 blocks source annotation listeners.",
  );
  await openMarkdown(page, [
    { name: "a.md", text: "Alpha" },
    { name: "empty.md", text: "" },
  ]);
  await comment(page, { selector: "#markdown-source", replacement: "Changed" });
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const output = archives.readZip(await mdDownload(page));
  expect(Buffer.from(output[0].data).toString()).toBe("Alpha");
  expect(output[1].data.length).toBe(0);
  await page.getByRole("button", { name: "empty.md", exact: true }).click();
  await expect(page.locator("#filename")).toHaveText("empty.md");
  expect(await mdDownload(page, "#markdown-current-button")).toEqual(
    Buffer.alloc(0),
  );
});
test("MD01 drag and drop receives every source", async ({ page }) => {
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["# A"], "a.md", { type: "text/markdown" }));
    data.items.add(new File(["# B"], "b.md", { type: "text/markdown" }));
    document.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.locator("#markdown-documents button")).toHaveCount(2);
  await expect(page.locator("#filename")).toHaveText("a.md");
});
