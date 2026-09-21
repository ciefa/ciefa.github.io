const {
  test,
  expect,
  open,
  openMarkdown,
  zip,
  mdDownload,
  archives,
} = require("./helpers/markdown-fixtures.cjs");
test("MD-P01 @performance workspace import export switch and active cancellation", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName !== "chromium", "Performance gates use Chromium.");
  test.setTimeout(60000);
  await page.addInitScript(() => {
    const Original = Worker;
    window.mdActive = 0;
    window.mdPosted = 0;
    window.Worker = class extends Original {
      constructor(...args) {
        super(...args);
        window.mdActive++;
      }
      terminate() {
        window.mdActive--;
        return super.terminate();
      }
      postMessage(m, ...args) {
        if (m.op === "importMarkdown") window.mdPosted++;
        return super.postMessage(m, ...args);
      }
    };
  });
  await open(page);
  const entries = Array.from({ length: 40 }, (_, i) => ({
      path: "chapters/" + String(i).padStart(2, "0") + ".md",
      text: "# Synthetic chapter\n\nSimple text for measurement.\n"
        .repeat(700)
        .slice(0, 32768),
    })),
    buffer = zip(entries);
  let start = Date.now();
  await openMarkdown(page, [{ name: "synthetic.zip", buffer }]);
  const importMs = Date.now() - start;
  expect(importMs).toBeLessThan(10000);
  start = Date.now();
  await page
    .getByRole("button", { name: "chapters/39.md", exact: true })
    .click();
  await expect(page.locator("#filename")).toHaveText("chapters/39.md");
  const switchMs = Date.now() - start;
  expect(switchMs).toBeLessThan(2000);
  start = Date.now();
  const output = archives.readZip(await mdDownload(page));
  const exportMs = Date.now() - start;
  expect(exportMs).toBeLessThan(10000);
  expect(output).toHaveLength(40);
  // Terminate a real, posted worker operation; cancellation must not wait for parsing.
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "again.zip",
      mimeType: "application/zip",
      buffer: zip(
        Array.from({ length: 8 }, (_, i) => ({
          path: i + ".md",
          text: "a".repeat(1024 * 1024),
        })),
      ),
    });
  await expect.poll(() => page.evaluate(() => window.mdPosted)).toBe(2);
  start = Date.now();
  await page.locator("#cancel-import").click();
  await expect(page.locator("#import-status")).toBeHidden();
  const cancelMs = Date.now() - start;
  expect(cancelMs).toBeLessThan(500);
  testInfo.annotations.push({
    type: "metrics",
    description: JSON.stringify({ importMs, switchMs, exportMs, cancelMs }),
  });
  console.log(
    "MD-P01",
    JSON.stringify({ importMs, switchMs, exportMs, cancelMs }),
  );
});
