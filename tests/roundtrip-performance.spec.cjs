const {
  test,
  expect,
  open,
  large,
  eligible,
  download,
  payload,
  withPayload,
  worker,
  originalDownload,
  attach,
  originalDialog,
  doc,
  previewReady,
  simple,
  importHtml,
} = require("./helpers/roundtrip-fixtures.cjs");
const os = require("node:os");
let source;
test.use({ trace: "off", screenshot: "off" });
test.beforeEach(async ({ page, browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium",
    "Production performance gates use Chromium",
  );
  test.setTimeout(240000);
  source ||= large();
  await open(page);
  testInfo.annotations.push({
    type: "machine",
    description: JSON.stringify({
      browser: page.context().browser().version(),
      cpu: os.cpus()[0]?.model,
      os: os.release(),
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    }),
  });
});
test("RT-P01 @performance production import, retained edits, cached and reattached export", async ({
  page,
}, testInfo) => {
  expect(Buffer.byteLength(source)).toBe(18314105);
  let start = Date.now();
  await eligible(page, source);
  const importMs = Date.now() - start;
  expect(importMs).toBeLessThanOrEqual(10000);
  const saved = await download(page, "#save-button"),
    value = payload(saved),
    info = await worker(page, "validateTemplate", {
      source: value.source,
      units: value.units,
    });
  expect(info.ok).toBe(true);
  const prepared = await page.evaluate(
    ({ value, units }) => {
      const context = {
        sourceUnits: units,
        unitOrder: roundTripDom.slots(
          new DOMParser().parseFromString(value.baseHtml, "text/html"),
          units,
        ).unitOrder,
      };
      let model = value;
      const act = (a) =>
        (model = roundTripModel.transition(model, a, context).model);
      const targets = model.units
        .filter((u) => u.original.startsWith("Synthetic paragraph"))
        .slice(0, 120);
      targets.forEach((u, i) => {
        const id = "hr-" + i.toString(16).padStart(20, "0");
        act({
          type: "add",
          id,
          quote: u.original,
          note: "Synthetic performance note " + i,
          replacement: "Revised paragraph " + i,
          canReplace: true,
          slices: [{ unit: u.id, run: 0, start: 0, end: u.original.length }],
        });
        if (i < 100) act({ type: "decide", id, status: "accepted" });
        if (i < 20) act({ type: "remove", id });
      });
      return model;
    },
    { value, units: info.result.units },
  );
  expect(prepared.comments).toHaveLength(100);
  expect(
    prepared.units.filter(
      (u) => u.runs.map((r) => r.text).join("") !== u.original,
    ),
  ).toHaveLength(100);
  await eligible(page, withPayload(saved, prepared), "performance-review.html");
  start = Date.now();
  await attach(page, source);
  await originalDownload(page);
  const reattachMs = Date.now() - start;
  expect(reattachMs).toBeLessThanOrEqual(15000);
  await page.locator("#original-cancel-button").click();
  start = Date.now();
  const out = await originalDownload(page);
  const cachedMs = Date.now() - start;
  expect(cachedMs).toBeLessThanOrEqual(10000);
  await expect(page.locator("#original-export-counts")).toContainText(
    "80 accepted suggestions · Text fragments changed: 100",
  );
  expect(out.length).toBeGreaterThan(18000000);
  await page.locator("#original-cancel-button").click();
  start = Date.now();
  await page.locator("#preview-button").click();
  await previewReady(page);
  const previewMs = Date.now() - start;
  expect(previewMs).toBeLessThanOrEqual(5000);
  const accept = page
    .getByRole("button", { name: "Accept", exact: true })
    .first();
  await accept.scrollIntoViewIfNeeded();
  await accept.hover();
  start = Date.now();
  await accept.click();
  await expect(
    page.frameLocator("#preview-frame").locator("#p100 mark"),
  ).toHaveAttribute("data-hr-state", "accepted");
  await previewReady(page);
  const decisionMs = Date.now() - start;
  expect(decisionMs).toBeLessThanOrEqual(5000);
  testInfo.annotations.push({
    type: "timing",
    description: JSON.stringify({
      importMs,
      reattachMs,
      cachedMs,
      previewMs,
      decisionMs,
    }),
  });
});
test("RT-P02 @performance ten complete cycles release worker, URLs and documents", async ({
  page,
  context,
}, testInfo) => {
  await page.evaluate(() => {
    const Real = Worker,
      create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    window.rtResources = {
      workers: 0,
      peakWorkers: 0,
      urls: new Set(),
      longTasks: [],
    };
    window.Worker = class extends Real {
      constructor(...args) {
        super(...args);
        rtResources.workers++;
        rtResources.peakWorkers = Math.max(
          rtResources.peakWorkers,
          rtResources.workers,
        );
        this.done = false;
      }
      terminate() {
        if (!this.done) rtResources.workers--;
        this.done = true;
        super.terminate();
      }
    };
    URL.createObjectURL = (b) => {
      const url = create(b);
      rtResources.urls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      rtResources.urls.delete(url);
      revoke(url);
    };
    new PerformanceObserver((list) =>
      rtResources.longTasks.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ entryTypes: ["longtask"] });
  });
  await eligible(page, source);
  const cdp = await context.newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  const before = {
    ...(await cdp.send("Memory.getDOMCounters")),
    ...(await cdp.send("Runtime.getHeapUsage")),
  };
  let peak = before.usedSize;
  for (let i = 0; i < 10; i++) {
    await originalDownload(page);
    await page.locator("#original-cancel-button").click();
    await page.locator("#preview-button").click();
    await previewReady(page);
    await page.locator("#preview-button").click();
    await importHtml(page, simple());
    await eligible(page, source);
    peak = Math.max(peak, (await cdp.send("Runtime.getHeapUsage")).usedSize);
  }
  await expect
    .poll(() =>
      page.evaluate(() => ({
        workers: rtResources.workers,
        urls: rtResources.urls.size,
      })),
    )
    .toEqual({ workers: 0, urls: 0 });
  await cdp.send("HeapProfiler.collectGarbage");
  const after = {
    ...(await cdp.send("Memory.getDOMCounters")),
    ...(await cdp.send("Runtime.getHeapUsage")),
  };
  await expect(page.locator("iframe")).toHaveCount(2);
  await expect(page.locator("#import-candidate-frame")).toHaveCount(0);
  expect(after.documents).toBeLessThanOrEqual(before.documents);
  expect(after.usedSize - before.usedSize).toBeLessThan(32 * 1024 * 1024);
  testInfo.annotations.push({
    type: "memory",
    description: JSON.stringify({
      before,
      after,
      peak,
      ...(await page.evaluate(() => ({
        peakWorkers: rtResources.peakWorkers,
        longTasks: rtResources.longTasks,
      }))),
    }),
  });
});
test("RT-P03 @performance worker-active cancellation within 500 ms", async ({
  page,
}, testInfo) => {
  await eligible(page, source);
  await originalDialog(page);
  await page.evaluate(() => {
    const Real = Worker;
    window.Worker = class extends Real {
      postMessage(message) {
        window.rtWorkerActive = true;
        super.postMessage(message);
      }
    };
  });
  await page.locator("#original-download-button").click();
  await expect
    .poll(() => page.evaluate(() => window.rtWorkerActive))
    .toBe(true);
  const start = Date.now();
  await page.locator("#original-cancel-button").click();
  await expect(page.locator("#save-button")).toBeEnabled();
  const cancelMs = Date.now() - start;
  expect(cancelMs).toBeLessThanOrEqual(500);
  testInfo.annotations.push({
    type: "responsiveness",
    description: JSON.stringify({ cancelMs }),
  });
});
