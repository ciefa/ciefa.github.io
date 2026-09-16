const {
  test,
  expect,
  open,
  simple,
  worker,
  modelFixture,
  eligible,
  comment,
  doc,
  download,
  payload,
  originalDownload,
  originalDialog,
  attach,
  templateOf,
  directFile,
  runtimeBundle,
  previewReady,
} = require("./helpers/roundtrip-fixtures.cjs");
test.beforeEach(async ({ page }) => open(page));
test("RT01 exact original bytes preserve BOM, CRLF and outer spelling", async ({
  page,
}) => {
  const source = simple(undefined, { bom: true, crlf: true });
  const { model } = await modelFixture(page, source);
  const output = await worker(page, "exportOriginal", {
    text: source,
    source: model.source,
    units: model.units,
  });
  expect(output.ok).toBe(true);
  expect(Buffer.from(output.result.bytes)).toEqual(Buffer.from(source));
  expect(output.result.changedUnits).toBe(0);
});
for (const [body, desired, expected] of [
  ["<p>A &amp; B</p>", "C < D", "<p>C &lt; D</p>"],
  ["<pre>A</pre>", "\nB", "<pre>\n\nB</pre>"],
  ["<pre>\nA</pre>", "\nB", "<pre>\n\nB</pre>"],
  ["<pre>\n\nA</pre>", "B", "<pre>B</pre>"],
  ["<pre><code>A</code></pre>", "\nB", "<pre><code>\nB</code></pre>"],
  [
    "<p>A &#38; &NotEqualTilde; &#x1f600; B</p>",
    "x\ry\n&<",
    "<p>x&#13;y\n&amp;&lt;</p>",
  ],
])
  test(
    "RT12 RT13 exact source patch " + JSON.stringify(body),
    async ({ page }) => {
      const source = simple(body),
        { model } = await modelFixture(page, source);
      model.units[0].runs = [{ kind: "text", text: desired }];
      const output = await worker(page, "exportOriginal", {
        text: source,
        source: model.source,
        units: model.units,
      });
      expect(output.ok, JSON.stringify(output)).toBe(true);
      expect(templateOf(Buffer.from(output.result.bytes))).toContain(expected);
    },
  );
