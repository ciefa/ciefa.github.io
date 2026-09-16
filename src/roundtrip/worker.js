import { parse, parseFragment, defaultTreeAdapter as D } from "parse5";
import * as L from "./limits.js";
import { currentText, encodeTextPatch } from "./model.js";
const enc = new TextEncoder(),
  bytes = (s) => enc.encode(s).length;
const fail = (code = "RT_INELIGIBLE") => {
  throw Object.assign(new Error(code), { code });
};
const check = (ok, code) => {
  if (!ok) fail(code);
};
const scalar = (s) =>
  typeof s === "string" &&
  !/[\u0000\ud800-\udfff]/u.test(
    s.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""),
  );
const HTML = "http://www.w3.org/1999/xhtml";
const excluded = new Set([
  "script",
  "style",
  "title",
  "textarea",
  "select",
  "button",
  "helmet",
  "sc-helmet",
]);
const structural = new Set([
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "sc-raw-table",
  "sc-raw-thead",
  "sc-raw-tbody",
  "sc-raw-tfoot",
  "sc-raw-tr",
]);
const forbidden = new Set([
  "noscript",
  "template",
  "xmp",
  "plaintext",
  "listing",
  "iframe",
  "frame",
  "noframes",
]);
const white = (s) => /^[\t\n\f\r ]*$/.test(s);
function adapter() {
  let nodes = 0,
    attrs = 0;
  const height = new WeakMap();
  const count = () => check(++nodes <= L.RT_MAX_PARSE_NODES, "RT_LIMIT");
  const attributes = (list, existing = 0) => {
    attrs += list.length;
    check(
      list.length + existing <= L.RT_MAX_ELEMENT_ATTRIBUTES &&
        attrs <= L.RT_MAX_ALL_ATTRIBUTES,
      "RT_LIMIT",
    );
  };
  const attach = (p, n) => {
    let depth = 0,
      a = p;
    while (a.parentNode) {
      depth++;
      a = a.parentNode;
      check(depth <= L.RT_MAX_TREE_DEPTH, "RT_LIMIT");
    }
    check(depth + 1 + (height.get(n) || 0) <= L.RT_MAX_TREE_DEPTH, "RT_LIMIT");
    let h = (height.get(n) || 0) + 1;
    for (a = p; a; a = a.parentNode) {
      if ((height.get(a) || 0) >= h) break;
      height.set(a, h++);
    }
  };
  const a = { ...D };
  for (const name of [
    "createDocument",
    "createDocumentFragment",
    "createCommentNode",
    "createTextNode",
  ])
    a[name] = (...args) => {
      count();
      return D[name](...args);
    };
  a.createElement = (tag, ns, list) => {
    count();
    attributes(list);
    return D.createElement(tag, ns, list);
  };
  a.appendChild = (p, n) => {
    attach(p, n);
    D.appendChild(p, n);
  };
  a.insertBefore = (p, n, r) => {
    attach(p, n);
    D.insertBefore(p, n, r);
  };
  a.detachNode = (n) => {
    let p = n.parentNode;
    D.detachNode(n);
    while (p) {
      let h = 0;
      for (const child of p.childNodes || [])
        h = Math.max(h, 1 + (height.get(child) || 0));
      if (p.content) h = Math.max(h, 1 + (height.get(p.content) || 0));
      if ((height.get(p) || 0) === h) break;
      height.set(p, h);
      p = p.parentNode;
    }
  };
  a.setTemplateContent = (p, n) => {
    attach(p, n);
    D.setTemplateContent(p, n);
    n.parentNode = p;
  };
  a.insertText = (p, text) => {
    const last = p.childNodes.at(-1);
    if (last?.nodeName === "#text") last.value += text;
    else a.appendChild(p, a.createTextNode(text));
  };
  a.insertTextBefore = (p, text, r) => {
    const last = p.childNodes[p.childNodes.indexOf(r) - 1];
    if (last?.nodeName === "#text") last.value += text;
    else a.insertBefore(p, a.createTextNode(text), r);
  };
  a.setDocumentType = (p, name, publicId, systemId) => {
    const n = p.childNodes.find((n) => n.nodeName === "#documentType");
    if (n) Object.assign(n, { name, publicId, systemId });
    else {
      count();
      a.appendChild(p, {
        nodeName: "#documentType",
        name,
        publicId,
        systemId,
        parentNode: null,
      });
    }
  };
  a.adoptAttributes = (p, list) => {
    const names = new Set(p.attrs.map((a) => a.name)),
      fresh = list.filter((a) => !names.has(a.name));
    attributes(fresh, p.attrs.length);
    p.attrs.push(...fresh);
  };
  return a;
}
function parseBounded(text, scriptingEnabled = false, fragment = false) {
  const options = {
    treeAdapter: adapter(),
    sourceCodeLocationInfo: true,
    scriptingEnabled,
    onParseError: (e) => {
      if (
        e.code !== "missing-doctype" &&
        !(
          e.code === "control-character-reference" &&
          text.slice(Math.max(0, e.startOffset - 5), e.startOffset) === "&#13;"
        )
      )
        fail();
    },
  };
  return fragment
    ? parseFragment(D.createElement("div", HTML, []), text, options)
    : parse(text, options);
}
function walk(root, fn) {
  const stack = [{ n: root, path: [] }];
  while (stack.length) {
    const { n, path } = stack.pop();
    fn(n, path);
    for (let i = (n.childNodes?.length || 0) - 1; i >= 0; i--)
      stack.push({ n: n.childNodes[i], path: [...path, i] });
  }
}
function canonical(root) {
  const out = [],
    stack = [{ n: root, exit: false }];
  while (stack.length) {
    const { n, exit } = stack.pop();
    if (exit) {
      out.push(["end"]);
      continue;
    }
    if (n.nodeName === "#text") {
      if (n.value) {
        if (out.at(-1)?.[0] === "text") out.at(-1)[1] += n.value;
        else out.push(["text", n.value]);
      }
      continue;
    }
    if (n.nodeName === "#comment") {
      out.push(["comment", n.data]);
      continue;
    }
    if (n.nodeName === "#documentType") {
      out.push(["doctype", n.name, n.publicId, n.systemId]);
      continue;
    }
    if (n.nodeName === "#document")
      out.push(["document", n.mode === "quirks" ? "BackCompat" : "CSS1Compat"]);
    else
      out.push([
        "element",
        n.namespaceURI,
        n.tagName,
        (n.attrs || [])
          .map((a) => [a.namespace || "", a.name, a.value])
          .sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b), "en"),
          ),
      ]);
    stack.push({ n, exit: true });
    for (let i = (n.childNodes?.length || 0) - 1; i >= 0; i--)
      stack.push({ n: n.childNodes[i], exit: false });
  }
  return out;
}
function markers(doc) {
  const result = {},
    bounds = {};
  walk(doc, (n) => {
    if (n.tagName === "meta") {
      const attrs = Object.fromEntries(n.attrs.map((a) => [a.name, a.value]));
      if (attrs.charset !== undefined)
        check(attrs.charset.toLowerCase() === "utf-8", "RT_ENCODING");
      if (attrs["http-equiv"]?.toLowerCase() === "content-type")
        for (const match of (attrs.content || "").matchAll(
          /charset\s*=\s*["']?([^\s;"']+)/gi,
        ))
          check(match[1].toLowerCase() === "utf-8", "RT_ENCODING");
    }
    if (n.tagName !== "script") return;
    const type = n.attrs.find((a) => a.name === "type")?.value;
    if (!type?.startsWith("__bundler/")) return;
    const key = type.slice(10),
      loc = n.sourceCodeLocation;
    check(
      ["manifest", "template", "ext_resources", "page_order"].includes(key) &&
        !Object.hasOwn(result, key) &&
        loc?.startTag &&
        loc?.endTag &&
        !n.attrs.some((a) => a.name === "src"),
    );
    result[key] = (n.childNodes || []).map((n) => n.value || "").join("");
    bounds[key] = [loc.startTag.endOffset, loc.endTag.startOffset];
  });
  check(Object.hasOwn(result, "manifest") && Object.hasOwn(result, "template"));
  return { descriptor: result, bounds };
}
function parseOuter(text) {
  const a = markers(parseBounded(text, false)),
    b = markers(parseBounded(text, true));
  check(JSON.stringify(a) === JSON.stringify(b));
  return a;
}
function templateInfo(text) {
  check(scalar(text));
  check(bytes(text) <= L.RT_MAX_TEMPLATE_BYTES, "RT_LIMIT");
  const doc = parseBounded(text),
    units = [];
  let body;
  walk(doc, (n) => {
    if (n.tagName === "body") body = n;
    if (
      forbidden.has(n.tagName) ||
      (n.nodeName === "#comment" && n.data.startsWith("hr2:"))
    )
      fail();
  });
  check(body);
  walk(doc, (n, path) => {
    if (n.nodeName !== "#text") return;
    let p = n.parentNode,
      inBody = false,
      skip = false;
    while (p) {
      if (p === body) inBody = true;
      if (excluded.has(p.tagName)) skip = true;
      p = p.parentNode;
    }
    if (
      !inBody ||
      skip ||
      (structural.has(n.parentNode.tagName) && white(n.value))
    )
      return;
    if (n.parentNode.namespaceURI !== HTML) {
      check(white(n.value));
      return;
    }
    const loc = n.sourceCodeLocation;
    check(loc && loc.endOffset > loc.startOffset);
    const preAtStart =
      n.parentNode.tagName === "pre" &&
      n.parentNode.childNodes[0] === n &&
      loc.startOffset === n.parentNode.sourceCodeLocation?.startTag?.endOffset;
    const raw = text.slice(loc.startOffset, loc.endOffset),
      fragment = parseBounded(raw, false, true);
    check(fragment.childNodes.every((n) => n.nodeName === "#text"));
    let decoded = fragment.childNodes.map((n) => n.value).join("");
    if (preAtStart && decoded.startsWith("\n")) decoded = decoded.slice(1);
    check(decoded === n.value);
    units.push({
      start: loc.startOffset,
      end: loc.endOffset,
      original: n.value,
      path,
      preAtStart,
    });
    check(units.length <= L.RT_MAX_UNITS, "RT_LIMIT");
  });
  units.sort((a, b) => a.start - b.start);
  check(units.length > 0);
  let end = 0;
  units.forEach((u, i) => {
    check(u.start >= end);
    end = u.end;
    u.id = "u" + String(i + 1).padStart(6, "0");
  });
  return { units, tree: canonical(doc), doc };
}
const hash = async (data) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
async function decode(raw) {
  check(raw instanceof Uint8Array && raw.byteLength > 0);
  check(raw.byteLength <= L.RT_MAX_INPUT_BYTES, "RT_LIMIT");
  const bomBytes = raw[0] === 239 && raw[1] === 187 && raw[2] === 191 ? 3 : 0;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      raw.subarray(bomBytes),
    );
  } catch {
    fail("RT_ENCODING");
  }
  return { text, bomBytes, sha256: await hash(raw) };
}
async function analyze(raw) {
  const decoded = await decode(raw),
    outer = parseOuter(decoded.text);
  let template;
  try {
    template = JSON.parse(outer.descriptor.template);
  } catch {
    fail();
  }
  const info = templateInfo(template);
  const source = {
    profile: "bundler-template-text-v1",
    mappingVersion: 1,
    sha256: decoded.sha256,
    byteLength: raw.byteLength,
    encoding: "utf-8",
    bomBytes: decoded.bomBytes,
    templateSha256: await hash(enc.encode(template)),
    template,
  };
  return {
    source,
    units: info.units,
    tree: info.tree,
    descriptor: outer.descriptor,
  };
}
function compareUnits(units, saved) {
  check(
    Array.isArray(saved) && units.length === saved.length,
    "RT_INVALID_REVIEW",
  );
  units.forEach((u, i) =>
    check(
      ["id", "start", "end", "original"].every((k) => u[k] === saved[i][k]),
      "RT_INVALID_REVIEW",
    ),
  );
}
async function validateTemplate(source, savedUnits) {
  check(
    source?.profile === "bundler-template-text-v1" &&
      source.mappingVersion === 1,
    "RT_VERSION",
  );
  const info = templateInfo(source.template);
  check(
    (await hash(enc.encode(source.template))) === source.templateSha256,
    "RT_INVALID_REVIEW",
  );
  compareUnits(info.units, savedUnits);
  return { units: info.units, tree: info.tree };
}
async function exportOriginal(raw, source, units) {
  const decoded = await decode(raw);
  check(
    raw.byteLength === source.byteLength &&
      decoded.sha256 === source.sha256 &&
      decoded.bomBytes === source.bomBytes,
    "RT_SOURCE_MISMATCH",
  );
  const outer = parseOuter(decoded.text);
  let template;
  try {
    template = JSON.parse(outer.descriptor.template);
  } catch {
    fail("RT_SOURCE_MISMATCH");
  }
  check(
    template === source.template &&
      (await hash(enc.encode(template))) === source.templateSha256,
    "RT_SOURCE_MISMATCH",
  );
  const info = templateInfo(template);
  compareUnits(info.units, units);
  const patches = [];
  let textBytes = 0,
    runCount = 0;
  units.forEach((u, i) => {
    check(Array.isArray(u.runs) && u.runs.length > 0, "RT_INVALID_REVIEW");
    runCount += u.runs.length;
    check(runCount <= L.RT_MAX_RUNS, "RT_LIMIT");
    for (const run of u.runs) {
      check(scalar(run.text), "RT_PATCH_INVALID");
      textBytes += bytes(run.text);
      check(textBytes <= L.RT_MAX_CURRENT_TEXT_BYTES, "RT_LIMIT");
    }
    const text = currentText(u);
    if (text !== u.original) {
      patches.push({ ...info.units[i], text });
      let n = info.doc;
      for (const index of info.units[i].path) n = n.childNodes[index];
      n.value = text;
    }
  });
  check(textBytes <= L.RT_MAX_CURRENT_TEXT_BYTES, "RT_LIMIT");
  if (!patches.length) return { changedUnits: 0, byteLength: raw.byteLength };
  const parts = [];
  let position = 0;
  for (const p of patches) {
    parts.push(
      template.slice(position, p.start),
      encodeTextPatch(p.text, p.preAtStart),
    );
    position = p.end;
  }
  parts.push(template.slice(position));
  const patched = parts.join("");
  check(bytes(patched) <= L.RT_MAX_TEMPLATE_BYTES, "RT_LIMIT");
  let patchedDoc;
  try {
    patchedDoc = parseBounded(patched);
  } catch (e) {
    if (e.code === "RT_LIMIT") throw e;
    fail("RT_PATCH_INVALID");
  }
  check(
    JSON.stringify(canonical(patchedDoc)) ===
      JSON.stringify(canonical(info.doc)),
    "RT_PATCH_INVALID",
  );
  walk(patchedDoc, (n) => {
    if (n.nodeName !== "#text" || !/\{\{[\s\S]*?\}\}/.test(n.value)) return;
    let p = n.parentNode,
      allowed = false;
    while (p) {
      if (["script", "style", "pre", "code"].includes(p.tagName))
        allowed = true;
      p = p.parentNode;
    }
    check(allowed, "RT_PATCH_INVALID");
  });
  const json = JSON.stringify(patched).replace(
    /[<\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  check(JSON.parse(json) === patched, "RT_PATCH_INVALID");
  const [start, end] = outer.bounds.template,
    startByte = bytes(decoded.text.slice(0, start)) + decoded.bomBytes,
    endByte = bytes(decoded.text.slice(0, end)) + decoded.bomBytes;
  const jsonBytes = enc.encode(json),
    outputLength = startByte + jsonBytes.byteLength + raw.byteLength - endByte;
  check(outputLength <= L.RT_MAX_DOWNLOAD_BYTES, "RT_LIMIT");
  const output = new Uint8Array(outputLength);
  output.set(raw.subarray(0, startByte));
  output.set(jsonBytes, startByte);
  output.set(raw.subarray(endByte), startByte + jsonBytes.byteLength);
  const verification = parseOuter(
    decoded.text.slice(0, start) + json + decoded.text.slice(end),
  );
  check(
    Object.keys(verification.descriptor).join() ===
      Object.keys(outer.descriptor).join() &&
      JSON.parse(verification.descriptor.template) === patched,
    "RT_PATCH_INVALID",
  );
  for (const key of Object.keys(outer.descriptor))
    if (key !== "template")
      check(
        verification.descriptor[key] === outer.descriptor[key],
        "RT_PATCH_INVALID",
      );
  // Verify byte preservation independently of the parser's character offsets.
  for (let i = 0; i < startByte; i++)
    check(output[i] === raw[i], "RT_PATCH_INVALID");
  for (let i = endByte; i < raw.byteLength; i++)
    check(
      output[startByte + jsonBytes.byteLength + i - endByte] === raw[i],
      "RT_PATCH_INVALID",
    );
  return {
    buffer: output.buffer,
    changedUnits: patches.length,
    byteLength: output.byteLength,
  };
}
self.onmessage = async ({ data }) => {
  const { requestId, generation, op, payload } = data;
  try {
    if (payload.buffer instanceof ArrayBuffer) {
      payload.raw = new Uint8Array(payload.buffer);
      delete payload.buffer;
    }
    let result;
    if (op === "analyzeSource") result = await analyze(payload.raw);
    else if (op === "validateTemplate")
      result = await validateTemplate(payload.source, payload.units);
    else if (op === "exportOriginal")
      result = await exportOriginal(payload.raw, payload.source, payload.units);
    else fail("RT_FAILED");
    self.postMessage(
      { requestId, generation, ok: true, result },
      result.buffer ? [result.buffer] : [],
    );
  } catch (e) {
    self.postMessage({
      requestId,
      generation,
      ok: false,
      code: e.code || "RT_FAILED",
    });
  }
};
let capable = false;
try {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let fatal = false;
  try {
    decoder.decode(new Uint8Array([255]));
  } catch {
    fatal = true;
  }
  capable = !!(
    fatal &&
    crypto.subtle &&
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }) &&
    new Intl.Segmenter("und", { granularity: "grapheme" })
  );
} catch {}
self.postMessage({ type: "ready", capable });
