const {
  test,
  expect,
  open,
  modelFixture,
  simple,
} = require("./helpers/roundtrip-fixtures.cjs");
test.beforeEach(async ({ page }) => open(page));
test("RT03 model ownership survives removal, re-edit and undo", async ({
  page,
}) => {
  const data = await modelFixture(page);
  const result = await page.evaluate(({ model, context }) => {
    const first = "hr-" + "1".repeat(20),
      second = "hr-" + "2".repeat(20),
      act = (a) => (model = roundTripModel.transition(model, a, context).model);
    act({
      type: "add",
      id: first,
      quote: "word",
      note: "",
      replacement: "Edited",
      canReplace: true,
      slices: [{ unit: "u000001", run: 0, start: 6, end: 10 }],
    });
    act({ type: "decide", id: first, status: "accepted" });
    act({ type: "remove", id: first });
    const removed = structuredClone(model);
    act({
      type: "add",
      id: second,
      quote: "Edited",
      note: "new",
      replacement: "Final",
      canReplace: true,
      slices: [{ unit: "u000001", run: 0, start: 6, end: 12 }],
    });
    model = roundTripModel.validate(JSON.parse(JSON.stringify(model)), context);
    act({ type: "decide", id: second, status: "accepted" });
    const accepted = roundTripModel.currentText(model.units[0]);
    act({ type: "decide", id: second, status: "open" });
    return {
      removed,
      accepted,
      undone: roundTripModel.currentText(model.units[0]),
    };
  }, data);
  expect(result.removed.comments).toEqual([]);
  expect(result.removed.units[0].runs).toEqual([
    { kind: "text", text: "Alpha Edited Omega" },
  ]);
  expect(result.accepted).toBe("Alpha Final Omega");
  expect(result.undone).toBe("Alpha Edited Omega");
});
test("RT05 independent runs, immutable decisions and preview", async ({
  page,
}) => {
  const data = await modelFixture(page);
  const result = await page.evaluate(({ model, context }) => {
    const original = JSON.stringify(model),
      a = "hr-" + "a".repeat(20),
      b = "hr-" + "b".repeat(20),
      act = (x) => (model = roundTripModel.transition(model, x, context).model);
    act({
      type: "add",
      id: a,
      quote: "Alpha",
      note: "",
      replacement: "Long beginning",
      canReplace: true,
      slices: [{ unit: "u000001", run: 0, start: 0, end: 5 }],
    });
    act({
      type: "add",
      id: b,
      quote: "Omega",
      note: "",
      replacement: "Z",
      canReplace: true,
      slices: [{ unit: "u000001", run: 1, start: 6, end: 11 }],
    });
    const unchanged = JSON.stringify(model),
      preview = roundTripModel.derivePreview(model, context);
    const pure = unchanged === JSON.stringify(model);
    act({ type: "decide", id: b, status: "accepted" });
    act({ type: "decide", id: a, status: "accepted" });
    const both = roundTripModel.currentText(model.units[0]);
    act({ type: "decide", id: a, status: "open" });
    act({ type: "decide", id: a, status: "rejected" });
    act({ type: "remove", id: b });
    return {
      pure,
      preview: roundTripModel.currentText(preview.units[0]),
      both,
      final: roundTripModel.currentText(model.units[0]),
      original,
    };
  }, data);
  expect(result.pure).toBe(true);
  expect(result.preview).toBe("Long beginning word Z");
  expect(result.both).toBe(result.preview);
  expect(result.final).toBe("Alpha word Z");
  expect(JSON.parse(result.original).comments).toEqual([]);
});
test("RT07 empty units and RT08 zero-length ownership remain guarded", async ({
  page,
}) => {
  const data = await modelFixture(page, simple("<p>A<b>B</b>C</p>"));
  const result = await page.evaluate(({ model, context }) => {
    const id = "hr-" + "a".repeat(20);
    model = roundTripModel.transition(
      model,
      {
        type: "add",
        id,
        quote: "B",
        note: "",
        replacement: "",
        canReplace: true,
        slices: [{ unit: "u000002", run: 0, start: 0, end: 1 }],
      },
      context,
    ).model;
    model = roundTripModel.transition(
      model,
      { type: "decide", id, status: "accepted" },
      context,
    ).model;
    const empty = model.units[1].runs;
    let code;
    try {
      roundTripModel.transition(
        model,
        {
          type: "add",
          id: "hr-" + "b".repeat(20),
          quote: "AC",
          note: "x",
          replacement: null,
          canReplace: true,
          slices: [
            { unit: "u000001", run: 0, start: 0, end: 1 },
            { unit: "u000003", run: 0, start: 0, end: 1 },
          ],
        },
        context,
      );
    } catch (e) {
      code = e.code;
    }
    model = roundTripModel.transition(
      model,
      { type: "remove", id },
      context,
    ).model;
    return { empty, code, removed: model.units[1] };
  }, data);
  expect(result.empty).toEqual([
    { kind: "annotation", id: "hr-" + "a".repeat(20), part: 0, text: "" },
  ]);
  expect(result.code).toBe("RT_INVALID_REVIEW");
  expect(result.removed.runs).toEqual([{ kind: "text", text: "" }]);
});
test("RT21 strict schemas, ownership, source definitions and transitions", async ({
  page,
}) => {
  const data = await modelFixture(page);
  const results = await page.evaluate(({ model, context }) => {
    const mutations = [
      (m) => (m.extra = 1),
      (m) => (m.source.profile = "future"),
      (m) => (m.source.mappingVersion = 2),
      (m) => (m.source.extra = 1),
      (m) => (m.view.scrollTogether = 1),
      (m) => m.units[0].start++,
      (m) => (m.units[0].id = "__proto__"),
      (m) => (m.units[0].runs = []),
      (m) => m.units[0].runs.push({ kind: "text", text: "x" }),
      (m) => (m.units[0].runs[0].text = "\ud800"),
      (m) => (m.units[0].runs[0].text = "\0"),
      (m) => (m.units[0].runs[0].extra = 1),
      (m) =>
        (m.units[0].runs[0] = {
          kind: "annotation",
          id: "hr-" + "a".repeat(20),
          part: 0,
          text: "x",
        }),
      (m) => m.comments.push({ id: "__proto__" }),
    ];
    return mutations.map((change) => {
      const m = structuredClone(model);
      change(m);
      try {
        roundTripModel.validate(m, context);
        return "accepted";
      } catch (e) {
        return e.code;
      }
    });
  }, data);
  expect(results).not.toContain("accepted");
  expect(results.filter((x) => x === "RT_VERSION")).toHaveLength(2);
});
test("RT09 model rejects cross-block replacement authorization and accepted edits", async ({
  page,
}) => {
  const data = await modelFixture(page);
  const result = await page.evaluate(({ model, context }) => {
    const id = "hr-" + "a".repeat(20),
      action = {
        type: "add",
        id,
        quote: "Alpha",
        note: "",
        replacement: "x",
        canReplace: false,
        slices: [{ unit: "u000001", run: 0, start: 0, end: 5 }],
      };
    let unauthorized;
    try {
      roundTripModel.transition(model, action, context);
    } catch (e) {
      unauthorized = e.code;
    }
    model = roundTripModel.transition(
      model,
      { ...action, canReplace: true },
      context,
    ).model;
    model = roundTripModel.transition(
      model,
      { type: "decide", id, status: "accepted" },
      context,
    ).model;
    let edit;
    try {
      roundTripModel.transition(
        model,
        {
          type: "edit",
          id,
          note: "changed",
          replacement: "x",
          canReplace: true,
        },
        context,
      );
    } catch (e) {
      edit = e.code;
    }
    return { unauthorized, edit };
  }, data);
  expect(result).toEqual({
    unauthorized: "RT_SELECTION",
    edit: "RT_INVALID_REVIEW",
  });
});