test("RT15 RT18 ASCII JSON safely retains wrapper, assets and scripts", async ({
  page,
}) => {
  const source = simple("<p>Original</p>", { noCharset: true }),
    { model } = await modelFixture(page, source);
  const text = '😀 العربية </script> " \\ \u2028\u2029 <b>literal</b>';
  model.units[0].runs = [{ kind: "text", text }];
  const output = await worker(page, "exportOriginal", {
    text: source,
    source: model.source,
    units: model.units,
  });
  expect(output.ok).toBe(true);
  const restored = Buffer.from(output.result.bytes).toString(),
    re = /(<script type="__bundler\/template">)([\s\S]*?)(<\/script>)/;
  const before = re.exec(source),
    after = re.exec(restored);
  expect(source.slice(0, before.index + before[1].length)).toBe(
    restored.slice(0, after.index + after[1].length),
  );
  expect(source.slice(before.index + before[0].length - before[3].length)).toBe(
    restored.slice(after.index + after[0].length - after[3].length),
  );
  expect(after[2]).toMatch(/^[\x00-\x7f]*$/);
  expect(after[2]).not.toContain("<");
  expect(
    await page.evaluate(
      (t) =>
        new DOMParser().parseFromString(t, "text/html").querySelector("p")
          .textContent,
      templateOf(restored),
    ),
  ).toBe(text);
});
test("RT27 interpolation is rejected in prose and permitted in code", async ({
  page,
}) => {
  for (const tag of ["p", "code"]) {
    const source = simple(`<${tag}>word</${tag}>`),
      { model } = await modelFixture(page, source);
    model.units[0].runs = [{ kind: "text", text: "{{literal}}" }];
    const output = await worker(page, "exportOriginal", {
      text: source,
      source: model.source,
      units: model.units,
    });
    expect(output.ok).toBe(tag === "code");
    if (tag === "p") expect(output.code).toBe("RT_PATCH_INVALID");
  }
});
test.describe("review interactions", () => {
  test.beforeEach(async ({ browserName }) =>
    test.skip(
      browserName === "webkit",
      "WebKit 218086 blocks review listeners; original-format worker checks run separately.",
    ),
  );
  test("RT02 accepted only, RT35 counts, filename and dirty state", async ({
    page,
  }) => {
    await eligible(
      page,
      simple(
        '<p id="p0">word</p><p id="p1">pending</p><p id="p2">rejected</p>',
      ),
    );
    await comment(page, {
      replacement: "Accepted",
      note: "Private synthetic note",
    });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await comment(page, { selector: "#p1", replacement: "Pending proposal" });
    await comment(page, { selector: "#p2", replacement: "Rejected proposal" });
    await page
      .getByRole("button", { name: "Reject", exact: true })
      .last()
      .click();
    await page.locator("#preview-button").click();
    await previewReady(page);
    let filename;
    page.once("download", (file) => (filename = file.suggestedFilename()));
    const out = await originalDownload(page),
      template = templateOf(out);
    expect(filename).toBe("restored-synthetic.html");
    expect(template).toContain("Accepted");
    expect(template).toContain("pending");
    expect(template).toContain("rejected");
    for (const text of [
      "Private synthetic note",
      "Pending proposal",
      "Rejected proposal",
      "hr2:",
      "data-hr-id",
      "local-html-reviewer",
    ])
      expect(out.toString()).not.toContain(text);
    await expect(page.locator("#original-export-counts")).toHaveText(
      "1 accepted suggestions · Text fragments changed: 1",
    );
    await expect(page.locator("#save-state")).toHaveClass(/unsaved/);
    await page.locator("#original-cancel-button").click();
    const clean = await download(page, "#clean-button");
    expect(clean.toString()).toContain("Accepted");
    expect(clean.toString()).not.toContain("hr2:");
  });
  test("RT19 matching renamed original required after reopening; wrong bytes rejected", async ({
    page,
  }, testInfo) => {
    const source = simple();
    await eligible(page, source);
    await comment(page, { replacement: "Changed" });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    const saved = await download(page, "#save-button");
    expect(payload(saved).format).toBe("local-html-reviewer-v2");
    await directFile(page, saved, testInfo);
    await expect(doc(page).locator("#p0")).toHaveText("Changed");
    await originalDialog(page);
    await expect(page.locator("#original-download-button")).toBeDisabled();
    await page.locator("#original-source-input").setInputFiles({
      name: "synthetic.html",
      mimeType: "text/html",
      buffer: Buffer.from(source.replace("Omega", "omega")),
    });
    await expect(page.locator("#original-export-progress")).toContainText(
      "not the original file",
    );
    await expect(page.locator("#original-download-button")).toBeDisabled();
    await attach(page, source, "renamed-original.html");
    const out = await originalDownload(page);
    expect(templateOf(out)).toContain("Changed");
  });
  test("RT26 restored synthetic runtime renders resources, components and interaction", async ({
    page,
  }, testInfo) => {
    const source = runtimeBundle();
    await eligible(page, source);
    await comment(page, { replacement: "Runtime retained" });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    const out = await originalDownload(page);
    await page.locator("#original-cancel-button").click();
    await download(page, "#save-button");
    await directFile(page, out, testInfo, "standalone");
    await page.waitForFunction(() => window.syntheticReady === true);
    await expect(page.locator("#p0")).toHaveText("Runtime retained");
    await expect(page.locator("doc-page")).toHaveAttribute("data-ready", "yes");
    await expect(page.locator("td#cell")).toHaveText("Cell passage to revise.");
    await page.locator("#runtime-button").click();
    await expect(page.locator("#runtime-output")).toHaveText(
      "Action completed",
    );
    expect(
      await page
        .locator("#image")
        .evaluate((n) => n.complete && n.naturalWidth > 0),
    ).toBe(true);
    await page.locator("#jump").click();
    await expect(page).toHaveURL(/#end$/);
    expect(
      await page
        .locator("#vector")
        .evaluate((n) => n.complete && n.naturalWidth > 0),
    ).toBe(true);
    expect(
      await page.evaluate(async () => {
        await document.fonts.ready;
        return document.fonts.check("16px FixtureFira");
      }),
    ).toBe(true);
    await expect(page.locator("#external")).toHaveAttribute(
      "href",
      "https://example.invalid/destination",
    );
  });
  test("RT34 static pre export and RT24 exported bundle becomes new baseline", async ({
    page,
  }, testInfo) => {
    const source = simple('<pre id="p0">A</pre>');
    await eligible(page, source);
    await comment(page, { replacement: "\nB" });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    const staticOut = await download(page, "#clean-button");
    expect(staticOut.toString()).not.toMatch(
      /hr2:|roundtrip-worker|local-html-reviewer|data-hr-id/,
    );
    expect(
      await page.evaluate(
        (html) =>
          new DOMParser()
            .parseFromString(html, "text/html")
            .querySelector("pre").textContent,
        staticOut.toString(),
      ),
    ).toBe("\nB");
    const out = await originalDownload(page);
    await page.locator("#original-cancel-button").click();
    await download(page, "#save-button");
    await eligible(page, out, "restored-synthetic.html");
    const saved = payload(await download(page, "#save-button"));
    expect(saved.units[0].original).toBe("\nB");
    expect(await originalDownload(page)).toEqual(out);
  });
});
test("RT18 RT27 multibyte wrapper bytes and synthetic producer metadata remain exact", async ({
  page,
}) => {
  const metadata =
    '<script id="synthetic-producer-index" type="application/json">{"syntheticChecksum":"unchanged-demo-checksum","syntheticIndex":["word"]}</script>';
  const source =
    simple("<p>word</p>", { bom: true, crlf: true }).replace(
      "Synthetic bundle",
      "Résumé 😀",
    ) + metadata;
  const { model } = await modelFixture(page, source);
  model.units[0].runs = [{ kind: "text", text: "Edited" }];
  const result = await worker(page, "exportOriginal", {
    text: source,
    source: model.source,
    units: model.units,
  });
  expect(result.ok).toBe(true);
  const original = Buffer.from(source),
    out = Buffer.from(result.result.bytes),
    opening = Buffer.from('<ScRiPt type="__bundler/template">'),
    closing = Buffer.from("</ScRiPt>"),
    start = original.indexOf(opening) + opening.length,
    end = original.indexOf(closing, start),
    newEnd = out.indexOf(closing, start);
  expect(out.subarray(0, start)).toEqual(original.subarray(0, start));
  expect(out.subarray(newEnd)).toEqual(original.subarray(end));
  expect(out.toString()).toContain(metadata);
  expect(templateOf(out)).toContain("Edited");
});
