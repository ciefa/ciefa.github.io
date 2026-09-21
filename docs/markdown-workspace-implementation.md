# Multi-document Markdown workspace: implementation specification

Date: 2026-09-21. Status: implemented and verified; see [testing.md](testing.md#markdown-workspace-validation-record).
Baseline: `965be6fb94dacf32920ad5a9e7d8247da17499b7`.

This specification is normative. The [research report](markdown-workspace-research.md) explains the alternatives. Implement the decisions here without selecting another editing mode, archive policy, or persistence design. Existing HTML v1/v2 contracts continue to apply.

## 1. User outcome and scope

Open one or more `.md`/`.markdown` files, or one ZIP containing Markdown files. Keep an independent source, annotations, and accepted changes for each document. Switch documents from a visible document list without losing changes. Save the entire workspace as one portable annotated HTML application. Export all documents as a ZIP with each file at its original relative path, or download the current document alone.

The left pane is **Markdown source** in wrapping monospace text. Select source text to comment or suggest a literal Markdown replacement. The right pane is a **formatted CommonMark preview with pending suggestions applied**. Do not allow annotations in the preview, promise exact project rendering, or map old HTML annotations back to Markdown. Source syntax is visible and editable through suggestions; template code is never executed. The UI must explicitly explain this mode and that custom templates/assets are not expanded.

No directory picker, adding/removing/renaming documents after import, mixed HTML/Markdown workspaces, collaborative merging, automatic build integration, automatic file writes, or generated HTML export for Markdown in this release. Opening another file selection replaces the entire workspace after the existing unsaved-change check. Empty files are allowed and exported, but adding content without a selection is out of scope.

## 2. Fixed dependencies and modules

Pin `fflate` 0.8.3 and `micromark` 4.0.2 as development dependencies. Keep current parser, esbuild, Playwright, and Node >=22 requirements. Retain resolved transitive versions in the lockfile. Bundle all runtime dependencies into `index.html`; no CDN, network request, or runtime installation. Include exact license notices for every bundled package in a generated license artifact and in the application.

| File | Responsibility |
| --- | --- |
| `src/markdown/limits.js` | Immutable named limits below. |
| `src/markdown/archive.js` | ZIP directory validation, incremental inflation, CRC verification, deterministic ZIP export. |
| `src/markdown/workspace.js` | Source decoding/encoding, path validation, schema validation, conversion to/from document models. |
| `src/markdown/preview.js` | CommonMark preview, inert template placeholders, no resource loading. |
| `src/markdown/worker.js` | Import, reopen verification, preview, and ZIP export operations. |
| `src/roundtrip/model.js` | Explicit additional Markdown-document profile in the existing durable run model. Preserve HTML contracts. |
| `scripts/build-markdown.mjs` | Deterministic inline worker/core artifact and license generation/check. |
| `index.html` | Workspace UI/controller, document switching, input routing, save/export and lifecycle. |
| `tests/markdown-*.spec.cjs` | Functional, malformed-input, persistence, preview, lifecycle, and performance coverage. |
| `tests/helpers/markdown-fixtures.cjs` | Synthetic files/archives only. |
| `docs/testing.md` | Commands and actual validation results. |

Generate a separate `<!-- MD GENERATED START -->` / `<!-- MD GENERATED END -->` region before the main application script. It declares frozen lexical `markdownWorkspace` and `markdownBounds` objects and contains JSON-encoded `script#markdown-worker` plus dependency notices. Escape `<`, U+2028, and U+2029 in embedded JSON; reject incomplete, reversed, or repeated boundaries. When both markers are absent, insert at the unique main-script boundary. Use existing esbuild browser/IIFE/es2022/minified/no-sourcemap conventions; set the worker build's `conditions:['worker']` so named-entity decoding uses the DOM-free package export. Export the artifact generator for tests. `--check` is read-only. Add `build:markdown`, `check:markdown-build`, `build` (both generators), `check:build` (both checks), and `test:markdown` commands. Extend the existing performance command.

## 3. Inputs, paths, and ordering

Extend the existing file input to `multiple` and accept `.html,.htm,.md,.markdown,.zip`. Preserve single HTML behavior. One ZIP alone or one-or-more Markdown files is valid. Reject multiple ZIPs, ZIP mixed with other files, HTML mixed with other files, and unsupported types. Input extension comparison is case-insensitive. MIME type alone does not identify Markdown or ZIP. Update drag/drop in the outer document and both frames to pass the full file list.

For loose files use `File.name` only. ZIP entries retain their complete relative paths. Do not normalize, flatten, rename, strip a top-level folder, or change Unicode normalization in saved/exported paths. Sort files by JavaScript code-unit comparison of exact paths; assign IDs `d0001`, `d0002`, etc. in this order. Initial active file is the first. The list displays full paths, current selection, and annotation counts for each file.

Validate paths before creating maps or inflating data. Reject empty paths, leading `/`, `\\`, any backslash, colon, control characters U+0000–001F/U+007F, empty slash segments, `.` or `..` segments, trailing dot/space in a segment, and Windows device-name segments (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, including extensions). Reject files whose paths collide after NFC normalization plus lowercase, and file/directory prefix conflicts. Preserve accepted names exactly; this collision check does not rename them. Reject a filename longer than 1,024 UTF-8 bytes. Accept `.md` and `.markdown` only.

ZIP imports are Markdown-only. Valid directory entries may be omitted, including empty directories. Any other regular file type fails the entire import, with a message explaining the Markdown-only requirement. Do not silently filter extra files or recursively unpack archives.

## 4. ZIP format contract

Support single-disk non-ZIP64 archives, compression methods 0 (stored) and 8 (DEFLATE), with or without bit-3 data descriptors. Accept bit-11 UTF-8 names; without that flag accept ASCII names only. UTF-8 decoding is fatal. Unsupported encodings, encryption, symlinks and other special Unix file types, ZIP64 markers/extra fields, and unsupported flags fail import. Deflate option bits 1/2 are allowed only with method 8.

Locate an EOCD record whose declared comment ends exactly at input EOF. Validate disk counts, entry counts, central-directory bounds/size, and complete consumption. No prepended executable payload, overlapping local records, central/local name or method/flag disagreement, gaps between local records, or unexplained records. Directory entries must have zero uncompressed bytes and no special type. Unknown well-formed non-ZIP64 extra fields and archive/entry comments can be ignored.

Before decompression, validate every central entry, corresponding local header, extra-field boundaries, declared sizes, payload range, and descriptors. With bit 3 off, local CRC/sizes must equal central values. With bit 3 on, local zero fields or matching fields are permitted; descriptor must exactly match CRC/sizes, with optional signature. Cross-check every value against actual output. Compute CRC-32 with polynomial `0xedb88320`. Reject CRC mismatch, truncation, extra DEFLATE output, inconsistent lengths, and corrupt compressed data.

Feed at most 1,024 compressed bytes at a time into `fflate.Inflate`; stop if output exceeds its declared size or resource limits. Never allocate based only on untrusted decompressed-size claims. Run decompression in the worker. For pinned fflate 0.8.3, also require `stream.s.f === 1` and `stream.p.length === (stream.s.p ? 1 : 0)` after the final chunk to reject missing final blocks or trailing full compressed bytes; cover this pinned internal-state check with archive regression tests. This bounds application input/output accounting; it is not a portable hard heap guarantee for the compression library.

Export a new ZIP with all Markdown files, exact paths, UTF-8 names, fixed local date 1980-01-01 00:00:00, compression level 6, and sorted file order. Do not claim identical ZIP bytes to input. Do not preserve input permissions, timestamps, comments, compression, or empty-directory entries. Preserve each file's content according to section 5.

## 5. Source and edit fidelity

Strict UTF-8 only, with optional single leading BOM. Reject UTF-16 BOMs, invalid UTF-8, U+0000, and malformed Unicode. Keep the decoded original string without newline normalization, plus `bomBytes` (0 or 3), original byte length, and SHA-256. A second BOM is ordinary source content. Hashes establish consistency, not authorship.

Each document uses **one source unit covering the entire original string**. Offsets are UTF-16 string offsets, never byte positions. Empty originals use `[0,0]`. The immutable source and annotation-owned text runs use the existing v2 add/edit/decide/remove semantics. This supplies reliable mappings after comments are removed. One unit permits literal replacements across paragraphs, lists, formatting markers, and physical lines. Do not parse or serialize Markdown during clean source export.

Preserve every unselected character through the run model. For user-entered replacement text, normalize CRLF/CR/LF to the first newline sequence occurring in the original file; use LF when it has none. This normalization is for replacement input only. Existing mixed line endings remain untouched. Reopening/editing an existing suggestion applies the same rule before comparing replacements. Reject selections splitting a grapheme, including a CRLF pair. Retain overlap guards for empty deletion annotations. Empty replacements mean deletion. A fully deleted file remains in the workspace/export. No insertion-only UI is added. Selections must include a non-whitespace character, matching the existing reviewer.

Export the concatenated current runs as UTF-8 with the original leading BOM. No comments, statuses, pending/rejected replacements, or reviewer delimiters enter `.md` exports. Accepted changes remain when their annotations are removed. Undo restores `parts[].before`. If current text equals original, reconstructed bytes must equal original bytes exactly. Repeated source strings in different files are independent.

## 6. Persistence and model schemas

New saved workspace discriminator: `local-markdown-workspace-v1`. Do not change HTML saved formats or wrap HTML reviews in a workspace. Unknown saved formats fail instead of falling through to ordinary HTML.

The saved JSON contains exactly:

```js
{
  format: 'local-markdown-workspace-v1',
  name: 'documents',
  activeDocumentId: 'd0001',
  view: {previewOpen: true, scrollTogether: true},
  documents: [{
    id: 'd0001',
    path: 'chapters/intro.md',
    source: {text: '# Example\r\n', bomBytes: 0, byteLength: 11, sha256: '<64 lowercase hex>'},
    runs: [{kind: 'text', text: '# Example\r\n'}],
    comments: []
  }]
}
```

`name` is the ZIP basename without `.zip`; for loose files use `documents`. It is display/output metadata, never a path. Sanitize download basenames with the existing filename character rules. Document IDs must match their sorted ordinal. All fields are required, no additional fields. Runs/comments have the existing exact v2 shapes and invariants. No HTML, AST, worker state, URLs, or cached preview belongs to this payload. Keep scroll positions in memory only. Empty source is valid; zero documents is invalid.

At runtime derive a document model with `format:'local-markdown-document-v1'`, `originalName:path`, source `{profile:'markdown-source-v1',mappingVersion:1,encoding:'utf-8',text,bomBytes,byteLength,sha256}`, the same `units/comments/view` fields as v2, and a generated `baseHtml`. Unit ID is `u000001`, start 0, end `source.text.length`, original `source.text`. Its mapping context is one source unit with `preAtStart:false`. Derive a fixed escaped-source `<pre id="markdown-source">` with empty `hr2:` delimiters; the frame receives current text through the existing mapped renderer. Never accept saved HTML for this profile.

Extend pure model validation/measurement explicitly for this format: different source schema, raw-source byte accounting instead of HTML text encoding, the one-unit identity invariant, and empty-original allowance. All HTML-specific validations stay in force on v2. Source original is capped at 1 MiB, current source at 2 MiB. Per-document annotations remain capped at 2,000, per-note/replacement at 64 KiB, and all existing run/Unicode invariants apply.

On reopen validate shape, sizes, paths, IDs, every document's run model, original byte length and SHA-256 before committing any document. Reconstruct all originals from UTF-8 text plus BOM; no source reattachment required. Source HTML is generated internally. A malformed inactive document invalidates the entire saved workspace. Do not import standalone `local-markdown-document-v1` payloads.

## 7. UI and operation lifecycle

Keep current HTML controls and labels available. Add an `Open Markdown / ZIP` button using the extended picker, a workspace document list (`#markdown-documents`), status/help text, and export actions `Export Markdown ZIP` and `Export current Markdown`. Hide Markdown controls outside a workspace; hide HTML-only export actions inside one. `Save annotated copy` saves **all documents** and clears the global dirty flag only after a successful download. Clean export does not clear it.

Maintain exactly one active document model and source frame, one preview frame, and at most one candidate frame. Inactive documents retain source/runs/comments in workspace state, not live iframes. The comments panel shows only the active document. Each document list button has its full path as accessible name and `aria-current` for the active one. Its separate count text is not part of the button name.

Switching flushes the current model into the workspace before staging the target. Preserve all edits, global dirty state, preview toggle, scroll-sync preference, and per-document source scroll position. A switch with a changed unfinished draft asks only whether to discard the draft; cancellation stays on the current document. Do not ask to discard already saved-in-memory annotations. Commit the active ID only after candidate validation succeeds. Failed imports/reopens/switches preserve the previous review. A new successful import clears old workspace/source caches.

Source pane explicitly says `Markdown source`; replacement input help says `Replacements are literal Markdown, including formatting and template syntax.` Preview help says `CommonMark preview. Templates and local assets are not expanded.` Do not show misleading per-suggestion highlights in the formatted preview; comments remain navigable in the source. Scroll synchronization uses proportional positions because source/preview structures differ.

Worker operations: `importMarkdown` (loose-file buffers or one ZIP), `restoreMarkdown` (saved workspace), `previewMarkdown` (derived current+pending string), `exportMarkdown` (validated workspace, optional document ID). Extend the existing request envelope with a worker selection based on operation name. Transfer input/output ArrayBuffers; do not rely on worker-side File/Blob reading. Requests carry generation/ID and ignore late replies. Terminate worker/revoke URLs on success, failure, cancellation and replacement. Preview has its own AbortController, is canceled before import/export/switch, and runs only when no foreground operation is active. Exports use a cancellable busy state; opening another selection cancels them. Never mutate models during worker serialization.

Preview generation uses micromark's default safe settings (`allowDangerousHtml:false`, `allowDangerousProtocol:false`). Replace each complete single-line `{{ ... }}` and `{% ... %}` span with a collision-free alphanumeric placeholder before Markdown parsing, then replace the emitted token with escaped literal `<code>` content. Unclosed/multiline expressions remain ordinary escaped Markdown. Do not evaluate or infer macro semantics. Raw HTML remains visible escaped text. Remove all preview image elements before staging (replace with inert alt text); disable all link navigation except local fragment scrolling. Preserve the existing sandbox and document CSP without additions. Preview does not load ZIP assets, data images, remote URLs, fonts, or scripts.

## 8. Fixed limits and errors

All comparisons accept equality. Export constants from `src/markdown/limits.js`:

| Constant | Value |
| --- | ---: |
| `MD_MAX_INPUT_BYTES` | 16 MiB (aggregate selected files or ZIP) |
| `MD_MAX_DOCUMENTS` | 100 |
| `MD_MAX_ZIP_ENTRIES` | 200 (including directories) |
| `MD_MAX_SOURCE_BYTES` | 1 MiB original per document |
| `MD_MAX_TOTAL_SOURCE_BYTES` | 8 MiB original total |
| `MD_MAX_CURRENT_BYTES` | 2 MiB current per document |
| `MD_MAX_TOTAL_CURRENT_BYTES` | 16 MiB current total |
| `MD_MAX_PAYLOAD_BYTES` | 32 MiB saved workspace JSON |
| `MD_MAX_PREVIEW_BYTES` | 8 MiB rendered preview |
| `MD_OPERATION_TIMEOUT_MS` | 30,000 |
| `MD_PREVIEW_TIMEOUT_MS` | 10,000 |

Existing final HTML download cap remains 64 MiB. Bound collection/model sizes before transitions/save/reopen. Worker timeouts preserve sources and accepted text; preview failure is an explicit unavailable message, not a blank stale view. Source remains reviewable if preview fails.

Use stable errors with concise UI messages: `MD_INPUT` (selection/type), `MD_PATH` (unsafe/colliding path), `MD_ZIP` (invalid/unsupported ZIP), `MD_ENCODING` (UTF-8 required), `MD_LIMIT` (size/count), `MD_REVIEW` (invalid saved workspace), `MD_FAILED` (worker/preview/export failure). Reuse existing capability, cancellation, and import timeout behavior where appropriate. Show no document content in error logs.

## 9. Acceptance tests

Use public or synthetic data only. Do not snapshot arbitrary user sources. Run pure archive/model tests on synthetic buffers and UI tests in the existing network-guarded Playwright harness. Production-limit cases may run in Chromium only. Required cases:

| ID | Required assertion |
| --- | --- |
| MD01 | Multiple loose sources and nested-path ZIP create sorted, distinct documents; repeated basenames are retained in different folders. |
| MD02 | Independent suggestions on identical text in two files; switching does not lose annotations or dirty state; export targets correct files. |
| MD03 | ZIP export includes all documents; filenames/path Unicode normalization preserved; unchanged contents compare byte-for-byte. |
| MD04 | Current-document download uses original basename and correct MIME, BOM and accepted content. |
| MD05 | Accept, remove annotation, edit retained wording, save/reopen, accept/undo; source text survives every step. |
| MD06 | Pending/rejected suggestions excluded from clean output; pending preview never changes model; notes do not leak. |
| MD07 | CRLF, LF, CR, mixed endings, BOM, no final newline, Unicode/emoji/combining marks, Markdown syntax and inert templates; replacement newline rule. |
| MD08 | Empty originals, complete deletion, zero-length ownership overlap guard, undo and exported empty files. |
| MD09 | Saved workspace opens directly offline and through picker; inactive-document tampering, wrong hashes, duplicate IDs, extra schema fields and unknown format fail atomically. |
| MD10 | Draft switch cancellation, new-workspace unsaved prompt, canceled/failed import leaves old review intact, switching back preserves source scroll. |
| MD11 | Invalid/mixed selections, non-Markdown ZIP entries and empty ZIP fail clearly with no silent omission. |
| MD12 | Absolute/traversal/backslash/device paths, normalization/case collisions, prefix conflicts, duplicate exact ZIP names rejected before inflation. |
| MD13 | Stored/deflate, descriptors with/without signature, UTF-8 names, archive comments accepted; encrypted/ZIP64/symlink/unsupported encoding rejected. |
| MD14 | CRC mismatch, mismatched headers, truncation, overlap, malformed extra fields, size lies, decompression overrun and entry/count limits rejected. |
| MD15 | Source/preview containing script, raw HTML, malicious links, images and template expressions never executes or requests network resources. |
| MD16 | No-change save/reopen/export reconstructs every original byte; all workspace sources embedded; no reattachment. |
| MD17 | Multiple rapid previews/switches, cancellation, worker failure, timeout and stale replies leave no extra live worker/frame/URL or corrupted state. |
| MD18 | Build regeneration is deterministic; malformed boundaries rejected; bundled licenses present; all prior HTML tests pass unchanged in meaning. |
| MD-P01 | `@performance`: 40 files of 32 KiB each, import/export under 10 seconds each, switch under 2 seconds, active-worker cancellation under 500 ms; no threshold relaxation without documenting failure. |

Run Chromium and Firefox functional tests; retain the documented WebKit interaction skips and exercise noninteraction import/export there. Run the full existing suite and performance checks once final code changes pass focused tests. Document actual counts, failures, skips, commands and environment. Test fixtures are generated, never copied from external documents.

## 10. Implementation order and completion gate

1. Add limits, strict source/path/workspace schemas and archive operations with pure tests.
2. Extend the durable model with the explicit Markdown profile and regression tests.
3. Add worker/preview/build artifacts and notices; verify offline execution.
4. Integrate input routing and transactional workspace/document switching.
5. Add full-workspace saved copies, current Markdown and whole-workspace ZIP exports.
6. Complete UI/persistence/lifecycle tests and existing HTML regressions; fix observed failures.
7. Update this status and testing records with evidence, inspect the complete diff, commit and push to `main`.

Completion requires all specified behavior, a clean reproducible build, passing required checks with only documented browser exclusions, and no user-source material in code, fixtures, documentation or commits. The implementation may choose local variable names and equivalent code organization; it must not leave product behavior, format contracts, limits, or test outcomes to a later engineer.
