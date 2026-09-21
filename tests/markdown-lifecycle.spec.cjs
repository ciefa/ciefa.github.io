const {
  test,
  expect,
  open,
  openMarkdown,
  mdDownload,
  doc,
  comment,
  select,
  previewReady,
  zip,
  archives,
  ws,
  moduleOf,
} = require("./helpers/markdown-fixtures.cjs");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
async function instrument(page) {
  await page.addInitScript(() => {
    window.mdLive = new Set();
    window.mdURLs = new Set();
    window.mdStarted = [];
    const Original = Worker;
    window.Worker = class extends Original {
      constructor(...args) {
        super(...args);
        window.mdLive.add(this);
      }
      postMessage(message, ...args) {
        window.mdStarted.push(message.op);
        if (window.mdHold === message.op) return;
        return super.postMessage(message, ...args);
      }
      terminate() {
        window.mdLive.delete(this);
        return super.terminate();
      }
    };
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (...args) => {
      const u = create(...args);
      window.mdURLs.add(u);
      return u;
    };
    URL.revokeObjectURL = (u) => {
      window.mdURLs.delete(u);
      revoke(u);
    };
    const timeout = window.setTimeout;
    window.setTimeout = (fn, ms, ...args) =>
      timeout(
        fn,
        window.mdShortTimeout && [10000, 30000].includes(ms) ? 80 : ms,
        ...args,
      );
  });
  await open(page);
}
test("MD17 cancel import, ignore late work and preserve original review", async ({
  page,
}) => {
  await instrument(page);
  await openMarkdown(page);
  await previewReady(page);
  await page.evaluate(() => (window.mdHold = "importMarkdown"));
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "next.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("Next"),
    });
  await expect
    .poll(() => page.evaluate(() => window.mdStarted.at(-1)))
    .toBe("importMarkdown");
  await page.locator("#cancel-import").click();
  await expect(page.locator("#import-status")).toBeHidden();
  await expect(page.locator("#filename")).toHaveText("alpha.md");
  await expect.poll(() => page.evaluate(() => window.mdLive.size)).toBe(0);
  await page.evaluate(() => (window.mdHold = null));
  await openMarkdown(page, [{ name: "final.md", text: "Final" }]);
  await expect(page.locator("#filename")).toHaveText("final.md");
});
test("MD17 cancel export and retry keep workspace dirty state", async ({
  page,
}) => {
  await instrument(page);
  await openMarkdown(page);
  await previewReady(page);
  await page.evaluate(() => (window.mdHold = "exportMarkdown"));
  await page.locator("#export-menu-button").click();
  await page.locator("#markdown-zip-button").click();
  await expect
    .poll(() => page.evaluate(() => window.mdStarted.at(-1)))
    .toBe("exportMarkdown");
  await page.locator("#cancel-import").click();
  await expect(page.locator("#import-status")).toBeHidden();
  await expect(page.locator("#save-button")).toBeEnabled();
  await page.evaluate(() => (window.mdHold = null));
  expect(archives.readZip(await mdDownload(page))).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => window.mdLive.size)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.mdURLs.size)).toBe(0);
});
test("MD17 preview timeout and worker failure preserve editable source", async ({
  page,
}) => {
  await instrument(page);
  await page.evaluate(() => {
    window.mdHold = "previewMarkdown";
    window.mdShortTimeout = true;
  });
  await openMarkdown(page);
  await expect(page.locator("#preview-loading")).toContainText("unavailable");
  await expect(page.locator("#save-button")).toBeEnabled();
  await expect(doc(page).locator("#markdown-source")).toContainText(
    "Alpha beta",
  );
  await page.evaluate(() => {
    window.mdHold = null;
    window.mdShortTimeout = false;
    window.Worker = class {
      constructor() {
        throw Error("synthetic worker startup failure");
      }
    };
  });
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "b.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("B"),
    });
  await expect(page.locator("#toast")).toContainText("Could not open");
  await expect(page.locator("#filename")).toHaveText("alpha.md");
});
test("MD17 repeated switching and preview toggles keep only two permanent frames", async ({
  page,
}) => {
  await instrument(page);
  await openMarkdown(page, [
    { name: "a.md", text: "# A\n" },
    { name: "b.md", text: "# B\n" },
  ]);
  for (let i = 0; i < 8; i++) {
    const name = i % 2 ? "a.md" : "b.md";
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator("#filename")).toHaveText(name);
  }
  await previewReady(page);
  await expect(page.locator("iframe")).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => window.mdLive.size)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.mdURLs.size)).toBe(0);
});
test("MD07 source selections must preserve emoji combining and CRLF boundaries", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "WebKit 218086 blocks source annotation listeners.",
  );
  await open(page);
  await openMarkdown(page, [{ name: "a.md", text: "😀e\u0301\r\nTail" }]);
  for (const [start, end] of [
    [0, 1],
    [2, 3],
    [0, 5],
  ]) {
    await select(page, "#markdown-source", start, end);
    await page.locator("#add-selection").click();
    await expect(page.locator("#composer")).toBeHidden();
    await expect(page.locator("#toast")).toContainText("complete characters");
  }
});
test("MD10 switching back restores source scroll", async ({ page }) => {
  await open(page);
  await openMarkdown(page, [
    { name: "a.md", text: "Long line\n".repeat(500) },
    { name: "b.md", text: "Short" },
  ]);
  await previewReady(page);
  await page.locator("#sync-scroll").uncheck();
  await page
    .locator("#document-frame")
    .evaluate((f) => f.contentWindow.scrollTo(0, 500));
  await page.getByRole("button", { name: "b.md", exact: true }).click();
  await expect(page.locator("#filename")).toHaveText("b.md");
  await page.getByRole("button", { name: "a.md", exact: true }).click();
  await expect(page.locator("#filename")).toHaveText("a.md");
  await expect
    .poll(() =>
      page.locator("#document-frame").evaluate((f) => f.contentWindow.scrollY),
    )
    .toBe(500);
});
test("MD14 source size equality and workspace aggregate limits", async ({
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Production size limits run once.");
  const exact = Buffer.alloc(1024 * 1024, 97);
  expect((await ws.decodeSource(exact)).byteLength).toBe(exact.length);
  await expect(
    ws.decodeSource(Buffer.alloc(exact.length + 1, 97)),
  ).rejects.toThrow("MD_LIMIT");
  await expect(
    ws.create(
      Array.from({ length: 9 }, (_, i) => ({ path: i + ".md", data: exact })),
    ),
  ).rejects.toThrow("MD_LIMIT");
  const w = await ws.create([{ path: "a.md", data: Buffer.from("A") }]);
  w.documents[0].runs[0].text = "B".repeat(2 * 1024 * 1024);
  expect(() => ws.validate(w)).not.toThrow();
  w.documents[0].runs[0].text += "B";
  expect(() => ws.validate(w)).toThrow();
});
test("MD18 build boundaries, deterministic artifacts and offline notices", async ({
  page,
}) => {
  const { generateMarkdownArtifacts, replaceMarkdownRegion } = await import(
    pathToFileURL(path.resolve(__dirname, "../scripts/build-markdown.mjs")).href
  );
  const a = await generateMarkdownArtifacts(),
    b = await generateMarkdownArtifacts();
  expect(a).toEqual(b);
  expect(a.licenses).toContain("fflate@0.8.3");
  expect(a.licenses).toContain("micromark@4.0.2");
  expect(a.licenses).toContain("character-entities@");
  for (const html of [
    "<!-- MD GENERATED START -->",
    "<!-- MD GENERATED END --><!-- MD GENERATED START -->",
    a.region + a.region,
  ])
    expect(() => replaceMarkdownRegion(html, a.region)).toThrow();
  await open(page);
  expect(await page.locator("#markdown-licenses").textContent()).toContain(
    "Permission is hereby granted",
  );
});
