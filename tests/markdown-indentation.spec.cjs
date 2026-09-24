const {
  test,
  expect,
  open,
  openMarkdown,
  mdDownload,
  select,
  previewReady,
  importHtml,
  moduleOf,
} = require("./helpers/markdown-fixtures.cjs");
const editing = moduleOf("src/markdown/editing.js");
const skipWebkit = (browserName) =>
  test.skip(
    browserName === "webkit",
    "WebKit 218086 blocks source annotation listeners.",
  );
const font = (page, selector) =>
  page
    .locator(selector)
    .last()
    .evaluate((n) => getComputedStyle(n).fontFamily);
test("MI01 indentLines applies the line and selection rules", () => {
  expect(editing.INDENT).toBe("  ");
  const examples = [
    ["- a\n- b", 5, 5, false, "- a\n  - b", 7, 7, true],
    ["- a\n- b", 4, 4, false, "- a\n  - b", 6, 6, true],
    ["- a\n\n- b", 0, 8, false, "  - a\n\n  - b", 0, 12, true, 0, 8, "  - a\n\n  - b"],
    ["- a\n- b\n- c", 0, 4, false, "  - a\n- b\n- c", 0, 6, true, 0, 3, "  - a"],
    ["- a\n- b\n- c", 2, 9, false, "  - a\n  - b\n  - c", 4, 15, true, 0, 11, "  - a\n  - b\n  - c"],
    ["  - a\n\t- b\n - c\n- d", 0, 19, true, "- a\n- b\n- c\n- d", 0, 15, true],
    ["- a\n- b", 0, 7, true, "- a\n- b", 0, 7, false],
    ["\n- a", 0, 0, false, "  \n- a", 2, 2, true],
    ["- a\n\n- b", 4, 4, false, "- a\n  \n- b", 6, 6, true],
    ["    - a", 1, 1, true, "  - a", 0, 0, true],
    ["- a\n- b", 3, 4, false, "  - a\n- b", 5, 6, true],
    ["  ", 0, 2, true, "", 0, 0, true],
    ["- \u{1f600}\n- b", 1, 8, false, "  - \u{1f600}\n  - b", 3, 12, true],
  ];
  for (const [text, start, end, outdent, ...expected] of examples) {
    const r = editing.indentLines(text, start, end, outdent);
    const actual = [r.text, r.selectionStart, r.selectionEnd, r.changed];
    if (expected.length > 4) actual.push(r.from, r.to, r.insert);
    expect(actual, JSON.stringify([text, start, end, outdent])).toEqual(
      expected,
    );
  }
});
test.describe("replacement field", () => {
  test.beforeEach(async ({ page }) => open(page));
  test("MI02 Tab indents nested list suggestions with undo and release", async ({
    page,
    browserName,
  }) => {
    skipWebkit(browserName);
    const lines = [
      "- Erste Schritte am Computer",
      "- Erste Schritte auf dem Smartphone",
      "- Erneut anmelden",
    ];
    const source = "# Inhalt\n\n" + lines.join("\n") + "\n",
      quote = lines.join("\n"),
      start = source.indexOf(quote);
    await openMarkdown(page, [{ name: "toc.md", text: source }]);
    expect(await page.evaluate(() => markdownWorkspace.INDENT)).toBe("  ");
    await select(page, "#markdown-source", start, start + quote.length);
    await page.locator("#add-selection").click();
    await page.locator("#suggest-toggle").check();
    const input = page.locator("#replacement-input");
    await expect(input).toHaveValue(quote);
    const second = quote.indexOf("\n") + 1;
    await input.evaluate(
      (n, [a, b]) => n.setSelectionRange(a, b),
      [second, quote.length],
    );
    const indented =
      lines[0] + "\n" + lines.slice(1).map((l) => "  " + l).join("\n");
    await page.keyboard.press("Tab");
    await expect(input).toHaveValue(indented);
    await expect(input).toBeFocused();
    expect(
      await input.evaluate((n) => [n.selectionStart, n.selectionEnd]),
    ).toEqual([second, quote.length + 4]);
    await page.keyboard.press("Shift+Tab");
    await expect(input).toHaveValue(quote);
    await page.keyboard.press("Tab");
    await expect(input).toHaveValue(indented);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(input).toHaveValue(quote);
    await page.keyboard.press("Tab");
    await expect(input).toHaveValue(indented);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await expect(input).toHaveValue(indented);
    await expect(page.locator("#submit-comment")).toBeFocused();
    await page.locator("#note-input").fill("Gruppieren");
    await page.locator("#submit-comment").click();
    await expect(page.locator("#preview-button")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await previewReady(page);
    await expect(
      page.frameLocator("#preview-frame").locator("ul ul li"),
    ).toHaveText(["Erste Schritte auf dem Smartphone", "Erneut anmelden"]);
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    expect(
      (await mdDownload(page, "#markdown-current-button")).toString(),
    ).toBe("# Inhalt\n\n" + indented + "\n");
  });
  test("MI03 Markdown replacement uses monospace and grows", async ({
    page,
    browserName,
  }) => {
    skipWebkit(browserName);
    await openMarkdown(page, [{ name: "a.md", text: "Alpha\n\nBeta\n" }]);
    await select(page, "#markdown-source", 0, 5);
    await page.locator("#add-selection").click();
    await page.locator("#suggest-toggle").check();
    const input = page.locator("#replacement-input");
    expect(await font(page, "#replacement-input")).toContain("monospace");
    expect(await font(page, "#selected-quote")).toContain("monospace");
    await expect(page.locator("#replacement-hint")).toHaveText(
      "Replacements are literal Markdown, including formatting and template syntax. Leave empty to delete. Tab indents the selected lines by two spaces; Shift+Tab outdents. Press Esc, then Tab, to leave this field.",
    );
    await expect(input).toHaveAttribute("aria-describedby", "replacement-hint");
    const before = (await input.boundingBox()).height;
    expect(before).toBeGreaterThanOrEqual(160);
    await input.fill(
      Array.from({ length: 40 }, (_, i) => "- item " + (i + 1)).join("\n"),
    );
    const after = (await input.boundingBox()).height;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(
      await page.evaluate(() => Math.floor(innerHeight * 0.6)),
    );
    await page.locator("#submit-comment").click();
    expect(await font(page, ".card .replacement")).toContain("monospace");
    await select(page, "#markdown-source", 7, 11);
    await page.locator("#add-selection").click();
    await page.locator("#suggest-toggle").check();
    await input.fill("");
    await page.locator("#submit-comment").click();
    await expect(page.locator(".card .replacement.deletion")).toHaveCount(1);
    expect(await font(page, ".card .replacement.deletion")).not.toContain(
      "monospace",
    );
  });
  test("MI04 HTML replacement field keeps Tab focus movement", async ({
    page,
    browserName,
  }) => {
    skipWebkit(browserName);
    await importHtml(
      page,
      '<!doctype html><html><body><p id="p0">Alpha beta gamma.</p></body></html>',
    );
    await select(page, "#p0");
    await page.locator("#add-selection").click();
    await page.locator("#suggest-toggle").check();
    const input = page.locator("#replacement-input");
    await input.focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#submit-comment")).toBeFocused();
    await expect(input).toHaveValue("Alpha beta gamma.");
    await expect(page.locator("#replacement-hint")).toHaveText(
      "Leave empty to suggest deleting the selected text. Replacements use plain text.",
    );
    expect(await font(page, "#replacement-input")).not.toContain("monospace");
    expect(await input.evaluate((n) => n.style.height)).toBe("");
  });
});
