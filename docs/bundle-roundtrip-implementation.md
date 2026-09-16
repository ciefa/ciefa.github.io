# Original-format HTML export: implementation specification

Status: implemented; see [testing.md](testing.md) for the validation record. Date: 2026-09-16. Baseline application commit: `fca9966073ced86084b3a6eb8af3ddbc9ebc3460`.

This document is normative. Implement its decisions and acceptance tests. The [research report](bundle-roundtrip-research.md) supplies background; this specification resolves its open design choices. It supersedes the earlier import specification only where explicitly stated here. All other existing import, isolation, review, and static-export contracts continue to apply.

## 1. Required outcome and fixed decisions

Add **Export original-format HTML** for eligible bundled documents. Apply the final accepted wording to the original embedded HTML template and retain the surrounding original file, runtime, manifest, and asset payloads. Pending suggestions and comments do not enter that output.

The implementation decisions are fixed:

| Concern | Required decision |
| --- | --- |
| Source of truth | Persistent source text units containing ordered text runs. Annotation ownership belongs to individual runs. |
| Stable projection | Invisible HTML comment delimiters identify units in an immutable sanitized base document. No extra visible wrapper elements. |
| Accepted annotation removal | Convert its owned runs to ordinary text runs; retain their accepted text. |
| Position updates | Do not persist absolute annotation character offsets. Runs retain ownership when other runs change length. |
| Original storage | Cache one immutable original `File`/`Blob` in the active session. Save source identity and template, not the original outer file. |
| Reopening | Read the text model from the saved review. Require matching original bytes only for original-format export. |
| Encoding | Original-format export supports strict UTF-8, with or without one leading UTF-8 BOM. Other inputs retain existing review/static-export behavior. |
| Compatibility | New eligible reviews use `local-html-reviewer-v2`. Ordinary HTML, ineligible bundles, and existing v1 reviews remain on the v1 path. No automatic v1-to-v2 migration. |
| Parser | Pin `parse5` 8.0.0 and `entities` 6.0.1. Bundle with esbuild 0.28.2 into the distributed HTML. |
| Background work | Parse original source and validate/export source patches in a dedicated worker. Never execute input scripts in that worker or a review frame. |
| Application distribution | Continue distributing one offline-capable `index.html`. Permit a development build step for the model and worker artifacts. |
| Unsupported structure | Fresh bundles that cannot be mapped reliably fall back to the existing static-review path, with an explicit limitation message. Invalid saved v2 reviews fail to open. |
| Browser scope | Full review and export support in Chromium/Firefox; preserve the documented WebKit review-interaction limitation. |
| Runtime fidelity | Preserve runtime bytes. Do not invent producer-specific checksum, thumbnail, search-index, signature, or authoring-project updates. |

The piece-based text model and comment delimiters are the concrete implementation of the research report's text-unit/projection proposal. They replace its tentative need for general annotation-range rebasing. Do not implement quote matching, XPath anchoring, a diff-based reconciliation engine, an operation log, or a CRDT.

## 2. Deliverables and build contract

Implement these files and responsibilities:

| Path | Responsibility |
| --- | --- |
| `index.html` | Integration, source cache, operation state, export dialog, v2 rendering/persistence, and generated inline artifacts. |
| `src/roundtrip/model.js` | Pure validation, run editing, annotation transitions, model accounting, and text-patch encoding. |
| `src/roundtrip/worker.js` | Original decoding/fingerprinting, bounded source parsing, unit discovery, and restored bundle generation. |
| `src/roundtrip/limits.js` | Named immutable numeric limits shared by model and worker. |
| `scripts/build-roundtrip.mjs` | Reproducible inline-artifact generation and `--check` mode. |
| `LICENSES/parse5-MIT.txt` | Exact upstream license for the pinned parser. |
| `LICENSES/entities-BSD-2-Clause.txt` | Exact upstream dependency license. |
| `package.json`, `package-lock.json` | Pinned build dependencies and commands; retain Playwright 1.57.0. |
| `tests/helpers/roundtrip-fixtures.cjs` | Synthetic eligible/ineligible bundles and functional synthetic bootstrap. |
| `tests/helpers/roundtrip-build.cjs` | Build the actual modules with source-substituted limits for boundary tests; inject the generated region into an in-memory application copy. |
| `tests/roundtrip-model.spec.cjs` | Model transitions and malformed model cases. |
| `tests/roundtrip-projection.spec.cjs` | Unit discovery, delimiter persistence, selection, and rendering. |
| `tests/roundtrip-export.spec.cjs` | Byte preservation, text semantics, source reattachment, and standalone runtime. |
| `tests/roundtrip-persistence.spec.cjs` | v1/v2 compatibility and repeated save/reopen cycles. |
| `tests/roundtrip-lifecycle.spec.cjs` | Cancellation, worker failures, limits, isolation, and competing operations. |
| `tests/roundtrip-performance.spec.cjs` | Production-size tests tagged `@performance`. |
| Existing test helpers/specs | Adapt public-control helpers for the export menu and test format-specific payload assertions against both v1 and v2. Do not disable v2 globally to keep old assertions passing. |
| `docs/testing.md` | Updated build/test commands, scope, and actual validation record. |

Retain the research probe as research-only code. It is not a production exporter or source validator. Do not replace existing fixtures or alter deployment configuration.

Add these package commands:

```json
{
  "build:roundtrip": "node scripts/build-roundtrip.mjs",
  "check:roundtrip-build": "node scripts/build-roundtrip.mjs --check",
  "test:roundtrip": "playwright test tests/roundtrip-*.spec.cjs --grep-invert @performance"
}
```

Change `test:performance` to include both existing and new performance spec files in the Chromium project. Existing `npm test` discovers the new non-performance tests normally. Use exact devDependency versions for `parse5`, `entities`, and `esbuild`; users opening the application need none of them installed.

The build script replaces exactly one generated region, bounded by `<!-- HR2 GENERATED START -->` and `<!-- HR2 GENERATED END -->`, before `script#bundle-importer`. On first generation it inserts that region there. Reject multiple or incomplete boundaries.

The region contains:

1. A classic `script#roundtrip-model` declaring the lexical constant `roundTripModel`. Build an IIFE with esbuild, then wrap its temporary exports variable in a closure and return a frozen export object. Do not add exports to `window`.
2. `script#roundtrip-worker[type="application/json"]` containing the JSON-encoded, self-contained classic worker source. Escape `<`, U+2028, and U+2029 in this JSON.
3. One nonexecuting `script#roundtrip-licenses[type="text/plain"]` containing both license notices; escape HTML-significant end-tag sequences when generating its contents.

Use esbuild `bundle:true`, `platform:'browser'`, `format:'iife'`, `target:'es2022'`, `minify:true`, no source maps, no external imports, and no build timestamps or absolute paths. `--check` generates in memory and exits nonzero on any mismatch without writing files. Preserve license notices verbatim in `LICENSES/`; the generated notices must convey the same text. The saved-application template must include the entire generated region.

The build module exports `generateRoundtripArtifacts({plugins=[]}={})`, returning the generated region string. Its CLI runs only when invoked directly. The test helper supplies an esbuild `onLoad` plugin that replaces uniquely named constant declarations in `limits.js` before bundling. Assert one match per requested override and allow numeric override values only. Tests then exercise the actual generated model/worker, without runtime limit overrides or test branches in the application. Test cases changing shared input/template/normalized/download limits must also substitute the corresponding existing application/importer constants through the current test helpers.

## 3. Fidelity and eligibility contracts

### 3.1 Output fidelity

