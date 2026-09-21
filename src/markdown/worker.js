import {
  create,
  verify,
  validate,
  sourceBytes,
  check,
  fail,
} from "./workspace.js";
import { readZip, writeZip } from "./archive.js";
import { preview } from "./preview.js";
import { MD_MAX_INPUT_BYTES } from "./limits.js";
self.onmessage = async ({ data }) => {
  const { requestId, generation, op, payload } = data;
  try {
    let result;
    if (op === "importMarkdown") {
      check(
        payload.files.reduce((n, f) => n + f.buffer.byteLength, 0) <=
          MD_MAX_INPUT_BYTES,
        "MD_LIMIT",
      );
      const entries = payload.zip
        ? readZip(new Uint8Array(payload.files[0].buffer))
        : payload.files.map((f) => ({
            path: f.name,
            data: new Uint8Array(f.buffer),
          }));
      result = await create(entries, payload.name);
    } else if (op === "restoreMarkdown")
      result = await verify(payload.workspace);
    else if (op === "previewMarkdown") result = { html: preview(payload.text) };
    else if (op === "exportMarkdown") {
      const workspace = validate(payload.workspace);
      const docs = payload.id
        ? workspace.documents.filter((d) => d.id === payload.id)
        : workspace.documents;
      check(docs.length > 0);
      const entries = docs.map((d) => ({
        path: d.path,
        data: sourceBytes(d.source, d.runs.map((r) => r.text).join("")),
      }));
      const output = payload.id ? entries[0].data : writeZip(entries);
      result = { buffer: output.buffer };
    } else fail("MD_FAILED");
    self.postMessage(
      { requestId, generation, ok: true, result },
      result.buffer ? [result.buffer] : [],
    );
  } catch (e) {
    self.postMessage({
      requestId,
      generation,
      ok: false,
      code: /^(MD_|RT_)/.test(e.code) ? e.code : "MD_FAILED",
    });
  }
};
self.postMessage({ type: "ready", capable: !!crypto.subtle });
