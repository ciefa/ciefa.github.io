const {
  test,
  expect,
  open,
  simple,
  worker,
  modelFixture,
  eligible,
  doc,
  originalDialog,
  originalDownload,
  download,
  payload,
  withPayload,
  comment,
  select,
  plain,
  importHtml,
  state,
  appUrl,
} = require("./helpers/roundtrip-fixtures.cjs");
const { generated } = require("./helpers/roundtrip-build.cjs");
const fs = require("node:fs/promises");
const http = require("node:http");
test.beforeEach(async ({ page }) => open(page));
async function builtModel(page, source, data) {
  return page.evaluate(
    ({ source, data }) => {
      const api = new Function(source + ";return roundTripModel;")();
      try {
        return {
          ok: true,
          metrics: api.measure(
            api.validate(data.model, data.context),
            data.context,
          ),
        };
      } catch (e) {
        return { ok: false, code: e.code };
      }
    },
    { source, data },
  );
}
test("RT30 model limits accept equality and reject one byte/count over", async ({
  page,
}) => {
  const data = await modelFixture(page, simple("<p>Alpha<b>Beta</b></p>"));
  const prepared = await page.evaluate(({ model, context }) => {
    model = roundTripModel.transition(
      model,
      {
        type: "add",
        id: "hr-" + "a".repeat(20),
        quote: "AlphaBeta",
        note: "notes",
        replacement: "replacement",
        canReplace: true,
        slices: [
          { unit: "u000001", run: 0, start: 0, end: 5 },
          { unit: "u000002", run: 0, start: 0, end: 4 },
        ],
      },
      context,
    ).model;
    return { model, context, metrics: roundTripModel.measure(model, context) };
  }, data);
  const cases = {
    RT_MAX_INPUT_BYTES: prepared.model.source.byteLength,
    RT_MAX_TEMPLATE_BYTES: Buffer.byteLength(prepared.model.source.template),
    RT_MAX_NORMALIZED_BYTES: Buffer.byteLength(prepared.model.baseHtml),
    RT_MAX_UNITS: 2,
    RT_MAX_RUNS: 2,
    RT_MAX_COMMENTS: 1,
    RT_MAX_PARTS: 2,
    RT_MAX_NOTE_BYTES: 5,
    RT_MAX_REPLACEMENT_BYTES: 11,
    RT_MAX_CURRENT_TEXT_BYTES: 9,
    RT_MAX_METADATA_BYTES: prepared.metrics.metadataBytes,
  };
  for (const [key, value] of Object.entries(cases))
    for (const delta of [-1, 0, 1]) {
      const artifact = await generated({ [key]: value + delta }),
        result = await builtModel(page, artifact.model, prepared);
      expect(result.ok, key + " bound " + delta).toBe(delta >= 0);
      if (delta < 0) expect(result.code).toBe("RT_LIMIT");
    }
});
test("RT30 parser node, depth and attribute bounds fail during construction", async ({
  page,
}) => {
  const samples = {
    RT_MAX_PARSE_NODES: simple("<div><p>word</p></div>"),
    RT_MAX_TREE_DEPTH: simple("<div><section><p>word</p></section></div>"),
    RT_MAX_ELEMENT_ATTRIBUTES: simple('<p a="1" b="2" c="3">word</p>'),
    RT_MAX_ALL_ATTRIBUTES: simple(
      '<p a="1" b="2">word</p><p c="3" d="4">more</p>',
    ),
  };
  for (const [key, source] of Object.entries(samples)) {
    let threshold;
    for (let cap = 1; cap <= 32; cap++) {
      const artifact = await generated({ [key]: cap }),
        result = await worker(
          page,
          "analyzeSource",
          { text: source },
          artifact.worker,
        );
      if (result.ok) {
        threshold = cap;
        break;
      }
      expect(result.code).toBe("RT_LIMIT");
    }
    expect(threshold, key).toBeGreaterThan(1);
    for (const delta of [-1, 0, 1]) {
      const artifact = await generated({ [key]: threshold + delta }),
        result = await worker(
          page,
          "analyzeSource",
          { text: source },
          artifact.worker,
        );
      expect(result.ok, key + " " + delta).toBe(delta >= 0);
    }
  }
});
test("RT30 download and patched template caps are enforced in actual worker", async ({
  page,
}) => {
  const source = simple("<p>A</p>"),
    { model } = await modelFixture(page, source);
  model.units[0].runs = [{ kind: "text", text: "Longer 😀" }];
  const actual = await worker(page, "exportOriginal", {
    text: source,
    source: model.source,
    units: model.units,
  });
  expect(actual.ok).toBe(true);
  const templateBytes = Buffer.byteLength(
    require("./helpers/roundtrip-fixtures.cjs").templateOf(
      Buffer.from(actual.result.bytes),
    ),
  );
  for (const [key, value] of Object.entries({
    RT_MAX_DOWNLOAD_BYTES: actual.result.byteLength,
    RT_MAX_TEMPLATE_BYTES: templateBytes,
  }))
    for (const delta of [-1, 0, 1]) {
      const artifact = await generated({ [key]: value + delta }),
        result = await worker(
          page,
          "exportOriginal",
          { text: source, source: model.source, units: model.units },
          artifact.worker,
        );
      expect(result.ok, key + " " + delta).toBe(delta >= 0);
      if (delta < 0) expect(result.code).toBe("RT_LIMIT");
    }
});
test("RT25 input programs never run during analysis, staging, preview or export", async ({
  page,
}) => {
  await eligible(
    page,
    simple(
      '<p id="p0">Word</p><script>window.reviewSourceExecuted=true;fetch("https://example.invalid/should-not-run")</script>',
    ),
  );
  await originalDownload(page);
  expect(
    await page.evaluate(() => ({
      outer: window.reviewSourceExecuted,
      inner:
        document.querySelector("#document-frame").contentWindow
          .reviewSourceExecuted,
    })),
  ).toEqual({ outer: undefined, inner: undefined });
});
test("RT28 cancel active worker releases it and preserves the source cache", async ({
  page,
}) => {
  const source = simple();
  await eligible(page, source);
  await originalDialog(page);
  await page.evaluate(() => {
    const Real = Worker;
    window.workerTerminated = 0;
    window.Worker = class extends Real {
      postMessage(message) {
        window.lastWorkerRequest = message;
      }
      terminate() {
        window.workerTerminated++;
        super.terminate();
      }
    };
  });
  await page.locator("#original-download-button").click();
  await expect
    .poll(() => page.evaluate(() => !!window.lastWorkerRequest))
    .toBe(true);
  await page.locator("#original-cancel-button").click();
  await expect.poll(() => page.evaluate(() => window.workerTerminated)).toBe(1);
  await expect(page.locator("#save-button")).toBeEnabled();
  await expect(doc(page).locator("#p0")).toHaveText("Alpha word Omega");
});
test("RT29 failed competing import retains verified source; committed document drops it", async ({
  page,
}) => {
  const source = simple();
  await eligible(page, source);
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "invalid.html",
      mimeType: "text/html",
      buffer: Buffer.from('<script type="__bundler/template">"bad"</script>'),
    });
  await expect(page.locator("#toast")).toContainText("Could not open");
  expect(await originalDownload(page)).toEqual(Buffer.from(source));
  await page.locator("#original-cancel-button").click();
  await importHtml(page, plain());
  await page.locator("#export-menu-button").click();
  await expect(page.locator("#original-export-button")).toBeDisabled();
  await expect(page.locator("#original-export-explanation")).toContainText(
    "static export only",
  );
});
test("RT32 missing worker capability falls back without breaking static review", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.Worker = undefined;
  });
  await importHtml(page, simple());
  await expect(page.locator("#original-format-status")).toContainText(
    "unavailable in this browser",
  );
  const saved = payload(await download(page, "#save-button"));
  expect(saved.format).toBe("local-html-reviewer-v1");
});
test("RT32 loopback HTTP and routed HTTPS preserve original export", async ({
  page,
}) => {
  const html = await fs.readFile("index.html", "utf8"),
    server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(html);
    });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    for (const url of [
      "http://127.0.0.1:" + server.address().port,
      "https://reviewer.test/",
    ]) {
      if (url.startsWith("https:"))
        await page.route("https://reviewer.test/**", (r) =>
          r.fulfill({ contentType: "text/html", body: html }),
        );
      await page.goto(url);
      await eligible(page);
      expect(await originalDownload(page)).toEqual(Buffer.from(simple()));
      await page.locator("#original-cancel-button").click();
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("RT33 deterministic build, licenses, CSP and ten worker operations release URLs", async ({
  page,
}) => {
  const a = await generated(),
    b = await generated();
  expect(a.region).toBe(b.region);
  expect(a.html).toBe(await fs.readFile("index.html", "utf8"));
  expect(a.region).toContain("Copyright");
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL),
      Real = Worker;
    window.resources = { urls: new Set(), workers: 0 };
    URL.createObjectURL = (b) => {
      const u = create(b);
      window.resources.urls.add(u);
      return u;
    };
    URL.revokeObjectURL = (u) => {
      window.resources.urls.delete(u);
      revoke(u);
    };
    window.Worker = class extends Real {
      constructor(...args) {
        super(...args);
        window.resources.workers++;
        this.done = false;
      }
      terminate() {
        if (!this.done) window.resources.workers--;
        this.done = true;
        super.terminate();
      }
    };
  });
  await eligible(page);
  for (let i = 0; i < 10; i++) {
    await originalDownload(page);
    await page.locator("#original-cancel-button").click();
  }
  await expect
    .poll(() =>
      page.evaluate(() => ({
        workers: resources.workers,
        urls: resources.urls.size,
      })),
    )
    .toEqual({ workers: 0, urls: 0 });
  expect(
    await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content"),
  ).toContain("worker-src blob:");
  expect(await page.locator("#document-frame").getAttribute("sandbox")).toBe(
    "allow-same-origin",
  );
  expect(
    await doc(page)
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content"),
  ).toContain("script-src 'none'");
});
async function openBuild(page, limits) {
  const artifact = await generated(limits);
  await page.route("https://reviewer.test/**", (r) =>
    r.fulfill({ contentType: "text/html", body: artifact.html }),
  );
  await page.goto("https://reviewer.test/");
}
test("RT31 oversized combined preview and acceptance keep current model atomic", async ({
  page,
  browserName,
}) => {
  test.skip(browserName === "webkit", "WebKit 218086 blocks review listeners.");
  await openBuild(page, { RT_MAX_CURRENT_TEXT_BYTES: 5 });
  await eligible(page, simple('<p id="p0">A</p><p id="p1">B</p>'));
  await comment(page, { replacement: "XXX" });
  await comment(page, { selector: "#p1", replacement: "YYY" });
  await page.locator("#preview-button").click();
  await expect(page.locator("#preview-loading")).toHaveText(
    "Preview unavailable because the combined suggestions exceed the supported size. Your accepted text is unchanged.",
  );
  await page
    .getByRole("button", { name: "Accept", exact: true })
    .first()
    .click();
  await expect(doc(page).locator("#p0")).toHaveText("XXX");
  const before = await state(page);
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("exceeds the supported");
  expect((await state(page)).html).toBe(before.html);
  await expect(doc(page).locator("#p1")).toHaveText("B");
});
test("RT31 oversized annotated download retains unsaved state", async ({
  page,
  browserName,
}) => {
  test.skip(browserName === "webkit", "WebKit 218086 blocks review listeners.");
  await eligible(page);
  const baseline = await download(page, "#save-button");
  await openBuild(page, { RT_MAX_DOWNLOAD_BYTES: baseline.length + 1000 });
  await eligible(page);
  await comment(page, { note: "N".repeat(5000) });
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.locator("#save-button").click();
  await expect(page.locator("#toast")).toContainText("too large to download");
  await expect(page.locator("#save-state")).toHaveClass(/unsaved/);
  expect(downloads).toBe(0);
});
test("RT28 deterministic worker timeout and late responses restore controls", async ({
  page,
}) => {
  await openBuild(page, { RT_EXPORT_TIMEOUT_MS: 80 });
  await eligible(page);
  await originalDialog(page);
  await page.evaluate(() => {
    const Real = Worker;
    window.Worker = class extends Real {
      postMessage(message) {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: {
              ...message,
              requestId: message.requestId + 100,
              ok: true,
              result: {},
            },
          }),
        );
      }
    };
  });
  await page.locator("#original-download-button").click();
  await expect(page.locator("#original-export-progress")).toContainText(
    "took too long",
  );
  await expect(page.locator("#original-download-button")).toBeEnabled();
  await expect(page.locator("#save-button")).toBeEnabled();
});
test("RT28 unexpected worker failure fails import rather than silently downgrading", async ({
  page,
}) => {
  await eligible(page);
  const before = await state(page);
  await page.evaluate(() => {
    const Real = Worker;
    window.Worker = class extends Real {
      postMessage() {
        this.dispatchEvent(new ErrorEvent("error", { cancelable: true }));
      }
    };
  });
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "new.html",
      mimeType: "text/html",
      buffer: Buffer.from(simple("<p>different</p>")),
    });
  await expect(page.locator("#toast")).toContainText("could not be prepared");
  expect((await state(page)).html).toBe(before.html);
});
test("RT23 legacy reviews stay v1 and old reader rejects v2 explicitly", async ({
  page,
}) => {
  const legacy = await fs.readFile("tests/fixtures/legacy-review.html");
  await importHtml(page, legacy, "legacy-review.html");
  const saved = payload(await download(page, "#save-button"));
  expect(saved.format).toBe("local-html-reviewer-v1");
  await page.locator("#export-menu-button").click();
  await expect(page.locator("#original-export-button")).toBeDisabled();
  await page.locator("#export-menu-button").click();
  await eligible(page);
  const v2 = payload(await download(page, "#save-button")),
    oldWithV2 = withPayload(legacy, v2);
  await page.route("https://reviewer.test/**", (r) =>
    r.fulfill({ contentType: "text/html", body: oldWithV2 }),
  );
  await page.goto("https://reviewer.test/");
  await expect(page.locator("#toast")).toContainText("Could not restore");
  await expect(page.locator("#document-frame")).toBeHidden();
});
test("RT07 candidate mapping failure falls back only on fresh import", async ({
  page,
}) => {
  await page.evaluate(() => {
    const property = Object.getOwnPropertyDescriptor(
      HTMLIFrameElement.prototype,
      "srcdoc",
    );
    Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", {
      ...property,
      set(value) {
        if (this.id === "import-candidate-frame")
          value = value.replace(/<!--hr2:u\d{6}:s-->/, "");
        property.set.call(this, value);
      },
    });
  });
  await importHtml(page, simple());
  await expect(page.locator("#original-format-status")).toContainText(
    "static export only",
  );
  await expect(doc(page).locator("#p0")).toHaveText("Alpha word Omega");
  expect(payload(await download(page, "#save-button")).format).toBe(
    "local-html-reviewer-v1",
  );
});
test("RT30 production unit, node, depth and element-attribute caps", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Production-size bound cases run in Chromium; reduced boundaries run in each engine.",
  );
  for (const body of [
    "<p>A</p>".repeat(16385),
    "<i></i>".repeat(100001) + "<p>A</p>",
    "<div>".repeat(130) + "word" + "</div>".repeat(130),
    "<p " +
      Array.from({ length: 65 }, (_, i) => "a" + i + '="x"').join(" ") +
      ">word</p>",
  ]) {
    const result = await worker(page, "analyzeSource", { text: simple(body) });
    expect(result).toMatchObject({ ok: false, code: "RT_LIMIT" });
  }
});
