import * as L from "./limits.js";
import { validate as validateModel, currentText } from "../roundtrip/model.js";
export { INDENT, indentLines } from "./editing.js";
export const FORMAT = "local-markdown-workspace-v1";
export const DOCUMENT_FORMAT = "local-markdown-document-v1";
export const bytes = (s) => new TextEncoder().encode(s);
export const fail = (code = "MD_REVIEW") => {
  throw Object.assign(new Error(code), { code });
};
export const check = (ok, code) => {
  if (!ok) fail(code);
};
const keys = (v, names) =>
  check(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).sort().join(" ") === names.split(" ").sort().join(" "),
  );
const scalar = (s) =>
  typeof s === "string" &&
  !/[\u0000\ud800-\udfff]/u.test(
    s.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""),
  );
export const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function pathKey(path, directory = false) {
  check(
    typeof path === "string" && scalar(path) && bytes(path).length <= 1024,
    "MD_PATH",
  );
  const p = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  check(p && !/[\\:\u0000-\u001f\u007f]/.test(p), "MD_PATH");
  check(
    p
      .split("/")
      .every(
        (s) =>
          s &&
          ![".", ".."].includes(s) &&
          !/[. ]$/.test(s) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
      ),
    "MD_PATH",
  );
  return p.normalize("NFC").toLowerCase();
}
export function validatePaths(paths) {
  const seen = new Set();
  for (const p of paths) {
    const k = pathKey(p);
    check(!seen.has(k), "MD_PATH");
    seen.add(k);
  }
  for (const p of seen) {
    const parts = p.split("/");
    parts.pop();
    while (parts.length) {
      check(!seen.has(parts.join("/")), "MD_PATH");
      parts.pop();
    }
  }
}
export function sourceBytes(source, text = source.text) {
  const body = bytes(text);
  if (!source.bomBytes) return body;
  const output = new Uint8Array(body.length + 3);
  output.set([239, 187, 191]);
  output.set(body, 3);
  return output;
}
export async function digest(data) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
export async function decodeSource(data) {
  check(data.length <= L.MD_MAX_SOURCE_BYTES, "MD_LIMIT");
  let text;
  const bomBytes =
    data[0] === 239 && data[1] === 187 && data[2] === 191 ? 3 : 0;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      data.subarray(bomBytes),
    );
  } catch {
    fail("MD_ENCODING");
  }
  check(scalar(text), "MD_ENCODING");
  return {
    text,
    bomBytes,
    byteLength: data.length,
    sha256: await digest(data),
  };
}
export function newline(source) {
  return /\r\n|\r|\n/.exec(source.text)?.[0] || "\n";
}
export function replacement(source, text) {
  return text === null ? null : text.replace(/\r\n|\r|\n/g, newline(source));
}
export const context = (m) => ({
  sourceUnits: m.units.map((u) => ({ ...u, preAtStart: false })),
  unitOrder: ["u000001"],
});
export function documentModel(d, view, baseHtml = "") {
  return {
    format: DOCUMENT_FORMAT,
    originalName: d.path,
    source: {
      profile: "markdown-source-v1",
      mappingVersion: 1,
      encoding: "utf-8",
      ...d.source,
    },
    baseHtml,
    units: [
      {
        id: "u000001",
        start: 0,
        end: d.source.text.length,
        original: d.source.text,
        runs: d.runs,
      },
    ],
    comments: d.comments,
    view: { ...view },
  };
}
export function fromModel(d, model) {
  return { ...d, runs: model.units[0].runs, comments: model.comments };
}
export function validate(value) {
  keys(value, "format name activeDocumentId view documents");
  check(
    value.format === FORMAT &&
      scalar(value.name) &&
      value.name.length > 0 &&
      value.name.length <= 1024,
  );
  keys(value.view, "previewOpen scrollTogether");
  check(
    typeof value.view.previewOpen === "boolean" &&
      typeof value.view.scrollTogether === "boolean",
  );
  check(
    Array.isArray(value.documents) &&
      value.documents.length > 0 &&
      value.documents.length <= L.MD_MAX_DOCUMENTS,
    "MD_LIMIT",
  );
  validatePaths(value.documents.map((d) => d?.path));
  let originalBytes = 0,
    currentBytes = 0,
    last = null;
  value.documents.forEach((d, i) => {
    keys(d, "id path source runs comments");
    check(
      d.id === "d" + String(i + 1).padStart(4, "0") &&
        /\.(md|markdown)$/i.test(d.path) &&
        (last === null || compare(last, d.path) < 0),
    );
    last = d.path;
    keys(d.source, "text bomBytes byteLength sha256");
    const s = d.source;
    check(
      scalar(s.text) &&
        [0, 3].includes(s.bomBytes) &&
        Number.isSafeInteger(s.byteLength) &&
        s.byteLength >= 0 &&
        /^[a-f0-9]{64}$/.test(s.sha256),
    );
    check(bytes(s.text).length + s.bomBytes === s.byteLength);
    check(s.byteLength <= L.MD_MAX_SOURCE_BYTES, "MD_LIMIT");
    const m = documentModel(d, value.view);
    validateModel(m, context(m));
    const size = bytes(currentText(m.units[0])).length + s.bomBytes;
    check(size <= L.MD_MAX_CURRENT_BYTES, "MD_LIMIT");
    originalBytes += s.byteLength;
    currentBytes += size;
  });
  check(value.documents.some((d) => d.id === value.activeDocumentId));
  check(
    originalBytes <= L.MD_MAX_TOTAL_SOURCE_BYTES &&
      currentBytes <= L.MD_MAX_TOTAL_CURRENT_BYTES,
    "MD_LIMIT",
  );
  check(
    bytes(JSON.stringify(value)).length <= L.MD_MAX_PAYLOAD_BYTES,
    "MD_LIMIT",
  );
  return value;
}
export async function verify(value) {
  validate(value);
  for (const d of value.documents)
    check((await digest(sourceBytes(d.source))) === d.source.sha256);
  return value;
}
export async function create(entries, name = "documents") {
  check(entries.length > 0 && entries.length <= L.MD_MAX_DOCUMENTS, "MD_LIMIT");
  validatePaths(entries.map((e) => e.path));
  check(
    entries.every((e) => /\.(md|markdown)$/i.test(e.path)),
    "MD_INPUT",
  );
  check(
    entries.reduce((n, e) => n + e.data.length, 0) <=
      L.MD_MAX_TOTAL_SOURCE_BYTES,
    "MD_LIMIT",
  );
  entries.sort((a, b) => compare(a.path, b.path));
  const documents = [];
  for (const e of entries) {
    const source = await decodeSource(e.data);
    documents.push({
      id: "d" + String(documents.length + 1).padStart(4, "0"),
      path: e.path,
      source,
      runs: [{ kind: "text", text: source.text }],
      comments: [],
    });
  }
  return validate({
    format: FORMAT,
    name,
    activeDocumentId: "d0001",
    view: { previewOpen: true, scrollTogether: true },
    documents,
  });
}
