const {
  test,
  expect,
  zip,
  archives,
  ws,
  model,
} = require("./helpers/markdown-fixtures.cjs");
test("MD03 MD07 MD13 ZIP variants preserve bytes and paths", () => {
  const entries = [
    { path: "folder/", method: 0 },
    { path: "folder/a.md", text: "\ufeff# A\r\nMixed\nFinal\r", method: 0 },
    { path: "other/a.md", text: '{{ label("sample") }}', descriptor: "signed" },
    { path: "cafe\u0301.markdown", text: "\n\n😀", descriptor: "unsigned" },
  ];
  const read = archives.readZip(
    zip(entries, { comment: "synthetic archive comment" }),
  );
  expect(read.map((e) => e.path)).toEqual(entries.slice(1).map((e) => e.path));
  read.forEach((e, i) =>
    expect(Buffer.from(e.data)).toEqual(Buffer.from(entries[i + 1].text)),
  );
  const rebuilt = archives.readZip(archives.writeZip(read));
  expect(rebuilt).toEqual(read);
  expect(Buffer.from(archives.writeZip(read))).toEqual(
    Buffer.from(archives.writeZip(read)),
  );
});
for (const path of [
  "../a.md",
  "/a.md",
  "a/../b.md",
  "a\\b.md",
  "C:a.md",
  "./a.md",
  "a//b.md",
  "a./b.md",
  "a /b.md",
  "NUL.md",
  "a/COM1.md",
  "a\u0000.md",
])
  test("MD12 rejects unsafe path " + JSON.stringify(path), () =>
    expect(() => archives.readZip(zip([{ path, text: "safe" }]))).toThrow(
      "MD_PATH",
    ),
  );
for (const paths of [
  ["a.md", "a.md"],
  ["a.md", "A.MD"],
  ["café.md", "cafe\u0301.md"],
  ["a.md", "a.md/b.md"],
])
  test("MD12 rejects conflicting names " + JSON.stringify(paths), () =>
    expect(() =>
      archives.readZip(zip(paths.map((path) => ({ path, text: "safe" })))),
    ).toThrow("MD_PATH"),
  );
for (const entry of [
  { path: "a.md", flags: 1 },
  { path: "a.md", method: 12 },
  { path: "a.md", attrs: (0xa000 << 16) >>> 0 },
  { path: "é.md", flags: 0 },
  { path: "image.png" },
  { path: "a.md", crc: 123 },
  { path: "a.md", size: 1 },
  { path: "a.md", size: 200 },
])
  test(
    "MD11 MD13 MD14 rejects unsupported/corrupt entry " + JSON.stringify(entry),
    () =>
      expect(() =>
        archives.readZip(zip([{ ...entry, text: "Synthetic ".repeat(10) }])),
      ).toThrow(),
  );
test("MD14 rejects truncation, header mismatch, overlap, ZIP64 and counts", () => {
  expect(() =>
    archives.readZip(
      zip([{ path: "a.md", text: "Alpha", trailing: Buffer.from([0]) }]),
    ),
  ).toThrow("MD_ZIP");
  const good = zip([
    { path: "a.md", text: "Alpha" },
    { path: "b.md", text: "Beta" },
  ]);
  const variants = [good.subarray(0, -1)];
  const flag = Buffer.from(good);
  flag.writeUInt16LE(0, 6);
  variants.push(flag);
  const zip64 = Buffer.from(good);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 6);
  variants.push(zip64);
  const overlap = Buffer.from(good);
  const cd = overlap.readUInt32LE(overlap.length - 6);
  overlap.writeUInt32LE(0, cd + 46 + 4 + 42);
  variants.push(overlap);
  const extra = Buffer.from(good);
  extra.writeUInt16LE(1, 28);
  variants.push(extra);
  for (const data of variants) expect(() => archives.readZip(data)).toThrow();
  expect(() =>
    archives.readZip(
      zip(Array.from({ length: 101 }, (_, i) => ({ path: i + ".md" }))),
    ),
  ).toThrow("MD_LIMIT");
  expect(() =>
    archives.readZip(zip([{ path: "a.md", size: 1024 * 1024 + 1 }])),
  ).toThrow("MD_LIMIT");
});
test("MD07 MD16 sources roundtrip byte exactly and reject invalid encoding", async () => {
  for (const text of [
    "",
    "\ufeff",
    "\ufeff\ufeff# Text\r\n",
    "\nAlpha\r\nBeta\rGamma",
    "😀 e\u0301 &amp; **bold**",
  ]) {
    const bytes = Buffer.from(text),
      source = await ws.decodeSource(bytes);
    expect(Buffer.from(ws.sourceBytes(source))).toEqual(bytes);
  }
  for (const data of [
    Buffer.from([255]),
    Buffer.from([255, 254, 97, 0]),
    Buffer.from([0]),
    Buffer.from([0xc0, 0xaf]),
  ])
    await expect(ws.decodeSource(data)).rejects.toThrow("MD_ENCODING");
});
test("MD05 MD06 durable runs survive accepted removal, saved validation and undo", async () => {
  const workspace = await ws.create([
    { path: "a.md", data: Buffer.from("Alpha beta\r\n") },
  ]);
  let m = ws.documentModel(workspace.documents[0], workspace.view),
    c = ws.context(m);
  const id = "hr-00000000000000000001";
  const act = (a) => {
    m = model.transition(m, a, c).model;
  };
  act({
    type: "add",
    id,
    quote: "Alpha",
    note: "note",
    replacement: "Final",
    canReplace: true,
    slices: [{ unit: "u000001", run: 0, start: 0, end: 5 }],
  });
  expect(model.currentText(m.units[0])).toBe("Alpha beta\r\n");
  expect(model.currentText(model.derivePreview(m, c).units[0])).toBe(
    "Final beta\r\n",
  );
  act({ type: "decide", id, status: "accepted" });
  act({ type: "remove", id });
  workspace.documents[0] = ws.fromModel(workspace.documents[0], m);
  await ws.verify(workspace);
  expect(workspace.documents[0].runs).toEqual([
    { kind: "text", text: "Final beta\r\n" },
  ]);
  expect(ws.replacement(m.source, "a\nb\rc\r\nd")).toBe("a\r\nb\r\nc\r\nd");
});
test("MD09 strict inactive schema, content identity and IDs", async () => {
  const w = await ws.create([
    { path: "a.md", data: Buffer.from("A") },
    { path: "b.md", data: Buffer.from("B") },
  ]);
  for (const change of [
    (v) => (v.extra = 1),
    (v) => (v.documents[1].id = "d0001"),
    (v) => (v.documents[1].runs[0].text = "\u0000"),
    (v) => (v.documents[1].source.sha256 = "0".repeat(64)),
    (v) => (v.documents[1].source.byteLength = 2),
    (v) => (v.activeDocumentId = "unknown"),
  ]) {
    const bad = structuredClone(w);
    change(bad);
    await expect(ws.verify(bad)).rejects.toThrow();
  }
});