- If every unit's current text equals its original text, download the original bytes directly. This includes reviews with only comments, removed comments, rejected suggestions, or accepted-then-undone changes.
- Otherwise, modify only the original template data block's contents in the outer byte sequence. Preserve its opening/closing tags and all other original bytes.
- In the decoded template, modify only validated source text-node spans. Keep element structure, attributes, source comments, resource references, scripts, and unedited source spans unchanged.
- Inside a changed text span, canonical entity/newline spelling is allowed. The decoded characters must equal the model's accepted text exactly.
- Remove all reviewer-added metadata from either clean export. Original source comments and original bundle metadata remain in original-format output.
- Reflow and changed page breaks are expected consequences of changed wording. Runtime-derived thumbnails, indexes, or other producer metadata remain untouched. Do not claim that these are regenerated or that output can be reimported into an authoring application.

### 3.2 Source classification

Preserve the existing classification precedence: saved review, bundle, ordinary HTML. Recognize v2 in addition to v1 at the saved-review boundary. A non-null unknown format is an error, not ordinary HTML.

For a fresh bundle, existing importer validation remains authoritative. Run worker eligibility analysis before the single conversion pass, provide a projection when analysis succeeds, and still run every ordinary importer check. Restoration eligibility adds the following conditions; a failure here alone yields v1 static review:

1. Strict UTF-8 decoding succeeds. Remove one leading `EF BB BF` for parsing and remember its length as `bomBytes:3`; otherwise use `0`. Reject UTF-16 BOMs. If the parsed outer document declares a charset, all declarations must be `utf-8`, case-insensitively; absent declarations are allowed. Check both `meta[charset]` and charset parameters in `meta[http-equiv="content-type"]`, using case-insensitive attribute values. The decoded template string must also be well-formed Unicode without U+0000, including its nonunit content.
2. Required APIs exist: `Worker`, `Blob`, `URL.createObjectURL`, `crypto.subtle.digest`, `TextEncoder`, fatal UTF-8 `TextDecoder`, and `Intl.Segmenter` with grapheme granularity. Gzip availability remains governed by the existing importer.
3. Source and template parsing fit section 4 limits and report no parse errors except `missing-doctype` and the narrowly handled `control-character-reference` for the exact `&#13;` sequence and the narrowly handled `control-character-reference` for the exact `&#13;` sequence. Use `parse5` with locations. Parse the outer wrapper under both scripting modes; the unique supported marker elements, their contents, and bounds must agree. Parse the template with scripting disabled.
4. Outer marker discovery must agree with existing native `bundleImporter.detect`. Do not descend into `template.content` when discovering outer markers. Each supported marker must have explicit start/end tags and no `src` attribute. Other existing marker/schema rules remain unchanged.
5. The template contains no `noscript`, `template`, `xmp`, `plaintext`, `listing`, `iframe`, `frame`, or `noframes` element. These are restoration exclusions, not new v1 import rules. Reject any source comment whose data starts with `hr2:`.
6. All review-selectable, non-whitespace body text surviving normalization must map to eligible HTML text units. Non-whitespace SVG/MathML text is ineligible. SVG image assets remain supported by the existing importer.
7. The marker projection survives conversion, sanitization, serialization, and candidate-frame parsing with the invariants in section 7. At least one unit must remain.
8. The initial v2 payload and annotated download fit their respective limits. If v2 retention would exceed them before any review exists, open the already converted content as v1 instead. Do not retry conversion or discard a user's existing review on a failed overall import.

Ignore text under `script`, `style`, `title`, `textarea`, `select`, `button`, `helmet`, and `sc-helmet` for unit discovery. This preserves current exclusions for selection and handles content moved into the head. Ignore ASCII-whitespace-only text directly under `table`, `thead`, `tbody`, `tfoot`, `tr`, and their supported `sc-raw-*` aliases. It remains immutable in the base projection. Text inside ordinary HTML body elements, table cells/captions, headers/footers, and `pre`/`code` is otherwise eligible subject to source-span validation.

Do not infer hidden runtime checksums from JavaScript or use a runtime allowlist. Unknown `__bundler/*` markers still fail existing bundle import. Unknown fields already accepted inside manifest entries and unknown outer content are preserved, not interpreted. The guaranteed contract is source/text preservation; standalone functionality is validated with the specified synthetic runtime, not claimed for all executable applications.

## 4. Fixed resource limits

All byte counts are UTF-8 unless explicitly called original file bytes. Equality is accepted. Existing importer limits remain unchanged.

Declare each new limit as a named exported `const` in `limits.js`. For worker/model access to the existing caps, use `RT_MAX_INPUT_BYTES`, `RT_MAX_DOWNLOAD_BYTES`, `RT_MAX_TEMPLATE_BYTES`, and `RT_MAX_NORMALIZED_BYTES` with the same fixed values as the existing constants. The build check must also verify those four values agree with the application's/importer's declarations. Production code has no mutable limit configuration.

| Name | Value | Enforcement |
| --- | ---: | --- |
| Existing input/download caps | 64 MiB each | Before input read and before any download. |
| Existing template cap | 2 MiB | Original template and final patched template. |
| Existing normalized-document cap | 48 MiB | Base and each rendered current/preview document. |
| `RT_MAX_UNITS` | 16,384 | Source discovery and v2 validation. |
| `RT_MAX_RUNS` | 65,536 | Sum across units, checked before every mutation. |
| `RT_MAX_COMMENTS` | 2,000 | v2 validation and comment creation. |
| `RT_MAX_PARTS` | 2,048 per comment | Selection capture and validation. |
| `RT_MAX_NOTE_BYTES` | 64 KiB | Each note. |
| `RT_MAX_REPLACEMENT_BYTES` | 64 KiB | Each non-null replacement. |
| `RT_MAX_CURRENT_TEXT_BYTES` | 2 MiB | Sum of all run text; current and preview models separately. |
| `RT_MAX_METADATA_BYTES` | 8 MiB | UTF-8 `JSON.stringify` of the complete v2 payload with `baseHtml` omitted. |
| `RT_MAX_PARSE_NODES` | 100,000 | Per worker parse, counting documents, elements, text, comments, and doctypes. |
| `RT_MAX_TREE_DEPTH` | 128 | Per worker parse; document depth is 0. |
| `RT_MAX_ELEMENT_ATTRIBUTES` | 64 | Per parsed element, including adopted attributes. |
| `RT_MAX_ALL_ATTRIBUTES` | 100,000 | Aggregate per parse. |
| Existing overall import timeout | 30,000 ms | Includes original analysis and v2 preparation. |
| `RT_EXPORT_TIMEOUT_MS` | 30,000 ms | Processing after source selection, including reattachment validation. |
| Existing stage timeout | 10,000 ms | Candidate frame; also bounded by overall import timeout. |

Implement a bounded parse5 tree adapter around `defaultTreeAdapter`. Count allocations before creating nodes; implement counted `insertText`, `insertTextBefore`, and `setDocumentType` as well, because the default adapter calls its own helpers internally. Bound attributes at creation and adoption. Check parent depth plus subtree height at attachment/moves and update ancestor heights. Use iterative traversal for subsequent validation. A limit exception terminates that parse immediately; do not merely count a potentially enormous tree afterward.

These are application work/allocation bounds, not a claim that a browser exposes a portable hard heap limit. Keep at most one worker, one cached original Blob, one temporary source candidate, and one candidate frame. A pending output Blob is temporary and released after download/cancellation. Release parsed source trees after each phase; do not retain manifest JSON, decoded outer strings, or output buffers in application state after completion.

