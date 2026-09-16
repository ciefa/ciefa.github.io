import * as L from "./limits.js";
const bytes = (s) => new TextEncoder().encode(s).length;
const fail = (code = "RT_INVALID_REVIEW") => {
  throw Object.assign(new Error(code), { code });
};
const check = (ok, code) => {
  if (!ok) fail(code);
};
const keys = (v, expected) =>
  check(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).sort().join("|") === expected.split(" ").sort().join("|"),
  );
const scalar = (s) =>
  typeof s === "string" &&
  !/[\u0000\ud800-\udfff]/u.test(
    s.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""),
  );
const array = (a) =>
  check(Array.isArray(a) && Object.keys(a).length === a.length);
const bounded = (n, cap) => check(n <= cap, "RT_LIMIT");
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
// Strings are immutable: share the large base/template while owning every mutable record.
const clone = (v) => ({
  ...v,
  source: { ...v.source },
  view: { ...v.view },
  units: v.units.map((u) => ({ ...u, runs: u.runs.map((r) => ({ ...r })) })),
  comments: v.comments.map((c) => ({
    ...c,
    parts: c.parts.map((p) => ({ ...p })),
  })),
});
export const currentText = (unit) => unit.runs.map((r) => r.text).join("");
export function encodeTextPatch(text, preAtStart) {
  check(scalar(text), "RT_PATCH_INVALID");
  return (
    (preAtStart && text.startsWith("\n") ? "\n" : "") +
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\r/g, "&#13;")
  );
}
function contextFor(m, context) {
  check(
    context &&
      Array.isArray(context.sourceUnits) &&
      Array.isArray(context.unitOrder),
  );
  check(
    context.sourceUnits.length === m.units.length &&
      context.unitOrder.length === m.units.length &&
      new Set(context.unitOrder).size === m.units.length,
  );
  const units = new Map(m.units.map((u) => [u.id, u]));
  check(context.unitOrder.every((id) => units.has(id)));
  for (let i = 0; i < m.units.length; i++) {
    const u = m.units[i],
      s = context.sourceUnits[i];
    check(
      s &&
        ["id", "start", "end", "original"].every((k) => s[k] === u[k]) &&
        typeof s.preAtStart === "boolean",
    );
  }
  return units;
}
export function measure(m, context) {
  contextFor(m, context);
  let runCount = 0,
    currentTextBytes = 0,
    patchedTemplateBytes = bytes(m.source.template);
  m.units.forEach((u, i) => {
    runCount += u.runs.length;
    const text = currentText(u);
    currentTextBytes += bytes(text);
    if (text !== u.original)
      patchedTemplateBytes +=
        bytes(encodeTextPatch(text, context.sourceUnits[i].preAtStart)) -
        bytes(m.source.template.slice(u.start, u.end));
  });
  const { baseHtml, ...metadata } = m;
  return {
    unitCount: m.units.length,
    runCount,
    commentCount: m.comments.length,
    currentTextBytes,
    patchedTemplateBytes,
    metadataBytes: bytes(JSON.stringify(metadata)),
  };
}
function limits(m, context) {
  const n = measure(m, context);
  bounded(n.unitCount, L.RT_MAX_UNITS);
  bounded(n.runCount, L.RT_MAX_RUNS);
  bounded(n.commentCount, L.RT_MAX_COMMENTS);
  bounded(n.currentTextBytes, L.RT_MAX_CURRENT_TEXT_BYTES);
  bounded(n.patchedTemplateBytes, L.RT_MAX_TEMPLATE_BYTES);
  bounded(n.metadataBytes, L.RT_MAX_METADATA_BYTES);
}
export function validate(payload, context) {
  const m = payload;
  keys(m, "format originalName source baseHtml units comments view");
  check(m.format === "local-html-reviewer-v2", "RT_VERSION");
  check(typeof m.originalName === "string" && typeof m.baseHtml === "string");
  bounded(bytes(m.baseHtml), L.RT_MAX_NORMALIZED_BYTES);
  keys(
    m.source,
    "profile mappingVersion sha256 byteLength encoding bomBytes templateSha256 template",
  );
  const s = m.source;
  check(
    s.profile === "bundler-template-text-v1" && s.mappingVersion === 1,
    "RT_VERSION",
  );
  check(
    s.encoding === "utf-8" &&
      [0, 3].includes(s.bomBytes) &&
      integer(s.byteLength) &&
      s.byteLength > 0 &&
      typeof s.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(s.sha256) &&
      typeof s.templateSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(s.templateSha256) &&
      scalar(s.template),
  );
  bounded(s.byteLength, L.RT_MAX_INPUT_BYTES);
  bounded(bytes(s.template), L.RT_MAX_TEMPLATE_BYTES);
  keys(m.view, "previewOpen scrollTogether");
  check(
    typeof m.view.previewOpen === "boolean" &&
      typeof m.view.scrollTogether === "boolean",
  );
  array(m.units);
  array(m.comments);
  check(m.units.length > 0);
  bounded(m.units.length, L.RT_MAX_UNITS);
  bounded(m.comments.length, L.RT_MAX_COMMENTS);
  let end = 0,
    count = 0;
  const owners = new Map();
  m.units.forEach((u, i) => {
    keys(u, "id start end original runs");
    check(
      u.id === "u" + String(i + 1).padStart(6, "0") &&
        integer(u.start) &&
        integer(u.end) &&
        u.start >= end &&
        u.end > u.start &&
        u.end <= s.template.length &&
        scalar(u.original),
    );
    end = u.end;
    array(u.runs);
    check(u.runs.length > 0);
    count += u.runs.length;
    bounded(count, L.RT_MAX_RUNS);
    u.runs.forEach((r, j) => {
      check(r && scalar(r.text));
      if (r.kind === "text") {
        keys(r, "kind text");
        check(
          (r.text !== "" || u.runs.length === 1) &&
            (j === 0 || u.runs[j - 1].kind !== "text"),
        );
      } else {
        keys(r, "kind id part text");
        check(
          r.kind === "annotation" &&
            typeof r.id === "string" &&
            /^hr-[a-f0-9]{20}$/.test(r.id) &&
            integer(r.part),
        );
        const key = r.id + ":" + r.part;
        check(!owners.has(key));
        owners.set(key, { unit: u.id, run: r });
      }
    });
  });
  const units = contextFor(m, context),
    order = new Map(context.unitOrder.map((id, i) => [id, i]));
  const sequence = context.unitOrder.flatMap((id) => units.get(id).runs);
  const positions = new Map(sequence.map((r, i) => [r, i]));
  const comments = new Set();
  for (const c of m.comments) {
    keys(c, "id quote note replacement status parts");
    check(
      typeof c.id === "string" &&
        /^hr-[a-f0-9]{20}$/.test(c.id) &&
        !comments.has(c.id),
    );
    comments.add(c.id);
    check(
      typeof c.quote === "string" &&
        typeof c.note === "string" &&
        (c.replacement === null || scalar(c.replacement)),
    );
    bounded(bytes(c.note), L.RT_MAX_NOTE_BYTES);
    if (c.replacement !== null)
      bounded(bytes(c.replacement), L.RT_MAX_REPLACEMENT_BYTES);
    check(
      (c.replacement === null
        ? ["open", "resolved"]
        : ["open", "accepted", "rejected"]
      ).includes(c.status),
    );
    array(c.parts);
    check(c.parts.length > 0);
    bounded(c.parts.length, L.RT_MAX_PARTS);
    let previous = -1,
      first,
      last;
    c.parts.forEach((part, i) => {
      keys(part, "unit before");
      check(scalar(part.before) && part.before.length > 0);
      const owner = owners.get(c.id + ":" + i);
      check(
        owner && owner.unit === part.unit && order.get(part.unit) > previous,
      );
      previous = order.get(part.unit);
      check(
        owner.run.text ===
          (c.status === "accepted"
            ? i === 0
              ? c.replacement
              : ""
            : part.before),
      );
      const pos = positions.get(owner.run);
      if (i === 0) first = pos;
      last = pos;
      owners.delete(c.id + ":" + i);
    });
    for (let i = first; i <= last; i++)
      check(
        sequence[i].kind === "annotation"
          ? sequence[i].id === c.id
          : sequence[i].text === "",
      );
  }
  check(owners.size === 0);
  limits(m, context);
  return clone(m);
}
function coalesce(runs) {
  const out = [];
  for (const r of runs) {
    if (r.kind === "text") {
      if (!r.text) continue;
      if (out.at(-1)?.kind === "text") out.at(-1).text += r.text;
      else out.push({ ...r });
    } else out.push(r);
  }
  return out.length ? out : [{ kind: "text", text: "" }];
}
function boundary(text, at) {
  return !(
    at > 0 &&
    at < text.length &&
    /[\ud800-\udbff]/.test(text[at - 1]) &&
    /[\udc00-\udfff]/.test(text[at])
  );
}
export function transition(input, action, context) {
  const m = validate(input, context),
    a = action,
    affected = new Set();
  const units = new Map(m.units.map((u) => [u.id, u]));
  if (a.type === "add") {
    keys(a, "type id quote note replacement slices canReplace");
    array(a.slices);
    check(a.slices.length > 0, "RT_SELECTION");
    bounded(a.slices.length, L.RT_MAX_PARTS);
    check(
      typeof a.canReplace === "boolean" &&
        (a.replacement === null || a.canReplace),
      "RT_SELECTION",
    );
    const parts = [],
      seen = new Set();
    let previous = -1;
    for (const p of a.slices) {
      keys(p, "unit run start end");
      const u = units.get(p.unit),
        r = u?.runs[p.run],
        index = context.unitOrder.indexOf(p.unit);
      check(
        u &&
          !seen.has(p.unit) &&
          index > previous &&
          integer(p.run) &&
          r?.kind === "text" &&
          integer(p.start) &&
          integer(p.end) &&
          p.start < p.end &&
          p.end <= r.text.length &&
          boundary(r.text, p.start) &&
          boundary(r.text, p.end),
        "RT_SELECTION",
      );
      seen.add(p.unit);
      previous = index;
      const before = r.text.slice(p.start, p.end),
        part = parts.length;
      parts.push({ unit: p.unit, before });
      u.runs.splice(
        p.run,
        1,
        ...coalesce([
          { kind: "text", text: r.text.slice(0, p.start) },
          { kind: "annotation", id: a.id, part, text: before },
          { kind: "text", text: r.text.slice(p.end) },
        ]),
      );
      affected.add(u.id);
    }
    m.comments.push({
      id: a.id,
      quote: a.quote,
      note: a.note,
      replacement: a.replacement,
      status: "open",
      parts,
    });
  } else {
    const c = m.comments.find((c) => c.id === a.id);
    check(c);
    if (a.type === "decide") {
      keys(a, "type id status");
      const allowed =
        c.replacement === null
          ? { open: ["resolved"], resolved: ["open"] }
          : {
              open: ["accepted", "rejected"],
              accepted: ["open"],
              rejected: ["open"],
            };
      check(allowed[c.status]?.includes(a.status));
      c.status = a.status;
      for (const u of m.units)
        for (const r of u.runs)
          if (r.kind === "annotation" && r.id === c.id) {
            r.text =
              c.status === "accepted"
                ? r.part === 0
                  ? c.replacement
                  : ""
                : c.parts[r.part].before;
            affected.add(u.id);
          }
    } else if (a.type === "edit") {
      keys(a, "type id note replacement canReplace");
      check(c.status !== "accepted");
      check(
        typeof a.canReplace === "boolean" &&
          (a.replacement === null || a.canReplace),
        "RT_SELECTION",
      );
      c.note = a.note;
      if (c.replacement !== a.replacement) {
        c.replacement = a.replacement;
        c.status = "open";
        c.parts.forEach((p) => affected.add(p.unit));
      }
    } else if (a.type === "remove") {
      keys(a, "type id");
      m.comments = m.comments.filter((item) => item.id !== c.id);
      for (const u of m.units)
        if (u.runs.some((r) => r.kind === "annotation" && r.id === c.id)) {
          u.runs = coalesce(
            u.runs.map((r) =>
              r.kind === "annotation" && r.id === c.id
                ? { kind: "text", text: r.text }
                : r,
            ),
          );
          affected.add(u.id);
        }
    } else fail();
  }
  return {
    model: validate(m, context),
    changedUnitIds: context.unitOrder.filter((id) => affected.has(id)),
  };
}
export function derivePreview(input, context) {
  const m = validate(input, context),
    pending = m.comments.filter(
      (c) => c.status === "open" && c.replacement !== null,
    ),
    byId = new Map(pending.map((c) => [c.id, c]));
  for (const u of m.units)
    for (const r of u.runs)
      if (r.kind === "annotation" && byId.has(r.id))
        r.text = r.part === 0 ? byId.get(r.id).replacement : "";
  limits(m, context);
  return { units: m.units, pendingIds: pending.map((c) => c.id) };
}
