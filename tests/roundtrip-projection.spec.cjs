const {
  test,
  expect,
  open,
  simple,
  bundle,
  parts,
  worker,
  modelFixture,
  eligible,
  select,
  comment,
  doc,
  originalDownload,
  templateOf,
  download,
  payload,
} = require("./helpers/roundtrip-fixtures.cjs");
test.beforeEach(async ({ page }) => open(page));
test("RT10 moved slots and table aliases retain source-order IDs", async ({
  page,
}) => {
  const { template, manifest } = parts(),
    data = await modelFixture(page, bundle(template, manifest));
  expect(data.model.units[0].original).toBe("Synthetic footer");
  expect(data.context.unitOrder[0]).toBe(data.model.units.at(-1).id);
  expect(data.context.unitOrder.at(-1)).toBe(data.model.units[0].id);
  const cell = data.model.units.find(
    (u) => u.original === "Cell passage to revise.",
  );
  cell.runs = [{ kind: "text", text: "Revised cell" }];
  const output = await worker(page, "exportOriginal", {
    text: bundle(template, manifest),
    source: data.model.source,
    units: data.model.units,
  });
  expect(output.ok).toBe(true);
  const patched = templateOf(Buffer.from(output.result.bytes));
  expect(patched).toContain('<sc-raw-td id="cell">Revised cell</sc-raw-td>');
  expect(patched.indexOf('slot="footer"')).toBeLessThan(
    patched.indexOf('slot="header"'),
  );
});
for (const [name, body] of [
  ["noscript", "<noscript>fallback</noscript><p>word</p>"],
  ["template", "<template><p>inert</p></template><p>word</p>"],
  ["SVG text", "<svg><text>word</text></svg>"],
  ["reserved comment", "<p>word</p><!--hr2:reserved-->"],
  ["duplicate attribute", '<p id="a" id="b">word</p>'],
  ["fostered span", "<table>A<tr><td>cell</td></tr>B</table>"],
])
  test("RT17 unsupported restoration falls back: " + name, async ({ page }) => {
    const source = simple(body),
      result = await worker(page, "analyzeSource", { text: source });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("RT_INELIGIBLE");
  });
test("RT16 actual markers ignore inert/comment/attribute decoys and require matching modes", async ({
  page,
}) => {
  const source = simple()
    .replace(
      'type="__bundler/template"',
      'data-quoted=">" type="__bundler/template"',
    )
    .replace(
      '<div id="loading">',
      '<!-- <script type="__bundler/template">fake</script> --><template><script type="__bundler/template">"inert"</script></template><div title="<script type=decoy>"></div><div id="loading">',
    )
    .replace(
      'type="__bundler/template"',
      'data-quoted=">" type="__bundler/template"',
    );
  const info = await worker(page, "analyzeSource", { text: source });
  expect(info.ok).toBe(true);
  for (const addition of [
    '<script type="__bundler/template">"duplicate"</script>',
    '<noscript><script type="__bundler/template">"mode"</script></noscript>',
  ])
    expect(
      (await worker(page, "analyzeSource", { text: simple() + addition })).ok,
    ).toBe(false);
});
test.describe("mapped selections", () => {
  test.beforeEach(async ({ browserName }) =>
    test.skip(
      browserName === "webkit",
      "WebKit 218086 blocks review listeners.",
    ),
  );
  test("RT04 repeated passages and duplicate IDs target only the second node", async ({
    page,
  }) => {
    await eligible(
      page,
      simple('<p id="same">Same words</p><p id="same">Same words</p>'),
    );
    await comment(page, {
      selector: "p:nth-of-type(2)",
      replacement: "Second only",
    });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    expect(templateOf(await originalDownload(page))).toContain(
      '<p id="same">Same words</p><p id="same">Second only</p>',
    );
  });
  test("RT06 cross-inline replacement retains tags and restores originals on undo", async ({
    page,
  }) => {
    await eligible(
      page,
      simple('<p id="p0">One <b>bold</b> <i>italic</i> end</p>'),
    );
    await comment(page, { start: 4, end: 15, replacement: "New phrase" });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    expect(templateOf(await originalDownload(page))).toContain(
      '<p id="p0">One <b>New phrase</b><i></i> end</p>',
    );
    await page.locator("#original-cancel-button").click();
    await page
      .getByRole("button", { name: "Undo acceptance", exact: true })
      .click();
    await expect(doc(page).locator("#p0")).toHaveText("One bold italic end");
  });
  test("RT08 empty owned run prevents overlap between visible neighboring words", async ({
    page,
  }) => {
    await eligible(page, simple('<p id="p0">A<b>B</b>C</p>'));
    await comment(page, { start: 1, end: 2, replacement: "" });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await select(page, "#p0", 0, 2);
    await page.locator("#add-selection").click();
    await expect(page.locator("#toast")).toContainText("overlaps");
    await expect(page.locator("#composer")).toBeHidden();
  });
  test("RT09 cross-block comments cannot become replacements", async ({
    page,
  }) => {
    await eligible(page, simple('<p id="p0">One</p><p id="p1">Two</p>'));
    await comment(page, { endSelector: "#p1", note: "Across blocks" });
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.locator("#suggest-toggle")).toBeDisabled();
  });
  for (const [body, start, end] of [
    ['<p id="p0">😀 tail</p>', 0, 1],
    ['<p id="p0">e<b>́</b> tail</p>', 0, 1],
    ['<p id="p0">👩‍💻 tail</p>', 0, 2],
  ])
    test("RT14 reject split grapheme " + body, async ({ page }) => {
      await eligible(page, simple(body));
      await select(page, "#p0", start, end);
      await page.locator("#add-selection").click();
      await expect(page.locator("#toast")).toContainText(
        "Select complete characters",
      );
      await expect(page.locator("#composer")).toBeHidden();
    });
  test("RT14 full graphemes and normalization variants retain exact strings", async ({
    page,
  }) => {
    await eligible(page, simple('<p id="p0">e<b>́</b> 👩‍💻 العربية é</p>'));
    await comment(page, { start: 0, end: 2, replacement: "é é العربية 😀" });
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    const text = templateOf(await originalDownload(page));
    expect(text).toContain("é é العربية 😀<b></b>");
  });
});
test("RT08 empty ownership at a selection boundary is protected, with separate neighbors allowed", async ({
  page,
  browserName,
}) => {
  test.skip(browserName === "webkit", "WebKit 218086 blocks review listeners.");
  await eligible(
    page,
    simple(
      '<p id="p0"><span id="a">A</span><b id="b">B</b><span id="c">C</span></p>',
    ),
  );
  await comment(page, { selector: "#b", replacement: "" });
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  // This range begins just before the empty owned mark, even though its visible
  // quote is C. It must not bypass ownership by dropping the zero-width prefix.
  await select(page, "#p0", 1, 2);
  await page.locator("#add-selection").click();
  await expect(page.locator("#toast")).toContainText("overlaps");
  await comment(page, { selector: "#a", note: "Before the deletion" });
  await comment(page, { selector: "#c", note: "After the deletion" });
  await expect(page.locator(".card")).toHaveCount(3);
});