Validate proposed mutations before commit. If accepted text would exceed the current-text, patched-template, run, or metadata limit, leave both model and DOM unchanged. A too-large pending preview displays its explicit unavailable state; it does not accept changes or leave stale preview content visible. Oversized downloads keep the review dirty.

## 5. Exact saved format and invariants

### 5.1 v2 payload

Use precisely these fields. This JSON example describes field shapes, not a fixture to copy literally:

```js
{
  format: 'local-html-reviewer-v2',
  originalName: 'document.html',
  source: {
    profile: 'bundler-template-text-v1',
    mappingVersion: 1,
    sha256: '<64 lowercase hexadecimal characters>',
    byteLength: 1234,
    encoding: 'utf-8',
    bomBytes: 0,                       // 0 or 3
    templateSha256: '<64 lowercase hexadecimal characters>',
    template: '<original decoded HTML template>'
  },
  baseHtml: '<sanitized static document containing empty unit slots>',
  units: [{
    id: 'u000001',
    start: 10,                        // original template UTF-16 offset, inclusive
    end: 15,                          // original template UTF-16 offset, exclusive
    original: 'Alpha',
    runs: [{kind: 'annotation', id: 'hr-0123456789abcdef0123', part: 0, text: 'Alpha'}]
  }],
  comments: [{
    id: 'hr-0123456789abcdef0123',
    quote: 'Alpha',
    note: 'Suggested wording',
    replacement: 'Beta',              // null means comment; '' means deletion
    status: 'open',                   // open, accepted, rejected, resolved
    parts: [{unit: 'u000001', before: 'Alpha'}]
  }],
  view: {previewOpen: false, scrollTogether: true}
}
```

An annotated run has exactly:

```js
{kind: 'annotation', id: '<comment ID>', part: 0, text: 'Alpha'}
```

The current text of a unit is `unit.runs.map(r => r.text).join('')`. This is the only authoritative accepted text. Do not persist `documentHtml`, current text again in another field, source DOM paths, a second patch list, frame contents, original outer bytes, or an edit history in v2.

All shown object keys are required; reject unknown keys in v2 objects and runs. Require arrays, strings, booleans, and finite safe integers of the stated kinds. Reject sparse/non-array representations, duplicate IDs, invalid ranges, and prototype-like identifier keys; use arrays/Map rather than merging input dictionaries into objects. Fingerprints identify content, not authorship.

### 5.2 Unit/run invariants

- Assign IDs `u000001` through `u016384` by increasing original source-span start. Units are saved in that order. Their spans are positive, ordered, disjoint, and within `source.template`.
- Recompute all original spans/text/IDs from `source.template` on every v2 open and compare exactly. IDs supplied in the file do not establish their own validity.
- A unit has at least one run. A wholly empty, unannotated unit has exactly one `{kind:'text',text:''}` run.
- Otherwise ordinary text runs are nonempty, and no two ordinary text runs are adjacent. Coalesce them within a unit after removing ownership. Never coalesce across units.
- Annotated runs may be empty. Never coalesce or discard them because their text is empty.
- Each `(comment.id, part index)` occurs in exactly one run. `comment.parts[part].unit` must equal that run's unit. Each comment uses a unit at most once. Parts are ordered by unit appearance in the normalized base, which can differ from source order after slot movement.
- For a nonaccepted comment, each run's text equals its part's nonempty `before` string. For an accepted suggestion, part 0 contains the replacement and every later part contains `''`.
- Plain comments have `replacement:null` and only `open`/`resolved` status. Suggestions have string replacements and only `open`/`accepted`/`rejected` status.
- Within a comment's interval from its first to last owned run, every nonempty run must belong to that comment, and no run may belong to another comment, even if empty. Empty ordinary runs in intervening units are allowed. Enforce this during selection and saved-model validation. Ownership is the overlap guard.
- All document text and replacements are well-formed Unicode scalar strings and contain no U+0000. Do not normalize Unicode. Notes/quotes remain inert strings and do not become HTML.

### 5.3 Base document

Each unit is represented by exactly one empty pair of comment nodes:

```html
<!--hr2:u000001:s--><!--hr2:u000001:e-->
```

Pairs must be adjacent siblings under the same HTML element, in the body, without nesting or overlap. No pair may be inside excluded text contexts or table structural elements. There must be no unknown `hr2:` comment. The base contains no annotation marks/attributes and no reviewer-generated current/pending text. Ordinary immutable source text outside slots is allowed only in the excluded contexts and structural whitespace defined in section 3.

Sanitize v2 base markup using the same document restrictions as v1. Retain only validated unit comments and the existing app-owned link/style metadata required by static review. Remove and regenerate document charset/CSP/review-style boilerplate. Reject existing `data-hr-id`, `data-hr-part`, `data-hr-state`, `data-hr-active`, and `data-hr-preview` in a saved base. Never attach a saved base or source template to the live application document.

Sanitization must not remove, relocate, or introduce a unit pair. Revalidate the base after sanitization and again after staging the fully rendered document. Failure opening v2 preserves the previous document and draft.

### 5.4 Pure model API

Expose exactly these functions from `roundTripModel`; keep helper functions internal:

```js
validate(payload, context)             // Returns a validated, independently owned v2 model.
transition(model, action, context)     // Returns {model, changedUnitIds}; never mutates input.
currentText(unit)                      // Concatenation of run text.
derivePreview(model, context)          // Returns {units, pendingIds}; not a saveable model.
encodeTextPatch(text, preAtStart)      // Section 10's text encoding and pre rule.
measure(model, context)                // Returns counts described below.
```

`context` is runtime-only `{unitOrder, sourceUnits}`. `unitOrder` lists IDs in validated base DOM order. `sourceUnits` contains the worker's recomputed descriptions, including its temporary `preAtStart` context flag. Validate these against the source/model before using them. `changedUnitIds` is in base order and includes text or annotation-style changes, allowing the renderer to update only affected units. Notes/view-only changes need no unit rerender.

`measure` returns exactly `{unitCount,runCount,commentCount,currentTextBytes,patchedTemplateBytes,metadataBytes}`. Counts use sections 4 and 10's definitions. Base/rendered/download size checks remain in the application because they include serialization and generated application code.

Actions are exactly:

```js
{type:'add', id, quote, note, replacement, slices:[{unit,run,start,end}], canReplace}
{type:'decide', id, status}             // Legal transitions in section 8 only.
{type:'edit', id, note, replacement, canReplace}
{type:'remove', id}                    // UI confirmation has already occurred.
```

`run`, `start`, and `end` in a new action are temporary zero-based run index/UTF-16 slice coordinates captured against one unchanged model revision. Each slice must target an ordinary run with `0 <= start < end <= text.length`. They are never persisted. The UI recomputes `canReplace` on submission and checks the draft's captured revision before calling `transition`. A stale revision cancels submission with a reselection message; it never retargets a slice.

`derivePreview` copies runs and applies pending text effects while returning their IDs separately. Its returned units intentionally differ from live comment-status invariants and must never be passed to `validate`, saved, or used for further transitions. The renderer receives the live comments plus this explicit preview projection. All API failures carry a fixed section 12 error code; no partially mutated result is returned.

## 6. Discovering and validating original text units

Run this in the worker for source import, v2 template validation, and restored export:

1. Parse the original template with the bounded adapter, `sourceCodeLocationInfo:true`, and `scriptingEnabled:false`.
2. Discover text nodes under the body according to section 3. Retain source location, original decoded value, and a temporary child-index path from the parsed document. Paths include every child-node type and are only an import-time bridge.
3. Require explicit source bounds for every unit. Reject overlaps and missing positions. The raw span must be independently parseable as HTML text without introducing an element, comment, or doctype. Use parse5 fragment parsing in a synthetic HTML `div`; require only text children.
4. Compare the decoded fragment text with the original node value, with the single `pre` exception below. Reject mismatches. This specifically rejects foster-parented text whose source span crosses table markup.
5. Assign source-order IDs and return the temporary paths with the original values. Do not serialize the paths into the saved format.

For an immediate first text child of `pre`, HTML can consume its initial newline. If the unit begins exactly at the parent's opening-tag `endOffset`, remove one leading LF from the independently decoded raw span before comparison. If its start is later, an ignored newline may already lie outside the span: remove nothing. The comparison must still match exactly. Preserve this contextual fact by recomputing it from source at export, not by trusting a saved flag.

For native/parser correspondence, produce a canonical tree sequence from both the worker's source AST and the inactive native template document: node type, namespace URI, local name, sorted namespace/local-name/value attribute triples, comment data, and text value. Include doctype identifiers and compatibility mode: map parse5 `quirks` to native `BackCompat`, and other modes to `CSS1Compat`. They must match before inserting unit delimiters. Resolve and check **all** temporary paths before inserting any comments, so insertion cannot shift later paths.

The native template document used for correspondence is the same document the importer subsequently normalizes. Do not create source units by matching quotes, matching HTML IDs, or zipping flat lists of text nodes. Duplicate HTML IDs and duplicate passages are legal when the underlying mapping is unambiguous.

## 7. Conversion, delimiters, and rendering

Extend `bundleImporter.convert` with an optional internal `projection` option, `{units,tree}`, containing validated unit descriptions and source-tree correspondence information. Calls without it retain their current interface and behavior. It must not come directly from arbitrary outer HTML attributes. When provided, add `projectionStatus:'mapped'|'unavailable'` and `projectionCode:null|'RT_INELIGIBLE'|'RT_LIMIT'` to the result; return the existing normalized HTML and other result fields as usual. `mapped` HTML still contains original unit text and generated delimiters, not empty holes, and has a null code. `unavailable` HTML contains no generated delimiters and has the corresponding fixed code. Do not suppress ordinary import errors when handling a projection failure.

At the existing point immediately after the template's inactive parse and before any node deletion/move/alias replacement:

1. Validate correspondence and resolve source-unit nodes.
2. Insert start/end comments immediately before/after each unit text node.
3. Run existing conversion, including slot movement, alias replacement, resource substitution, and static CSS.
4. Run sanitization and serialize/reparse. Validate every pair, its original text, and its enclosing HTML context. All original units must survive exactly once; otherwise make the fresh bundle ineligible and use its ordinary static result after removing only the generated delimiters.
5. Derive `baseHtml` from the successfully projected document by deleting each unit's text between its comments. Preserve both comments, even for an empty unit. Initialize runs from `original`.

Do not create holes before resource/conversion validation. Retain the converted original-text HTML until a fresh import commits. If projection fails only during candidate-frame validation, discard that candidate, strip generated delimiters from the retained static result, and stage it as v1 under the same import deadline. Do not reconvert assets, partially save v2, or take this fallback when reopening an existing v2 file.

Include delimiter overhead in normalized size checks. If only that overhead makes the projection exceed 48 MiB, and removing it gives a valid result, return the static result with `projectionCode:'RT_LIMIT'`. If the ordinary unmarked result also exceeds the cap, preserve the existing import failure.

Delimiters keep original units distinct even when removal of an intervening script would otherwise make their text nodes adjacent. DOM `normalize()` cannot merge across comment nodes. A bounded synthetic probe confirmed delimiter persistence through conversion, table aliases, moved slots, and three serialization cycles in Chromium and Firefox; implementation acceptance requires the fuller tests below. [DOM normalization](https://dom.spec.whatwg.org/#dom-node-normalize)

Render v2 by parsing the sanitized base into an inactive document and filling each slot:

- Ordinary runs become `Text` nodes using `createTextNode`.
- Annotated runs become the existing `mark` element with app-owned ID/part/status attributes. Add its text with `textContent`. Keep empty annotated marks for deletion/undo.
- Use no `innerHTML` for run, note, replacement, or quote text.
- Preserve the delimiter comments in current and preview frames. Strip them from clean exports only.
- Build a runtime `WeakMap` from rendered text nodes/marks to `{unitId,runIndex}` and a Map from IDs to the two delimiter nodes. Rebuild entries for affected units after an edit. These caches are disposable; saved runs and base comments are authoritative.

For edits, rerender only changed units between existing delimiter nodes, then update comment styling/list/preview through existing hooks. Validate the candidate model first. Clear stale selected ranges after commit, preserve unrelated annotations, and retain existing scroll/focus behavior. Do not reload the current iframe for every decision.

Current frame staging uses the existing sandbox (`allow-same-origin` only), CSP, resource checks, and transactional candidate commit. v1 import/staging behavior remains unchanged. v2 startup constructs derived `documentHtml` for staging in memory only; it never saves that derived field.

For a saved v2 review, enumerate unique image/font data URLs from the sanitized base, including CSS, and validate them through the existing MIME/signature/SVG/byte/pixel/decode rules before commit. Add `bundleImporter.validateStaticResources(html,{signal,onProgress})`, returning `{resources,decodedBytes}` using the existing resource parsing/validation helpers. It must not normalize layout, alter input HTML, or add styles. Do not implement a looser second decoder. No manifest is required for these checks. Unknown, relative, and external resource URLs in v2 base content are invalid; fragment references and disabled external hyperlinks retain their existing behavior. `resources` feeds existing staged-frame decoding/pixel checks.

### 7.1 Integration boundaries

| Existing entry point | Required integration |
| --- | --- |
| `FORMAT` / `validatePayload` | Keep the existing v1 constant and validator. Add `FORMAT_V2`; dispatch through an asynchronous `prepareReviewPayload(value,job)` for v2 validation/render preparation. Do not pass v2 data through the v1 validator. |
| `readFile` | Retain the chosen Blob for a potential source cache, analyze eligible bundle source, then run one converter pass. Build the exact v2 payload only after mapping succeeds. Ordinary and v1 paths retain current behavior. |
| `stageReview` | Accept optional `prepared.renderedHtml` and runtime mapping context. v2 uses the rendered HTML and `validateRenderedProjection`; v1 uses the existing sanitize/validate path. Assign the canonical v2 payload to `model` without adding a `documentHtml` field. Keep rendered/cache data in separate runtime variables. |
| `captureSelection` / `startComment` | v2 captures model slices and the current revision; v1 retains DOM-range behavior. |
| `submitComment`, `setDecision`, `deleteComment` | Route v2 changes through `transition`, then rerender changed units and invoke existing dirty/list/preview updates. v1 retains its current operations. |
| `refreshPreview` | v2 uses `derivePreview` and its pending IDs; existing loading, scroll, generation, and styling behavior remains. |
| `reviewSnapshot` / `saveAnnotated` | Dispatch by format; serialize canonical v2 fields and current view preferences. Never derive accepted v2 text by scraping the frame. |
| `exportClean` | Apply section 10.5 for v2; retain the v1 implementation. |
| `marksFor`, `renderComments`, focus/scroll helpers | Share existing comment IDs, part numbers, note/quote/replacement/status fields, and mark styling across formats. Adapt only assumptions about original-parts storage. |

Runtime mapping caches, source cache, worker/request IDs, document generation, and revision are never payload fields. `documentGeneration` increments only when a new document commits successfully. Failed or canceled imports do not invalidate the current cache. Increment `revision` after each committed review mutation. Import-attempt/request IDs remain separate and reject stale responses even when no document commit occurred.

## 8. Selection and exact model transitions

### 8.1 Selection capture

Continue using DOM `Range` for user selection. Resolve selected text through the runtime unit/run map. Ignore excluded contexts and unmapped structural ASCII whitespace. Reject a selection containing any other unmapped selectable text.

Scan runs in rendered unit order between the selection endpoints. If any owned run lies in the selected interval, including an empty deletion run, focus that annotation and show the current overlap message. A selection wholly before or wholly after an empty run is allowed. Model order, not a zero-width pixel position, defines this boundary.

Selections must include positive-length text and at most one contiguous ordinary-text slice per unit. Comments may span blocks; replacements retain `blockFor`'s existing one-block rule over non-whitespace selected pieces. Enforce the rule again when changing a plain comment into a suggestion.

Use UTF-16 code-unit offsets for temporary DOM/run slices. Reject endpoints inside surrogate pairs. Also reject endpoints that split a grapheme cluster: use `new Intl.Segmenter('und',{granularity:'grapheme'})` on each maximal consecutive group of current reviewable text with the same `blockFor` element in DOM order. Join inline units without a separator; another block or any excluded element starts a new group. Map selected endpoints into these strings. Do not widen selections silently. This check applies to new user selections, not to reinterpretation of previously saved anchors under a browser with a different Unicode-data version. [Intl.Segmenter](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter)

### 8.2 Add comment

For each selected ordinary run, split it into optional prefix, one annotation-owned run, and optional suffix. Preserve the selected string as `parts[i].before`, with `i` assigned in rendered order. Generate the comment ID with the existing cryptographic ID generator; initialize status `open`. Validate the complete candidate and limits before mutating model or DOM.

Example:

```text
before: [ text("Alpha word Omega") ]
after:  [ text("Alpha "), annotation(C,0,"word"), text(" Omega") ]
```

### 8.3 Decisions and removal

Allowed decision transitions are: suggestions `open→accepted`, `open→rejected`, `accepted→open`, `rejected→open`; plain comments `open→resolved`, `resolved→open`. Reject every other decision transition. Editing an accepted annotation is blocked until undo, including note edits, preserving the current UI. For other statuses, editing only a note preserves status; changing replacement resets it to `open`.

| Action | Exact model operation |
| --- | --- |
| Accept | Find all runs owned by the suggestion. Set part 0 text to `replacement`, later part texts to empty. Set status `accepted`. |
| Undo acceptance | Restore every owned run from its `before` value. Set status `open`. |
| Reject | Restore `before` values and set status `rejected`; no accepted text survives rejection. |
| Reopen rejected | Keep `before` values, set status `open`. |
| Resolve/reopen plain comment | Change status only; run text stays equal to `before`. |
| Edit note | For a nonaccepted annotation, change the note only, subject to limits; preserve status. |
| Change a suggestion | Accepted suggestions must first be undone, as today. For other states, update replacement and set status `open`; runs retain `before`. |
| Remove any annotation | After the existing confirmation, replace all its owned runs by ordinary text runs containing their **current** text. Remove its comment record. Canonicalize ordinary runs within each unit. |

Removing an accepted annotation deliberately ends undo for that annotation, as it does today. It does not reset the unit to its original source text. A subsequent suggestion can own part of the resulting ordinary run and uses that current text as its own `before` value.

Do not rebase other annotations' offsets: there are no persisted offsets to rebase. Changing the text in one run cannot change which other runs a comment owns. Never index an annotation by a saved array position; find its owned runs through the `(id,part)` relation and rebuild runtime indexes after canonicalization.

### 8.4 Empty units and preview

An accepted deletion retains its owned empty run and both unit delimiters. Removing that annotation may leave one empty ordinary run. Retain the unit so source export can delete its original span. Other units cannot absorb it.

For preview, shallow-copy immutable source/base data and copy run/comment state. Apply the text effect of each pending suggestion to its own runs, leaving the live model untouched. Annotate pending preview marks as the current preview does. Render that derived model; accepted changes are already present, rejected suggestions retain `before`. Exceeding preview limits replaces the preview with its unavailable message. Do not save preview text as current state.

## 9. Persistence and source reattachment

### 9.1 Save and reopen

v1 saving remains unchanged. v2 `reviewSnapshot` serializes exactly section 5's model, base, comments, and view preferences. Save the complete reviewer application with that payload using the existing HTML-safe JSON embedding. A successful annotated download clears dirty state; either clean export does not.

Opening v2 performs, in order: structural/schema/size validation; worker validation of the original template and recomputed units; base sanitization and delimiter validation; run/comment relation checks; current rendering; candidate-frame mapping validation; and existing resource decode checks. Never silently downgrade a malformed v2 review or discard its restoration metadata. The exact original file is not required to resume reviewing.

Recognize only `profile:'bundler-template-text-v1'` and `mappingVersion:1`. Other versions fail with `RT_VERSION`. This release does not migrate mapping versions. v1 remains readable but cannot acquire restoration by supplying an original; its history may already be incomplete.

### 9.2 Source cache

The application caches `{blob,sha256,byteLength,projectionVerified:true,generation}` for one current v2 document. An original fresh import sets it only after its document/model commit. A failed/canceled competing import leaves the old cache intact. A successful document change drops it. Saved reviews and new browser contexts begin without it.

Reattachment uses a dedicated file input owned by the export dialog, not Open HTML. A renamed matching file is accepted; a same-named different file is rejected. The source must match original byte length/hash, UTF-8/BOM identity, and decoded template exactly. Never match by filename or template hash alone.

After source identity matches, re-run original analysis and the existing bundle conversion/projection/sanitization without replacing the current review. Regenerate its empty base and compare it against the saved empty base. This binds the displayed projection to the supplied source and checks source resources using the existing importer. Cache the source only on success.

For base comparison, use a canonical tree with node types, namespaces, local names, sorted attributes, text/comment data, and doctype. Remove/regenerate app boilerplate identically on both sides. Normalize inline `style` values by parsing both in the receiving browser and enumerating declarations in order as `(property,value,priority)` triples; all other attributes and style-element text compare exactly. Include asset data URLs and unit delimiter IDs. Do not ignore arbitrary style/resource differences. A mismatch fails reattachment without altering either review or cache.

Source verification is repeated after reopening; it is not an authentication scheme for shared reviews. Once verified in the current session, immutable Blob identity and the generation-bound cache permit subsequent exports without repeating conversion. The export worker still rechecks the source fingerprint and template before each byte splice.

## 10. Worker protocol and restored export algorithm

### 10.1 Worker lifecycle

Add exactly `worker-src blob:` to the **outer application** CSP. Leave `documentCsp` and iframe sandboxes unchanged. Create a classic worker from the decoded trusted build artifact via an object URL. Its first message must be `{type:'ready',capable:true}` after checking worker-side crypto/encoding APIs, or the same shape with `capable:false`. Revoke the URL on that handshake, then send the request only when capable. A startup failure before readiness is `RT_CAPABILITY`; a later unexpected worker failure is `RT_FAILED`. Startup time counts toward the operation deadline. Never derive worker source from source-document scripts or review payload fields.

Expose these parent-side operations through a small wrapper; one worker instance handles one request and then terminates:

```js
analyzeSource(blob, {signal, generation})
// {source, units: [{id,start,end,original,path,preAtStart}], tree, descriptor}
// descriptor contains existing bundle marker strings for conversion.

validateTemplate(source, savedUnits, {signal, generation})
// {units: [...recomputed descriptions], tree}; no outer Blob needed.

exportOriginal(blob, source, units, {signal, generation})
// {blob: outputBlob, changedUnits, byteLength}
```

Wire messages as `{requestId,generation,op,payload}`. Responses are `{requestId,generation,ok:true,result}` or `{requestId,generation,ok:false,code}`. Accept no input-derived error messages or stack traces in user-visible output. Reject unknown operations/shapes. Use monotonically increasing request IDs within the application session.

Listen for abort, worker `error`, and `messageerror`. Abort/timeout terminates the worker, revokes any live URL, rejects the operation, and ignores queued stale responses. Always terminate in `finally`. Do not retain workers or their heaps for reuse. `Worker.terminate()` provides immediate external termination rather than requiring a synchronous parser to cooperate. [Worker termination](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate)

### 10.2 Source analysis

Read the Blob in the worker; check file size first. Hash its original bytes with SHA-256. Decode with `new TextDecoder('utf-8',{fatal:true,ignoreBOM:true})` after explicitly removing the one recognized leading UTF-8 BOM from the input slice. The `ignoreBOM:true` setting prevents accidentally stripping a second U+FEFF from content.

Perform section 3 outer/profile checks and section 6 unit discovery. Compute template hash over the UTF-8 encoding of the decoded template string. `preAtStart` is true only for the immediate first text child of `pre` whose span starts at its parent's opening-tag end. Return the existing marker descriptor strings for parent conversion; release the worker's copies after the response. Do not return the original outer string, raw asset buffers, or original byte array to the parent.

`validateTemplate` verifies schema/profile/version, the template hash, all template eligibility rules, and exact recomputed unit definitions. It cannot verify the whole-file hash without the original Blob; retain that declaration until reattachment. Its returned unit descriptions include the same temporary path/context information. Reject unknown profile/version before parsing.

### 10.3 Text patch encoding

For each changed unit, compute current text by concatenating its runs. Encode HTML text by replacing `&` with `&amp;`, `<` with `&lt;`, `>` with `&gt;`, and literal CR with `&#13;`, in that order. Keep LF and other well-formed characters unchanged. parse5 reports `control-character-reference` for `&#13;` despite decoding it to the required CR. Permit that diagnostic only when its reported offset immediately follows the exact `&#13;` sequence; retain strict rejection for other character-reference diagnostics. This exception applies on subsequent source/template validation too, so a restored file remains eligible. Preserve CR as `&#13;` in rendered/static serialization as well.

If this is the immediate first text child of `pre`, its source span starts exactly after the parent's opening tag, and the current text begins with LF, prefix one extra LF to the encoded patch. HTML consumes that extra newline on parse. If an ignored source newline is outside the span, do not add another. Empty text yields an empty patch. Recompute this rule from the original AST every time.

Use these examples as mandatory assertions:

| Original template | Original logical text | Desired text | Correct edited template |
| --- | --- | --- | --- |
| `<p>A &amp; B</p>` | `A & B` | `C < D` | `<p>C &lt; D</p>` |
| `<pre>A</pre>` | `A` | `\nB` | `<pre>\n\nB</pre>` |
| `<pre>\nA</pre>` | `A` | `\nB` | `<pre>\n\nB</pre>`; retain the first source LF outside the changed span. |
| `<pre>\n\nA</pre>` | `\nA` | `B` | `<pre>B</pre>` when the reported original span includes both initial LFs. |

Here `\n` in table cells denotes an actual LF. Do not use these strings as regular-expression rewrite rules.

### 10.4 Byte-preserving assembly

1. Recheck original Blob identity, encoding, markers, source template, and recomputed unit definitions against the supplied model. Validate final text and all limits.
2. If no unit changed, return the original Blob directly. Do not serialize or transcode it.
3. Generate patches only for changed spans and assemble the template once from ascending, nonoverlapping original slices and encoded replacements. Avoid repeated whole-string concatenation for each patch.
4. Build an expected AST from the original: update mapped text-node values to current text; omit empty text nodes and merge adjacent text nodes where necessary. Parse the patched template and compare canonical trees, including unchanged scripts, comments, element structure, attributes, and nonunit text. Reject any difference outside the expected text changes. Enforce the original importer's unsupported interpolation rule: a newly introduced `{{...}}` in ordinary prose is rejected; literal examples under `pre`/`code` remain allowed as in the importer.
5. Serialize the updated template with `JSON.stringify`, then escape every code unit matching `/[<\u007f-\uffff]/g` as a JSON Unicode escape: one backslash, `u`, and four lowercase hexadecimal digits. This escapes `<`, U+2028/U+2029, and all non-ASCII characters; supplementary characters become their two JSON surrogate escapes. Do not use JavaScript-only `\x` escapes. Reparse this JSON and require equality with the patched template. The ASCII-only replacement block prevents newly introduced non-ASCII text from depending on browser charset fallback when the original outer file had neither BOM nor a charset declaration.
6. Locate the original marker content from its opening tag's `endOffset` to its closing tag's `startOffset`. These are UTF-16 string offsets. Convert the two prefixes to UTF-8 byte lengths and add `bomBytes`. Never apply string offsets directly to bytes.
7. Assemble those same prefix/replacement/suffix byte slices in a bounded Uint8Array in the worker, enforce 64 MiB before allocation, and transfer its buffer to the parent to construct the download Blob. Preserve the original BOM, file suffix, manifest formatting, asset payloads, and bootstrap exactly.
8. Reparse the output wrapper in the worker and verify the same marker set, expected template, and byte-identical original prefix/suffix. No input program executes during verification. The public worker wrappers accept/return Blobs; the message transport transfers ArrayBuffers and the worker operates directly on byte arrays. WebKit file workers cannot read even worker-created Blobs (`NotReadableError`); construct download Blobs only in the parent. For unchanged export, send only the no-change result and return the parent’s original Blob; for changed export, transfer the output buffer and construct the download Blob in the parent. Transfer input buffers after the ready handshake and release them with the worker. Source parsing and hashing remain in the worker.

The original template is capped at 2 MiB; also enforce that cap on the patched template. Before an acceptance commit, the model computes the same encoded-patch byte deltas against original spans so an oversized template is rejected early. Export repeats authoritative parsing/validation. [HTML script data restrictions](https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements)

### 10.5 Static export

Keep static revised HTML available for both formats. For v2, render accepted state without annotation marks, remove all validated `hr2:` delimiter comments, and use existing style/link cleanup. If removing delimiters exposes a first `pre` text child beginning with LF, insert one extra LF in the serialization clone so reparsing preserves its logical text. Validate the reparse. Never include source metadata, original template, model runs, or worker/application code in static output.

## 11. UI and operation state

Keep the existing save control and shortcuts. Replace the topbar's standalone revised-export button with **Export**, ID `export-menu-button`, opening a popover menu on every viewport. Move the existing `clean-button` into that menu with label **Export revised static HTML** and add **Export original-format HTML**, ID `original-export-button`. Both actions are ordinary keyboard-focusable buttons. Use `aria-expanded` and `aria-controls` on the trigger; Escape or clicking outside closes the menu and restores trigger focus. Selecting an enabled action closes the menu before performing it. Do not depend on the browser's native Popover API; use the application's existing hidden-element pattern.

Show the original-format action disabled with an adjacent persistent explanation for v1/ineligible documents. Do not use a disabled-button tooltip as the sole explanation. Fresh eligible imports show **Original-format export available** in the document status area. This is independent of dirty state.

Clicking the enabled action opens `dialog#original-export-dialog` with:

- Title: **Export original-format HTML**.
- Description: **Includes accepted text changes and the original document's scripts and behavior. Comments and pending suggestions are excluded. Original previews or other generated metadata are not updated.**
- Counts of accepted suggestions still carrying annotations and changed source units. Changed-unit count includes edits whose annotations were removed; label it **Text fragments changed**.
- If a draft exists, do not open the dialog; use **Add or cancel your draft before exporting.**
- If no verified source is cached: **Choose the original HTML file to finish this export. Its contents must match the file this review started from.** Provide `input#original-source-input` accepting `.html,.htm,text/html` and a **Choose original HTML** button.
- If a source is verified: show **Original file verified** and a primary **Download original-format HTML** button with ID `original-download-button`.
- A **Cancel** button, progress text, and `aria-live="polite"`. Opening/selecting the original never automatically downloads a file; the explicit Download action does.

Download filename: use existing `outputName('restored-')` sanitization. Export does not overwrite any file and does not clear dirty state.

Use states `idle`, `choosing-source`, `verifying-source`, and `exporting`. Opening the dialog alone is not busy. During verification/export, disable review mutations and save/export actions, set appropriate `aria-busy`, and expose cancellation. Opening another document cancels the export/verification and begins the existing transactional import; an unsuccessful import preserves the former review/cache. Escape, Cancel, closing the dialog, and page unload cancel processing. File-picker waiting time is excluded from the timeout.

An export snapshots `generation` and `revision` when work starts. Accept a result only if both still match, the dialog is still in the expected state, and the request is active. Every terminal path restores controls, terminates its worker, releases temporary Blobs/URLs, and keeps current text/comments intact. A failed source choice must not replace a previously valid source cache.

## 12. Error codes and exact user messages

Use app-owned messages; never include source excerpts, file contents, asset identifiers, parser exceptions, or worker stacks in UI/log output. Filename display retains the application's existing behavior.

| Code | User-facing message |
| --- | --- |
| `RT_INELIGIBLE` | This document supports static export only; its original structure cannot be mapped reliably. |
| `RT_ENCODING` | Original-format export requires a UTF-8 original. You can still review this document and export static HTML. |
| `RT_CAPABILITY` | Original-format export is unavailable in this browser. Use an up-to-date Chrome or Firefox. |
| `RT_VERSION` | This review uses an unsupported restoration format. Open it with the application version that saved it. |
| `RT_INVALID_REVIEW` | This review's saved text mappings are invalid. The file was not opened. |
| `RT_SOURCE_MISMATCH` | This is not the original file used for this review. Choose the unchanged original HTML file. |
| `RT_PROJECTION_MISMATCH` | The original file does not reproduce this review's document mapping. No file was exported. |
| `RT_LIMIT` | This operation exceeds the supported document or review size. Your review has not changed. |
| `RT_SELECTION` | Select complete characters in supported document text. |
| `RT_STALE_SELECTION` | The document changed while this selection was open. Select the passage again. |
| `RT_PATCH_INVALID` | These edits cannot be written back without changing document structure. No file was exported. |
| `RT_TIMEOUT` | Preparing the original-format file took too long. Your review is unchanged; try again or export static HTML. |
| `RT_FAILED` | The original-format file could not be prepared. Your review is unchanged. |

Cancellation is not an error. A preview-size failure uses **Preview unavailable because the combined suggestions exceed the supported size. Your accepted text is unchanged.** Existing overlap, one-block, draft, and import errors retain their established messages. A stale selection uses `RT_STALE_SELECTION`, keeps the draft text available, disables its submission, and requires Cancel followed by a new selection; it never silently discards the draft or submits against a new passage.

The fresh-import static fallback uses `RT_ENCODING`, `RT_CAPABILITY`, `RT_LIMIT`, or `RT_INELIGIBLE` as its persistent status explanation, in that precedence after normal importer success. For a fresh-import `RT_LIMIT` fallback, replace the table's operation-error wording with **Opened for static review because retaining original-format mappings exceeds the supported size.** A structural/profile eligibility failure does not turn otherwise valid existing bundle import into an error. Unexpected worker/internal failures fail the import transaction; they are not an eligibility fallback. A timeout/cancel of the overall import does not commit fallback content.

## 13. Required acceptance tests

Use newly authored synthetic prose/assets. Reuse the public font and its existing provenance. Extend fixture generation with a functional miniature runtime that reads the template/manifest, resolves resources, initializes a custom element, moves supported page slots, renders supported table aliases, and provides a local button interaction. Keep any synthetic checksum/index example separate and explicitly labeled; the feature leaves such metadata untouched.

Tests must assert independent expected text/structure and byte slices. A successful reimport alone is insufficient evidence of correct export. Run model/worker tests in all available engine projects; interaction cases target Chromium/Firefox. Preserve the existing explicit WebKit skips and K01 expected-failure probe. The new tests must not imply Safari support.

Except for cases explicitly testing v1, ineligibility, or errors, tests must open a v2 review and use the actual original-format exporter. Falling back to static export does not satisfy them. For standalone link checks, follow local fragments and inspect external `href` values without navigating to external hosts.

| ID | Mandatory case and expected result |
| --- | --- |
| RT01 | No comments, only resolved comments, and accept-then-undo each export byte-identically to the original, including BOM, CRLF, outer whitespace, and mixed-case tags. |
| RT02 | Mixed decisions and an open preview export accepted wording only; no note, proposed text, reviewer mark, delimiter, or model data leaks into either clean output. |
| RT03 | Accept `word→Edited`, remove its annotation, annotate `Edited→Final`, save/reopen, accept, export: final source contains `Final`; undo the second suggestion restores `Edited`, never original `word`. |
| RT04 | Identical passages and duplicate HTML IDs: select the second passage; only its mapped original text changes. |
| RT05 | Two disjoint comments in one unit; accept in both orders with different-length replacements, reject/undo one, and remove the other. Remaining annotation ownership and final text are identical to explicit expected results. |
| RT06 | Replacement crosses bold/italic/link units in one block: replacement belongs to the first unit, later selected pieces disappear, tags/attributes remain; undo restores each `before`. |
| RT07 | Empty replacement, complete-unit deletion, empty accepted mark, save/reopen, undo, and accepted-annotation removal preserve empty units and correct source deletion. |
| RT08 | A selection across an existing owned empty run is blocked; selections wholly before and after it work. No new annotation can steal a deletion anchor. |
| RT09 | Comment spanning blocks works; a replacement or conversion to a suggestion spanning blocks remains blocked. |
| RT10 | Footer-first/header-last source order, normalized slot movement, and table aliases retain correct source IDs; export preserves original slots/aliases and placement. |
| RT11 | `A<script>...</script>B` and ordinary adjacent units survive DOM `normalize`, removal of annotations, and three serialize/reparse cycles without merging unit identities. |
| RT12 | Named/numeric entities, a multi-code-point entity, literal ampersand/less-than, CRLF, and literal CR replacement produce exact decoded characters. Unchanged source spans remain identical. |
| RT13 | All four `pre` examples in section 10, plus nested `pre>code`, save/reopen, static export, and insertion/deletion of leading LF. |
| RT14 | Emoji surrogate pairs, combining marks split across inline units, ZWJ sequences, RTL, and Unicode normalization variants: valid selections preserve exact strings; invalid scalar/grapheme endpoints are rejected without silently changing the range. |
| RT15 | Replacement/notes containing closing-script text, quotes, backslashes, U+2028/U+2029, and HTML-looking text remain inert; output marker count and runtime script count remain unchanged. An ASCII original with no BOM/charset declaration exports new emoji and RTL text correctly through ASCII JSON escapes. |
| RT16 | Real marker with quoted `>` attributes plus fake markers in comments, attributes, script text, and inert template contents; only actual discovery rules apply. Duplicate or mode-dependent markers fail eligibility. |
| RT17 | Foster-parented table text, malformed formatting, overlapping/missing locations, unsupported raw contexts, and foreign text yield v1 fallback without weakening ordinary import validation. |
| RT18 | Manifest/asset/runtime hashes and original prefix/suffix bytes match before/after export. No recompression or regenerated identifiers. |
| RT19 | Renamed matching source succeeds; changed byte, wrong filename with wrong content, altered BOM, same template in a different wrapper, and stale file fail reattachment without state changes. |
| RT20 | A changed saved base with otherwise matching file hash is rejected when original projection is regenerated; include swapped unit markers, altered image data, changed CSS, and changed unit ancestry. |
| RT21 | Tamper every required field class: unknown keys/version, duplicate IDs, invalid source span, missing delimiter, mismatched `before`, owner/part mismatch, overlapping annotation interval, invalid status, and orphan empty run. v2 opening fails transactionally. |
| RT22 | At least three save/reopen cycles in fresh offline contexts; direct opening and Open HTML; original creator context closed; cross Chromium→Firefox and Firefox→Chromium reopen; no original needed for ongoing review. |
| RT23 | v1 fixture and ordinary/static documents retain existing workflows; supplying an original does not enable v1 restoration; pre-change reader rejects v2 rather than dropping fields. |
| RT24 | Restored bundle reimport starts a new review with revised wording as its original baseline and no old comments. A second restoration cycle succeeds. |
| RT25 | During import, save, reattachment, worker processing, and export, no input bootstrap/script/handler executes and no external request occurs. Existing frame sandbox/CSP strings remain unchanged. |
| RT26 | Open original and restored functional synthetic bundles in separate fresh contexts outside the reviewer: custom element, PNG/SVG/font resources, slots, table aliases, links, and local button behavior work. No injected replacement executes. |
| RT27 | Synthetic derived thumbnail/index/checksum payload remains byte-identical; no unsupported automatic regeneration is claimed. Newly introduced `{{...}}` prose fails patch validation, while a literal `pre/code` example works. |
| RT28 | Draft active, cancel dialog, cancel during source hash/parse/export, worker error/messageerror/timeout, document switch, and stale queued response produce no partial download or model mutation. |
| RT29 | Failed/canceled import preserves the current original cache; successful switch drops it. Failed reattachment leaves existing cache intact. Cancellation restores all controls and draft state. |
| RT30 | Every new limit at `limit-1`, `limit`, and `limit+1`; use substituted constants for routine cases and dedicated production-size cases. Include entity/JSON escaping growth, metadata, text units, runs, parts, nodes, depth, and attributes. |
| RT31 | Oversized save retains dirty state; rejected acceptance leaves original owned run/status unchanged; oversized combined pending preview shows its unavailable message without displaying stale output. |
| RT32 | `file:`, loopback HTTP, an intercepted HTTPS application origin, offline saved copy, and missing Worker/crypto/Segmenter capability. Fresh ineligible bundles keep v1 review; unsupported v2 cannot silently downgrade. |
| RT33 | Generated artifact check, saved app contains worker/model/licenses, no CDN/runtime module fetch, outer-only `worker-src blob:`, and zero worker/object-URL accumulation after 10 operations. |
| RT34 | Static v2 export reparses with expected accepted text and no app state; external-link cleanup matches current static behavior, including `pre` leading LF protection. |
| RT35 | UI counts include changed units whose comments were removed; pending comments do not block export. Download is an explicit action, name is sanitized, original is never overwritten, dirty state stays unchanged. |

## 14. Performance and validation commands

Use the existing reference fixture (18,314,105-byte bundle, 320 images, public font) and machine class documented in `testing.md`. Create 100 comments with 20 pending suggestions and include accepted removals. Record actual measurements; do not substitute estimates into the validation record.

For the origin smoke test, fulfill navigation to `https://reviewer.test/` with the application's bytes through Playwright `page.route`, before navigation. Permit only that test-owned fulfilled URL; abort and fail all other external requests. This tests an HTTPS secure context without an external server or certificate dependency. Assert `isSecureContext` and successful worker/digest behavior explicitly. Use the existing loopback server helper for HTTP.

For the performance state, first accept and remove 20 annotations in different units, then retain 80 accepted and 20 open suggestions in another 100 units. This produces 100 active comments and 100 changed units. Prepare this fixture before timing export.

New Chromium performance gates:

- Eligible import through source analysis, conversion, and visible commit: at most 10,000 ms.
- Original export with cached source and 100 changed text units: at most 10,000 ms, excluding file-picker time.
- Reattachment plus export: at most 15,000 ms, excluding file-picker time.
- Existing initial-preview/decision gates remain 5,000 ms each. Prepare an actionable visible button before starting the decision timer, as existing tests do.
- Cancellation while a source parse/export worker is demonstrably active: controls restored and worker terminated within 500 ms.
- After 10 import/export/cancel cycles and test-only GC: exactly two permanent review iframes, zero candidates, zero live workers, zero live worker/download object URLs after cleanup; retained DOM document count does not grow beyond the established baseline. Retained main-thread JS heap growth must stay below 32 MiB. Record peak heap and main-thread long tasks as diagnostics, without presenting those measurements as a portable browser memory cap.

Run full-size cases in Chromium; routine substituted-limit cases run in Chromium/Firefox and applicable WebKit projects. Do not relax limits/gates to hide failures. Optimize within the specified model and worker design.

Required final commands, with the documented browser/system dependencies installed:

```sh
npm ci
npm run build:roundtrip
npm run check:roundtrip-build
npm test
npm run test:performance
git diff --check
```

The existing 300 functional passes are a historical baseline, not an assertion about the new implementation. Report new pass/skip/expected-failure counts and explain any changed scope. Do not update the research report's historical experimental results to imply production coverage.

## 15. Implementation order and completion criteria

Implement in this order; these are milestones, not choices requiring another design discussion:

1. **Pure model and persistence schema.** Implement the exact unit/run representation, validators, transitions, limits, and RT03–RT08/RT21 model cases. Demonstrate accepted annotation removal followed by another edit, save/reopen, deletion, and undo against explicit expected strings.
2. **Projection.** Add temporary source-node paths and invisible delimiters through the actual converter/sanitizer/stager. Pass RT10–RT17 before integrating restored output. Use the specified fallback for ineligible structure; do not guess mappings.
3. **Worker/source assembly.** Implement bounded parsing, hashing, text encoding, structural proof, byte slicing, and cancellation. Pass no-change byte equality and changed-source preservation before adding the download UI.
4. **Application integration.** Wire v2 review operations, save/reopen, preview/static export, source cache, reattachment, dialog, messages, and generation/revision guards.
5. **Complete verification.** Run the full matrix, existing suite, functional runtime comparison, cross-browser saved-copy cycles, performance gates, and build reproducibility checks. Update `testing.md` with actual outcomes and retained limitations.

Completion requires all specified behavior and tests, no production input-script execution inside the reviewer, no temporary source files/assets added as fixtures, and a single offline-capable distributed HTML file. This specification authorizes implementation scope; it does not itself implement the feature or instruct a commit/push.

If a test exposes a defect, fix the specified algorithm or reject the input through the specified eligibility rule. Do not silently drop accepted text, discard v2 metadata, weaken byte-preservation guarantees, enable source scripts, or replace the model with quote matching to make a case pass.
