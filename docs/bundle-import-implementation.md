# Bundled HTML import: implementation specification

Status: implementation delivered. See [testing.md](testing.md) for reproducible commands, validation results, and browser coverage.

Browser scope, confirmed during implementation: full review support targets Chromium and Firefox. WebKit remains covered for import/rendering and applicable lifecycle/isolation behavior, but review interactions are unsupported because its sandbox blocks parent-owned event handlers ([WebKit issue 218086](https://bugs.webkit.org/show_bug.cgi?id=218086)). Keep the sandbox unchanged, display a capability-based browser notice, and retain an expected-failure regression probe for this limitation. This qualification supersedes the original all-engine interaction acceptance requirement.

The implementation must make supported, self-contained HTML document bundles reviewable through the existing **Open HTML** and drag-and-drop actions. Conversion happens locally in the browser. The distributed application remains one HTML file.

The decisions below are requirements. Implement the stated profile, limits, rendering contract, and tests. Do not expand support to arbitrary executable applications, introduce a server, or execute input scripts to obtain document content.

## 1. Scope and existing behavior

The repository currently contains `index.html`. Its application script stores a document and comments, renders sanitized HTML in a sandboxed iframe, clones that document for suggestion previews, and downloads either a complete annotated reviewer or revised static HTML.

Relevant existing integration points are `readFile`, `parseHtml`, `sanitizeDocument`, `validatePayload`, `loadReview`, `reviewSnapshot`, `refreshPreview`, `saveAnnotated`, and `exportClean`. Use function names to locate code; line numbers will change.

Preserve these contracts:

- Static HTML continues to use the existing review workflow.
- `FORMAT` stays `local-html-reviewer-v1`. Existing valid annotated copies remain readable.
- Suggested replacements are plain text. They inherit formatting at the beginning of the selection and can replace text within one block. Comments can span blocks.
- Preview applies pending suggestions without accepting them. Revised exports contain accepted changes only.
- Saving is manual. Importing and conversion never overwrite the source file.
- Source scripts, external resource loads, forms, and external navigation remain disabled inside the review frames.

The new supported format has a static HTML template and an embedded asset manifest inside script elements. Its bootstrap JavaScript normally unpacks these and initializes document components. Import the data directly and replace the component behavior with the static rendering contract in section 6.

Validation uses synthetic documents with explicit expected content. No sample-dependent behavior is part of the import format.

## 2. Deliverables and file organization

Implement the following files:

| File | Responsibility |
| --- | --- |
| `index.html` | Inline importer, import progress/cancellation, transactional document loading, rendering CSS, help text, and download size checks. |
| `package.json`, `package-lock.json` | Test-only dependencies and commands. Use Node.js 22 or later and pin `@playwright/test` to `1.57.0`, the selected test-library version. No runtime dependencies. |
| `playwright.config.cjs` | Chromium, Firefox, and WebKit projects; desktop and narrow viewport coverage as specified below. |
| `tests/helpers/bundle-fixtures.cjs` | Deterministic synthetic document and bundle generation using Node built-ins. |
| `tests/helpers/reviewer.cjs` | File import, text selection, download reading, state snapshot, and offline request assertions. |
| `tests/helpers/importer.cjs` | Isolated evaluation of the actual inline importer with test-substituted limits for inexpensive boundary coverage. |
| `tests/fixtures/legacy-review.html` | Small synthetic annotated review generated with the pre-change application, before editing production code. |
| `tests/assets/FiraSans-Regular.woff2`, `tests/assets/Fira-LICENSE.txt`, `tests/assets/README.md` | Public test font, its license, and provenance. See section 10. |
| `tests/bundle-import.spec.cjs` | Format detection, validation, resource conversion, and rendering tests. |
| `tests/review-workflow.spec.cjs` | Selection, annotations, previews, decisions, and portable exports. |
| `tests/import-lifecycle.spec.cjs` | Failure preservation, cancellation, concurrency, and loading UI. |
| `tests/import-isolation.spec.cjs` | No script execution, external loads, or navigation from imported content. |
| `tests/import-edge-cases.spec.cjs` | Additional boundary, encoding, classification, cancellation, and portability coverage. |
| `tests/browser-compatibility.spec.cjs` | Parent event capability and the explicit WebKit limitation. |
| `tests/performance.spec.cjs` | Large synthetic document tests and timing diagnostics. |
| `.gitignore` | Ignore dependency and generated test directories only. |
| `docs/testing.md` | Exact commands, browser setup, test scope, and fixture-generation instructions. |

Use `.gitignore` entries for `node_modules/`, `test-results/`, `playwright-report/`, and `tests/generated/`. Generate large fixtures in memory; do not check in large generated HTML bundles. Do not add a root README or change deployment configuration.

Keep production JavaScript inline. Add a classic inline script with `id="bundle-importer"` before the application script. It declares one global lexical constant, `bundleImporter`, whose value is a frozen object exposing `detect` and `convert`. Do not assign it to `window`, add test-only production branches, introduce modules requiring an HTTP origin, or add a build step. The existing saved-application template must include this script.

The test runner can call the lexical binding through browser evaluation. This is also the boundary for focused importer tests; UI tests must exercise the public controls.

## 3. Importer interface and classification

Use this interface:

```js
bundleImporter.detect(parsedDocument)
// Returns null for non-bundles, or a descriptor holding marker text strings.
// Throws ImportError for partial, duplicate, or unsupported bundle markers.

await bundleImporter.convert(descriptor, {
  signal,                    // AbortSignal, required
  onProgress                 // ({ phase, completed, total }) => void
})
// Returns { html, assetCount, decodedBytes, resources, warnings }.
// html is normalized, self-contained static HTML, ready for sanitizeDocument.
// resources is [{ mime, url }] for unique referenced embedded resources.
// warnings is an array of fixed warning codes, never excerpts from the input.
```

`ImportError` carries a stable `code` and an application-owned message. Browser exception messages, JSON snippets, asset names, document text, and file contents must not appear in user-visible errors or console logs. Cancellation uses `AbortError` and is not an error toast.

`convert` emits phase `assets` while processing non-script manifest entries, with `completed` starting at zero and `total` equal to their count; it emits `normalize` when building the static document. The application owns the reading/checking phases. `assetCount` equals the final unique referenced-resource count, `decodedBytes` is the aggregate decoded byte count including unused non-script manifest entries and distinct pre-embedded data resources, and `warnings` is exactly `['STATIC_LAYOUT']` for a successful bundle conversion. Counters are numbers; progress callbacks never receive input strings or resource identifiers.

Classification order after decoding and parsing is fixed:

1. A single `script#review-data[type="application/json"]` with a non-null payload is an annotated review. Validate its existing format and anchors. Invalid JSON or an invalid/nonmatching non-null format is an error; do not interpret it as ordinary HTML.
2. A `review-data` value of `null` is not a saved review; continue classification. This preserves opening an unused copy of the reviewer itself.
3. If any `script[type]` has a type beginning exactly with `__bundler/`, run bundle detection. Partial or unknown bundle formats are errors, not ordinary HTML.
4. Otherwise, use the ordinary static HTML path.

Duplicate `review-data` markers are errors. A valid non-null annotated payload takes precedence over other markers in its outer wrapper; only its validated `documentHtml` is used. Do not recursively unpack a saved review's document. Reject bundle markers inside an annotated payload's `documentHtml` with `INVALID_REVIEW`.

The supported bundle markers are exactly:

| Type | Requirement |
| --- | --- |
| `__bundler/manifest` | Exactly one; JSON object keyed by asset UUID. |
| `__bundler/template` | Exactly one; JSON string containing HTML. |
| `__bundler/ext_resources` | Zero or one; JSON array of `{ id, uuid }` mappings. |
| `__bundler/page_order` | Zero or one; JSON empty array only. |

Duplicate/missing markers and malformed marker JSON produce `INVALID_BUNDLE`. Unknown `__bundler/…` types, nonempty page order, and nested bundles produce `UNSUPPORTED_BUNDLE`. Ignore the outer bootstrap, placeholder markup, styles, and thumbnail. They must not enter the normalized document.

Read all marker values with `JSON.parse`; never use `eval`, `Function`, script injection, or a renderer iframe with script execution enabled.

## 4. Validation and limits

Use binary units and these exact production limits. Equality is accepted; exceeding a limit fails.

| Constant | Value | Where enforced |
| --- | --- | --- |
| `MAX_INPUT_BYTES` | 64 MiB | `File.size`, before reading any input HTML, including annotated copies. |
| `MAX_TEMPLATE_BYTES` | 2 MiB | UTF-8 byte length of decoded template, before parsing it. |
| `MAX_ASSETS` | 1,024 | Own enumerable manifest entries, including unused/script entries. |
| `MAX_ASSET_BYTES` | 8 MiB | Decoded bytes of each non-script asset, during streaming decompression. |
| `MAX_TOTAL_ASSET_BYTES` | 32 MiB | Sum of decoded non-script asset bytes, during decompression. |
| `MAX_NORMALIZED_BYTES` | 48 MiB | UTF-8 normalized HTML; also guard cumulative resource-substitution growth before constructing oversized output. |
| `MAX_DOWNLOAD_BYTES` | 64 MiB | UTF-8 serialized annotated/revised output, before creating the download Blob. |
| `IMPORT_TIMEOUT_MS` | 30,000 | Whole prepare/stage operation, excluding the user's discard confirmation. |
| `STAGING_TIMEOUT_MS` | 10,000 | Candidate frame load; also bounded by the remaining import timeout. |

The input limit intentionally applies to all file types accepted by the application. An oversized download fails visibly and keeps the review dirty. Do not mark it saved. Ensure generated outputs below the download limit can be reopened under the input limit.

Manifest schema:

- Top level must be a non-null object, not an array. Use `Object.entries`, `Object.hasOwn`, and `Map`; do not merge input keys into ordinary objects.
- Keys must be lowercase canonical UUID strings matching `^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`.
- Each value must be an object with `mime: string`, `data: string`, and optional `compressed: boolean`. Missing `compressed` means false. Ignore other entry fields; never spread them into application objects.
- Trim/lowercase `mime` before matching. Parameters such as `;charset=utf-8` are unsupported.
- Supported asset MIME types are `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `image/svg+xml`, `font/woff`, and `font/woff2`.
- `text/javascript` and `application/javascript` entries are recognized runtime entries. Validate their field types, but do not decode, decompress, execute, substitute, or save their payloads.
- Reject all other MIME types, including HTML and CSS assets. Inline document CSS is supported; linked/bundled stylesheets are outside this profile.
- Base64 must contain only standard alphabet characters and correct terminal padding; accept ASCII whitespace between characters. Reject URL-safe alphabet, misplaced padding, and impossible length. Require a canonical encode/decode round trip after whitespace removal for non-script assets.
- Validate base64, decompress, and check the MIME signature of every supported non-script entry, even if unused. Browser image/font decoding is required only for referenced resources. Unused valid assets need not appear in the output.
- Optional external mappings require string `id` and valid `uuid` fields, with unique IDs. Every mapping must target an existing JavaScript entry. The mappings are validated and then discarded. Non-script mappings are unsupported.

Decompression rules:

1. Feature-detect `DecompressionStream` only if at least one non-script entry is compressed. Uncompressed bundles and existing static/annotated documents continue to work without it.
2. Decode base64 in bounded chunks; do not pass an asset-sized argument list to `String.fromCharCode` or use a spread operation over asset bytes.
3. Process one asset at a time. For compressed entries, stream through `new DecompressionStream('gzip')` and read output chunks with a reader. Check per-asset, aggregate, cancellation, and elapsed-time limits on each chunk. Do not collect an unbounded stream with `new Response(stream).blob()` before checking limits.
4. Fully drain/finish the stream so checksum, truncation, and trailing-data errors are observed. Treat decompressor failure as `INVALID_ASSET`; never fall back to rendering compressed bytes.
5. For uncompressed entries, apply the same byte limits before retaining bytes.
6. Check cancellation between base64 chunks and assets. Yield to the event loop at least every 8 ms of measured JavaScript work; use `setTimeout(resolve, 0)` for the yield. No worker is required for this version.
7. Release packed input, per-asset buffers, and the manifest when no longer needed. Retain only data URLs required by the output during normalization.

Native gzip support is available through the browser's [Compression Streams API](https://developer.mozilla.org/en-US/docs/Web/API/Compression_Streams_API). The [Compression Standard](https://compression.spec.whatwg.org/) defines invalid gzip handling; surface an application-owned error instead of its engine-specific wording.

Before creating a data URL, check that declared MIME agrees with the decoded file signature: PNG signature, JPEG SOI, GIF87a/GIF89a, RIFF/WEBP, ISO-BMFF `ftyp` with an `avif`/`avis` compatible brand, XML with an SVG root, `wOFF`, or `wOF2`, respectively. Signature mismatch is `INVALID_ASSET`. Signature checking does not replace subsequent browser decoding.

## 5. Asset references and inactive parsing

The output must contain permanent `data:` resource URLs. Do not use `blob:` URLs for document assets. Object URLs are allowed only for the application's download mechanism. Browser-created object URLs are released when their originating document unloads, so they cannot be saved as portable image references. [MDN: blob URL lifetime](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob)

Parse input in a detached document using the existing restrictive application CSP. Never attach source nodes or temporarily insert input markup into the live application document. `DOMParser` disables script execution but is not itself a complete network isolation mechanism; keep CSP enforcement and test parse-time requests. [MDN: DOMParser](https://developer.mozilla.org/en-US/docs/Web/API/DOMParser/parseFromString)

Substitute references by context, not by globally replacing UUID-looking text:

| Context | Behavior |
| --- | --- |
| HTML `img[src]` | A UUID reference must resolve to an image asset. Existing supported image `data:` URLs remain after the validation below. |
| CSS `url(...)` in style elements and style attributes | Resolve UUIDs to the correct data URL. Font-face sources require font assets; image-valued declarations require image assets. |
| SVG image asset content | Validate as described below; do not resolve inter-asset references inside SVG in this version. |
| External anchor `a[href]` | Preserve the existing disable-during-review behavior. Revised export restores the existing original-link metadata. Anchors are not asset dependencies. |
| `script[src]`, executable attributes | Remove through sanitization; never resolve or execute them. |
| Text nodes, comments, IDs, classes, unrelated attributes, CSS string literals | Preserve exactly. A UUID appearing as prose is not a resource reference. |

For bundle resources, accept a bare UUID or a UUID followed by a fragment, such as an SVG fragment ID. UUID matching is case-insensitive at reference sites; lookup uses lowercase. Preserve the fragment suffix. Queries on UUID references are unsupported. Unknown UUIDs fail with `MISSING_ASSET`; a script UUID used as an image/font fails with `INVALID_ASSET`.

Reject non-data, non-fragment external/relative resource URLs in a bundle with `EXTERNAL_RESOURCE`. The file must be self-contained. This does not reject normal external hyperlinks. Ordinary static HTML retains its existing resource-blocking behavior.

For pre-embedded data URLs in bundles, support exactly `data:<supported-mime>;base64,<payload>` with no extra MIME parameters. Validate/decode them under the same signature, per-resource, aggregate-byte, SVG, and browser-decode rules. Count identical direct data URLs once; do not count newly generated manifest data URLs a second time. Non-base64 or differently parameterized data resources fail `UNSUPPORTED_BUNDLE`. Ordinary static HTML is not subject to this new format restriction.

First inspect the template for unsupported structure and document-logic markers from section 6. Then remove source scripts, iframe/frame/object/embed/base elements, and non-stylesheet link elements before inspecting remaining resource contexts, matching the existing sanitizer's exclusions. Reject bundle audio/video/track elements with `UNSUPPORTED_BUNDLE`; their static fallback is not part of this version. An external URL on a removed element cannot become an import dependency. For `form[action]`, retain form content but remove action/target and block submission through the existing CSP/event handling.

For this version, reject a bundle containing nonempty `srcset`, `imagesrcset`, a linked stylesheet, or CSS `@import` with `UNSUPPORTED_BUNDLE`. Do not silently discard a potentially necessary responsive image or stylesheet. A plain `<picture>` with an `<img>` and no source candidates may remain.

Implement a small CSS token scanner for URL rewriting. It must track strings, escapes, and comments; recognize case-insensitive `url()` function tokens; decode CSS escapes in the function name and URL value; accept quoted/unquoted URLs; and preserve non-URL strings/comments. Re-emit resolved URLs quoted and escaped. Do not use a document-wide regular expression. Recurse through grouping rules when validating style-sheet declarations. Malformed CSS with a resource reference that cannot be safely classified is an import error; unrelated invalid CSS can follow normal browser handling.

Validate referenced embedded image assets before committing: decode with an image element in the candidate frame, require positive natural dimensions, and enforce a maximum of 40,000,000 pixels for any image and 160,000,000 pixels across unique image assets. These decoded-image limits are additional to byte limits. Duplicate references count once for this limit. Include CSS images using the returned resource list; checking only `document.images` is insufficient. Invalid images fail with `INVALID_ASSET`; excessive dimensions fail with `LIMIT_EXCEEDED`. Run at most four explicit validation decodes concurrently and check cancellation between batches. This is a best-effort browser allocation guard, not a claim that the decoder allocates no memory before dimensions are known or that browser-initiated loads of visible resources are serialized.

For SVG assets, parse as XML before creating their data URL. Require an SVG root and no parser error. Reject `script`, `foreignObject`, `iframe`, `object`, `embed`, event-handler attributes, `xml:base`, and references to anything except local `#fragment` identifiers. Inspect namespaced/local `href` and `src` attributes plus URL-bearing presentation attributes, including `fill`, `stroke`, `filter`, `clip-path`, `mask`, and the marker attributes. Match element/attribute local names, so a namespace prefix does not bypass a rule. Apply the same CSS URL scanner to SVG style elements, style attributes, and presentation attributes; reject external URLs and `@import`. SVGs remain image resources, never inline DOM inserted into the reviewer. Preserve valid XML and namespaces when serializing.

Validate font assets after loading the candidate document: for each referenced face with an embedded font source, explicitly load the corresponding `FontFace` from the candidate's `document.fonts` and require success. Do not require every unused declared face to have already been selected by visible text. Font failure is `INVALID_ASSET`. Bound these loads by the staging/import timeout.

The transient `resources` list belongs to the import job only. Release it at commit/failure; do not add it to the saved review model or duplicate embedded assets in the saved payload.

## 6. Supported document structure and static layout

Preserve the template's language, title, visible text, inline formatting, image alt text, lists and start values, IDs, fragment links, captions, tables, and author CSS, subject to the sanitizer and the explicit unsupported cases below.

Supported custom structures:

| Input | Normalization |
| --- | --- |
| `x-dc` | At most one. Keep as an inert container and add the generated layout class `hri-static-root`. No component registration or runtime. |
| `helmet` or `sc-helmet` | Move safe `style`, `title`, and `meta` children into the detached document's head, preserving order. Discard script children. Reject other child element types. Remove the wrapper. |
| `doc-page` | At most one, with flowing document content. Keep the tag as an inert element, add `hri-static-document`, and implement its presentation entirely with the CSS below. There must be no shadow root. |
| `sc-raw-table`, `sc-raw-thead`, `sc-raw-tbody`, `sc-raw-tfoot`, `sc-raw-tr`, `sc-raw-td`, `sc-raw-th`, `sc-raw-caption` | Replace with their real HTML table elements, preserving attributes and child nodes. |

Keeping the `x-dc` and `doc-page` tag names is intentional: author CSS selectors targeting these tags continue to match. These are passive containers after import. Do not instantiate custom elements, preserve a live shadow tree, or load their component scripts. The normal DOM must contain all reviewable text. The existing `outerHTML`-based save mechanism excludes shadow roots, which is another reason to use this static representation. [MDN: outerHTML](https://developer.mozilla.org/en-US/docs/Web/API/Element/outerHTML)

Construct table replacements through DOM operations, with parents before descendants, while the document remains detached. Do not replace tag-like strings in text, CSS, or script payloads. Check that resulting `tr`, `td`, `th`, and table section elements have valid table ancestry before serializing. Round-trip serialization/parsing must preserve the ordered cell texts and IDs. Invalid table ancestry fails with `UNSUPPORTED_BUNDLE`.

Reject unknown custom element names containing `-`, including `sc-if`, `sc-for`, imports, and other dynamic components. Also reject any `script[data-dc-script]` containing non-whitespace logic, any attribute name starting with `:` or `@`, and interpolation syntax `{{…}}` in text/attribute values outside `script`, `style`, `pre`, and `code`. Interpolation examples inside `pre`/`code` remain literal. These rules define the supported static profile; do not attempt expression evaluation.

For a `doc-page`:

- `size` supports `a4`, `letter`, and `legal`; default `letter`.
- `orientation` supports `portrait` and `landscape`; default `portrait`.
- `margin` supports one nonnegative length in `px`, `in`, `mm`, `cm`, `pt`, or `pc`, or bare `0`; default `0.75in`. Normalize to CSS pixels using 96 px/in, 25.4 mm/in, 2.54 cm/in, 72 pt/in, and 6 pc/in. Require the margin to be at most one quarter of the shorter page dimension.
- Physical page dimensions are A4 = 210 × 297 mm, letter = 8.5 × 11 in, legal = 8.5 × 14 in. Swap dimensions for landscape.
- Reject `width`, `height`, `content-width`, or `content-height`, even if empty. Reject direct children with class `page`. Fixed-size/scaled documents and pre-paginated documents are outside version 1.
- Allow at most one direct child with `slot="header"` and one with `slot="footer"`. Move header first and footer last, preserving other children's order. Remove those slot attributes. Other nonempty slot values or non-direct slotted descendants are unsupported.
- Display header/footer once in normal flow. They do not repeat on printed pages.

If there is no `doc-page`, preserve the author's layout and do not add a paper container. Bundle asset conversion still applies.

For converted pages, append one style element with `data-hri-layout="1"`. The `data-hri-` prefix is separate from existing review metadata `data-hr-`. Preserve this stylesheet in annotated and revised output and on re-import. It is document presentation, not annotation chrome.

Use these layout values and behavior:

```css
html, body { margin: 0; min-height: 100%; }
body { background: #f0eee6; }
x-dc.hri-static-root { display: block !important; min-height: 100vh; }
doc-page.hri-static-document {
  display: block !important;
  visibility: visible !important;
  box-sizing: border-box;
  width: var(--hri-page-width);
  max-width: calc(100% - 32px);
  margin: 16px auto;
  padding: min(var(--hri-page-margin), 8vw);
  background: white;
  box-shadow: 0 2px 10px #0002;
}
doc-page.hri-static-document img { max-width: 100%; height: auto; }
@media (max-width: 720px) {
  doc-page.hri-static-document {
    width: 100%; max-width: 100%; margin: 0; padding: 24px;
    box-shadow: none;
  }
}
@media print {
  html, body { background: white; }
  x-dc.hri-static-root { min-height: 0; }
  doc-page.hri-static-document {
    width: auto; max-width: none; margin: 0; padding: 0;
    box-shadow: none;
  }
}
```

Set `--hri-page-width` and `--hri-page-margin` on the passive page element using normalized pixel values. Add an `@page` rule using the validated physical size/orientation and margin. Do not freeze element heights, capture computed styles, rasterize text, or promise the original executable page's print pagination.

Remove the loading-visibility rule whose selector is exactly `doc-page:not(:defined)` (allowing insignificant whitespace). If it is one branch of a selector list, remove only that branch. Other uses of `:defined` in bundle CSS are unsupported and must fail. No JavaScript definition will be installed after conversion.

Retain author CSS for headings, tables, images, and print breaks. Do not introduce blanket overrides to all descendants. Tests measure content visibility, overflow, and the defined page geometry; they do not require pixel equality with the source's runtime-generated shell.

## 7. Transactional import and cancellation

Refactor `loadReview` into preparation/staging and commit responsibilities. Do not assign `model`, clear `draft`, replace the displayed frame, or alter `dirty` until the new document is ready to commit.

Use a monotonically increasing import generation and one `AbortController` per job. Store them in `importJob`. Route file picker, all drop handlers, and the example action through this mechanism. Initial restoration of embedded review data uses the same staging/commit logic without a discard confirmation.

The required state machine is:

1. **Validate file envelope.** Check extension/type and file-size limit. Invalid selection reports an error and does not cancel a running valid import.
2. **Authorize discarding current edits.** Reuse the existing confirmation if `dirty` or the draft has changes. If another import is already pending, reuse its discard decision because editing is frozen. Dismissing a file chooser or rejecting confirmation preserves the current job and review.
3. **Start job.** Abort a previous job, allocate a new generation/controller, start the timeout, and enter the busy UI. Preserve the current model, draft form values, dirty state, comment filter, active comment, preview settings, and scroll positions.
4. **Prepare.** Read/decode the file with the existing BOM/charset behavior, classify it, convert if needed, then sanitize. Check generation and cancellation after every await. Preparation may not mutate the old model or visible document.
5. **Stage.** Append one hidden candidate iframe beside the old frame in the same document-stage parent, with the same sandbox and referrer policy as the document frame. Give it sanitized `srcdoc`; never use raw source here. Await load, validate the candidate DOM and annotation anchors, and perform the bundle image/font checks. The current document remains displayed. The candidate's `id` is `import-candidate-frame` while staging.
6. **Commit.** Only the current generation may commit. Cancel scheduled scroll/preview callbacks, invalidate outstanding preview loads, and clear the draft/selection. Synchronously remove the old document frame, rename the already-mounted candidate to `document-frame`, unhide it, update `frame`, bind its handlers, then assign the new model and render comments. Do not move/reparent the candidate: moving an iframe can reload its browsing context and invalidate the preceding validation. Reset active comment and filter to All. Set `dirty=false`. Finish busy UI and update filename/save state.
7. **Failure/cancellation.** Remove only this job's candidate, cancel pending readers/load listeners/timers, and release conversion buffers. Restore the previous controls and state. Cancellation produces no error toast. A stale job must not clear a newer job's UI, show an error, or alter its controller.

Change the existing `const frame` binding to `let frame` for candidate replacement. Keep `previewFrame` stable. Rebuild its contents from the committed document. Ensure scheduled callbacks cannot target a detached old frame or replace the new preview with an older generation.

New ordinary/bundle imports retain the current preview-open and scroll-together preferences. Annotated copies with a `view` object restore that object; old copies without it retain current preferences. The new document starts at its top. Failure/cancellation preserves the old document's reading position.

Draft restoration is literal: keep the existing form and range references alive until commit. Do not reconstruct a canceled draft from a serialized snapshot. Freeze editing while preparing so its DOM anchors cannot change underneath it.

## 8. UI, errors, and serialization

Add `#import-status` inside the file information area, separate from `#save-state`, with a polite live status message and a `#cancel-import` button. Show the following fixed phase messages:

- `Reading document…`
- `Unpacking assets… {completed} of {total}`
- `Preparing document…`
- `Checking document…`

Update asset progress at most ten times per second and on phase completion. Set the workspace's `aria-busy` while importing. Freeze document interaction and the comment sidebar with `inert`, hide the selection popup, and disable Save, Export, Preview, Add comment, and comment filtering. Preserve their prior disabled states for failure/cancellation. Keep Open HTML, Cancel, and Help available. Drop of a new valid file remains available to replace the pending job. Prevent review keyboard shortcuts while busy; Escape cancels import. Save shortcuts must not fall through to the browser's Save Page action.

On cancellation/failure, restore focus to the previously focused control if it still exists and is enabled, otherwise to Open HTML. On success, focus the enabled Preview suggestions button. If Help is open when a job finishes, preserve focus within that modal instead. Do not restore a popup whose selection is stale after a successful commit.

On successful bundle import, set save state to `Bundle converted locally · original file unchanged` and show this toast once: `Opened as a static document. Page layout may differ from the original.` This is the single warning `STATIC_LAYOUT`; do not list technical wrapper names in the UI.

Add to Help: `Supported bundled documents are unpacked locally into static HTML. Their text, embedded images, and fonts remain reviewable. Interactive components and exact original print pagination are not preserved.` Replace the existing blanket static-files-only wording as needed to avoid contradicting this sentence.

Use these stable messages, prefixed by `Could not open the file. ` for import errors:

| Error code | Message |
| --- | --- |
| `INVALID_REVIEW` | `This annotated copy is invalid or its comment anchors are damaged.` |
| `INVALID_BUNDLE` | `This bundled document contains invalid or incomplete data.` |
| `UNSUPPORTED_BUNDLE` | `This bundle uses document features that this reviewer cannot convert.` |
| `MISSING_ASSET` | `An embedded image or font is missing from this bundle.` |
| `INVALID_ASSET` | `An embedded image or font could not be decoded.` |
| `EXTERNAL_RESOURCE` | `This bundle depends on files that are not embedded in it.` |
| `LIMIT_EXCEEDED` | `This document exceeds the reviewer's import limits.` |
| `DECOMPRESSION_UNAVAILABLE` | `This browser cannot unpack compressed bundles. Use a current Chrome or Firefox.` |
| `IMPORT_TIMEOUT` | `Opening this document took too long. Your current review has been kept.` |
| `IMPORT_FAILED` | `This document could not be opened. Your current review has been kept.` |

Retain the existing wrong-file-type message. Oversized download message: `This copy is too large to download. Your review has not been marked as saved.`

Serialization requirements:

- Keep `FORMAT` and the existing comment schema. Do not embed the original manifest, bootstrap, component scripts, or source text as a second copy.
- Save the normalized document, including its data URLs and layout CSS, through the current review snapshot. No new saved metadata is required.
- Annotated downloads include the updated reviewer so they can reopen directly with all controls.
- Revised downloads remove review marks and `style[data-hr-style]` only; retain converted layout styles. They must not contain source executable scripts or session-scoped asset URLs.
- Preserve existing JSON escaping of `<`, U+2028, and U+2029. Test comments and replacements containing literal closing script tags.
- Apply download-size validation before changing the dirty state or reporting success.
- Add no automatic storage, telemetry, network calls, external dependency URLs, or upload behavior.

Keep both frame sandboxes at `allow-same-origin` only and retain the current restrictive CSP. Do not add `allow-scripts`, `unsafe-eval`, remote resource origins, or `blob:` permission for document images/fonts. Combining script execution and same-origin access would undermine the existing isolation model. [MDN: iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)

## 9. Test harness and execution

Define these package scripts:

```json
{
  "test": "playwright test --grep-invert @performance",
  "test:chromium": "playwright test --project=chromium --grep-invert @performance",
  "test:performance": "playwright test tests/performance.spec.cjs --project=chromium"
}
```

Use exactly three default projects: `chromium`, `firefox`, and `webkit`, with desktop viewport 1440 × 1000 and device scale factor 1. The responsive tests explicitly set 390 × 844 and 800 × 900 within each project. Use one worker for resource-limit and performance suites; other synthetic tests may use two workers. Use a 30-second assertion/test timeout, with 60 seconds for tests deliberately exercising the import timeout. No blanket retries.

Open the application using an absolute `file:` URL generated by Node's `pathToFileURL`. File-based operation is a release requirement. Also run the principal happy-path test against a loopback-only HTTP server bound to `127.0.0.1`; it serves only the application, never arbitrary filesystem directories. Start and close that server inside the test harness.

For every test context:

- Block service workers. Record every attempted non-local HTTP(S) request and abort it. Fail if imported content attempts one; do not treat the abort itself as success. Permit only the explicitly started loopback app server in its dedicated test.
- Use offline mode for persistence tests. Capture and fail on unexpected page errors. CSP diagnostic console messages from deliberately blocked fixtures are allowed; application exceptions are not.
- Read downloads into buffers using the download stream. Reopen saved annotated files both directly as files and through Open HTML in a fresh browser context, after closing the original page/context.
- Select text primarily with DOM Range helpers that identify exact text-node offsets, then trigger the same mouseup/keyboard path the app listens to. Include at least one real mouse-drag and one real keyboard-selection test per engine.
- Assert user-visible outcomes and serialized documents; do not compare the importer output to another implementation of the same converter.
- Use locator/event-based waiting rather than fixed sleeps. Use bounded polling for browser layout/scroll completion.

Synthetic test traces/screenshots may be retained on failure in ignored output directories.

## 10. Synthetic fixtures

All prose, images, identifiers, CSS, and bundle structures used as fixtures must be newly authored synthetic examples. Use no externally supplied documents or extracted assets as committed fixtures. The separately licensed public test font is the sole third-party fixture asset. Generic format marker names and runtime tag names are necessary format documentation and may be used.

Use deterministic generated UUIDs based on integer counters. Generate gzip with Node's `zlib.gzipSync`; set deterministic metadata. Create tiny PNGs from programmatically generated RGBA pixels and PNG chunks, and small SVGs from new shape markup. Use only Node built-ins for fixture generation. Asset bytes may be compressed or uncompressed independently.

Vendor this public test font once during implementation, not during tests:

- Repository revision: `mozilla/Fira` at `fd8c8c0a3d353cd99e8ca1662942d165e6961407`.
- File: `woff2/FiraSans-Regular.woff2`; SHA-256 `0fe48aded097c2a11942a70bfef48510abf875a8e800f43d4007dce8d2a3aebe`.
- License: root `LICENSE`, SIL Open Font License 1.1; SHA-256 `99bfb7c1e845b79d1031fcf37e678178eb4a8c7cc74a3f218ddf7223083a6fcd`.
- Record these URLs/hashes in `tests/assets/README.md`. Keep license bytes with the font. Source: [Mozilla Fira](https://github.com/mozilla/Fira/blob/fd8c8c0a3d353cd99e8ca1662942d165e6961407/woff2/FiraSans-Regular.woff2).

Required fixture families:

| Name | Required content |
| --- | --- |
| `plain-static` | Headings, paragraphs, rich inline text, repeated identical sentences, two adjacent paragraphs, a table, local anchors, an embedded image, and author styles. |
| `minimal-bundle` | Empty manifest; template with one paragraph and no custom wrappers. |
| `document-bundle` | Manifest images/font; ignored runtime JS; `x-dc`, `helmet`, flowing `doc-page`, all supported table aliases, header/footer, internal and external links, bold/italic/code text, ordered-list `start`, image alt text, and captions. |
| `resource-syntax` | Quoted/unquoted/escaped CSS URLs, CSS background image, font-face, SVG fragment, repeated asset use, and UUID text that must not be substituted. |
| `unicode` | German umlauts, emoji, combining characters, RTL text, BOM variants, and HTML with charset declarations. |
| `invalid-*` | One independent corruption or unsupported feature per fixture, generated from the valid baseline. |
| `active-content` | Harmless sentinel scripts/event handlers, external resource URLs, forms, links, inline SVG attempts, and malicious SVG image assets. Use `https://example.invalid/…` for external probes. |
| `large-document` | Defined below; generated in memory, not checked in. |

The legacy review fixture must be produced through the unmodified application before replacing its template: include an accepted replacement, an open replacement, a rejected replacement, a resolved plain comment, and an open plain comment on separate passages. Its expected visible texts and states must be written explicitly in the test.

## 11. Required tests and exact expected results

Every ID below must appear in a test title. Run functional cases in all three browser projects unless a narrower engine requirement is explicitly stated or the documented WebKit event limitation applies. Skipped WebKit interaction cases must be reported explicitly. Parameterized subcases are separate tests so failures identify the failing input.

### Import and resource tests

| ID | Cases and required assertions |
| --- | --- |
| I01 | Ordinary static file, unused reviewer with null review data, valid legacy review, and valid bundle classify correctly. Valid annotated data wins over wrapper bundle markers. Malformed non-null review data and duplicate markers fail with `INVALID_REVIEW`. |
| I02 | Missing/duplicate manifest or template, invalid JSON, wrong top-level types, invalid UUID keys, invalid entry field types, duplicate mapping IDs, and unknown bundle marker fail with the specified format error. No partially converted document is displayed. |
| I03 | Compressed and uncompressed images/font all render. Mixed compression works. JavaScript payloads with intentionally non-decodable strings are ignored after field-type validation and never execute. |
| I04 | Invalid base64 alphabet/padding, truncated gzip, incorrect CRC, extra trailing gzip bytes, wrong declared image MIME, and undecodable image/font fail with `INVALID_ASSET`. Unsupported MIME fails with `UNSUPPORTED_BUNDLE`. |
| I05 | Known UUID references resolve only in resource contexts. Unknown UUID fails `MISSING_ASSET`. Referencing a runtime UUID as an image/font fails `INVALID_ASSET`. Existing supported data URLs remain usable; UUID prose, classes, IDs, CSS content strings, and comments are unchanged. |
| I06 | CSS quoting, whitespace, escapes, nested grouping rules, style attributes, background images, and font sources work. External/relative resource URLs fail `EXTERNAL_RESOURCE`; `@import`, linked stylesheets, and nonempty source sets fail `UNSUPPORTED_BUNDLE`. Ordinary external hyperlinks still import. |
| I07 | Safe SVG including internal fragment references renders. SVG script, foreignObject, event attributes, external href, xml:base, external style URL, or import fails `INVALID_ASSET`. No attempted external request occurs while validating either accepted or rejected SVG. |
| I08 | Remove `DecompressionStream` with `addInitScript`: compressed bundle fails `DECOMPRESSION_UNAVAILABLE`; uncompressed bundle, static HTML, and old annotated review still open. Restore the API in a new context rather than modifying app code. |
| I09 | Test each byte/count/pixel limit exactly at and just above the boundary using focused helper calls where appropriate. Limit failure is `LIMIT_EXCEEDED`, leaves the old review intact, and does not finish allocating the full oversized decompressed output. Decompression limits are tested with highly compressible synthetic bytes. Run expensive actual-limit cases in Chromium; test common normal-size cases in all engines. |
| I10 | Nonempty page order, nested bundle, unknown component, executable document logic, dynamic binding, unknown slot, unsupported page size/orientation/length, and fixed/pre-paginated layouts fail `UNSUPPORTED_BUNDLE`. Literal code examples with template syntax remain unchanged. |
| I11 | Unicode, UTF-8/UTF-16 BOMs, declared legacy encoding in a synthetic static file, and newline variants preserve selected quotes and replacement text through import/save/reopen. |

For focused boundary tests, `tests/helpers/importer.cjs` extracts the complete inline importer script from `index.html`, replaces its named limit-constant declarations with smaller test values, and evaluates it in an isolated browser page with the application's CSP. Fail the harness if an expected declaration is not found exactly once. Exercise the same `detect`/`convert` API, not a copied implementation. Do not ship mutable limits or public debug hooks. At least one real production-limit integration test is mandatory for each limit class: file bytes, asset bytes, aggregate bytes, output growth, asset count, and image dimensions. Do not satisfy all boundary coverage solely with substituted constants.

### Rendering tests

| ID | Cases and required assertions |
| --- | --- |
| V01 | Ordered arrays of headings, paragraphs, list items, caption text, and table-cell text match explicitly authored expectations. All expected IDs/alt text/list start values survive. All images have positive natural dimensions. |
| V02 | Every referenced embedded font loads explicitly; a text sample reports the expected font family and has different measured width from its fallback. The saved file reloads that font in a fresh offline context. |
| V03 | Table aliases produce real table/section/row/cell elements with correct parentage. Export/re-import preserves cell count, text, IDs, and borders. Annotation within one cell permits replacement; selection across two cells permits only a comment. |
| V04 | Above 720 px of frame width, rendered paper width is `min(physicalWidthPx, frameWidth - 32)` and padding is `min(marginPx, 0.08 * frameWidth)`, within 2 CSS pixels. Landscape swaps physical dimensions before this calculation. At or below 720 px, width is the frame width and padding is 24 px. At 390 px, no document-level horizontal overflow exceeds 1 CSS pixel for the synthetic fixture; every heading and image remains visible and unclipped. At 800 px, check both single and comparison views. |
| V05 | Loading visibility CSS cannot hide the converted page. The head receives the expected author styles. No custom element is registered by import, no shadow root exists, and normal document traversal reaches the last paragraph. |
| V06 | Header and footer appear exactly once in defined order. In print media the paper shadow/background disappear, width/padding follow the print contract, the validated @page rule exists, and first/last synthetic text markers remain visible in the print DOM. Chromium PDF generation succeeds with nonempty output beginning `%PDF-`. This is a print-layout smoke test; PDF text extraction and exact page count are outside its acceptance criteria. |
| V07 | Internal links navigate to their expected IDs in both panes; external links do not navigate during review. Clicking a preview suggestion focuses its comment. |

Use geometric/computed-style assertions for required rendering results. Synthetic screenshots are diagnostics; do not auto-approve new pixel baselines as evidence of correctness.

### Annotation and preview tests

| ID | Cases and required assertions |
| --- | --- |
| A01 | Select a paragraph passage with a real mouse drag, add a plain comment, resolve, reopen, edit, and remove it. Each action affects only the selected passage; sidebar counts and filter results agree. |
| A02 | Select using the keyboard, invoke Ctrl/Meta+Alt+M, and add a suggestion. The quoted text and highlighted characters match, including Unicode. |
| A03 | Replace across bold/italic text within one paragraph. Accepted replacement inherits the start formatting; undo restores the original text fragments and formatting. Later unrelated comments keep their anchors. |
| A04 | Comment across adjacent paragraphs. Replacement controls are disabled. Saving/reopening preserves every marked fragment in order. |
| A05 | Annotate only the second of two identical passages. Accept/reject/reopen/undo affect the second occurrence only. Attempted overlap focuses the existing annotation and adds no duplicate mark/comment. |
| A06 | Empty replacement previews deletion, accepts correctly, preserves a usable comment target, and undoes to the exact original text. |
| A07 | Pending suggestion changes only the preview. Accept changes both panes; reject restores original wording; reopen returns it to pending. Plain/resolved comments never alter wording. |
| A08 | Use a multi-paragraph synthetic document with images and a 2,000-character replacement. At top, middle, and bottom, synchronized views show corresponding block IDs; top/bottom reach both boundaries within 2 px. At the middle anchor, correspondence is within 32 px of the configured anchor position after settling. No continuing scroll oscillation occurs. |
| A09 | Disable linked scrolling and scroll one pane: the other pane moves by no more than 1 px. Updating a suggestion preserves the preview's visible block and position within 32 px where that block survives. |
| A10 | Change decisions ten times while preview reloads are outstanding. Final displayed content, status count, active comment, and busy state match the last decision; no stale preview overwrites it. |

### Save/reopen tests

| ID | Cases and required assertions |
| --- | --- |
| S01 | Save a mix of open, accepted, rejected, and resolved items. Close the creating context. Open the download directly via file URL and separately through Open HTML; states, original fragments, replacement text, view preferences, images, and fonts match. Repeat three save/reopen cycles without accumulating layout styles, losing assets, or changing original quotes. |
| S02 | Export revised HTML with one pending, one accepted, and one rejected suggestion. Only accepted wording changes. No annotation marks/chrome or source scripts remain. Converted layout, IDs, images, fonts, and safe link destinations survive. Open directly and re-import. |
| S03 | Comment/replacement text containing `</script>`, HTML tags, quotes, ampersands, U+2028, and U+2029 remains literal text after reopening. No sentinel script executes. |
| S04 | Parse the saved state/document: no source bundle marker elements, executable source runtime, asset blob URL, or duplicate original-source payload remain. The only scripts in annotated output are the reviewer/importer and its JSON state. Bundle marker string literals in the importer's own code are expected and must not trigger a false failure. Revised output has no executable scripts. |
| S05 | Force an oversized synthetic serialization: no download is emitted, error appears, dirty state remains true, and the current review remains usable. Boundary-sized valid output can reopen. |
| S06 | Open the committed legacy fixture in the new app. Existing annotation states and content are preserved; saving it produces a directly openable new copy. |

### Lifecycle and isolation tests

| ID | Cases and required assertions |
| --- | --- |
| L01 | With unsaved comments and a modified draft, cancel the discard prompt. Filename, iframe identity, content, dirty state, filter, preview settings, both scroll positions, and draft inputs/range remain unchanged. |
| L02 | Confirm an import that later fails validation, decompression, image/font checks, or staging. The same old state remains and the draft can still be submitted to its original passage. Only the error message and transient busy UI differ. |
| L03 | Cancel during asset decoding and while awaiting the candidate frame. Old state is restored, no error toast appears, candidate is removed, and Escape/Cancel both work. Subsequent import succeeds. On successful commit, the validated candidate Document retains its identity and does not receive a second navigation/load from DOM reparenting. |
| L04 | Delay job A deterministically, start B, then release A. B is the only committed document and its UI remains intact. Repeat with A rejecting late. Also start the example while a file import is pending. |
| L05 | While busy, editing/decisions/save/export/preview shortcuts cannot mutate the old review or invoke browser Save Page. Open, Help, Cancel, and a replacement file drop remain usable. Progress messages and aria-busy follow the job; focus restoration follows section 8, including completion while Help is open. |
| L06 | A timeout follows the same preservation path and displays `IMPORT_TIMEOUT`. Test with a controlled pending decoder/frame load and the Playwright clock, not a slow network. Rejecting a wrongly typed/oversized second file does not interrupt a valid pending job. |
| X01 | Harmless source sentinels in bootstrap, template scripts, event handlers, and JavaScript links cannot set a value in the app, frame, or parent; cannot navigate; and cannot submit a form. Test import, preview, direct annotated reopen, and direct revised reopen. |
| X02 | External probes in img, CSS, SVG, iframe, object, link, media, form, and base-relative URLs make zero external requests during parse, preparation, display, preview, and reopen. Bundle cases reject or sanitize according to their stated rule; ordinary HTML resources remain blocked. |
| X03 | Assertions on every review/candidate/preview frame confirm the sandbox lacks allow-scripts and the CSP still disallows script/network execution. No transient frame with executable source content is created. |
| X04 | A hostile manifest key, mapping ID, or JSON property cannot change Object.prototype or application configuration. Invalid UUID keys fail before resource processing. |

Use `addInitScript` wrappers around browser file/decompression operations and the browser test clock to make races deterministic. Release deferred operations explicitly in the test. Do not add timing backdoors to production code.

### Performance tests

`large-document` contains 250 headings, 400 paragraphs, 320 image elements referencing 320 unique generated PNG assets, 320 captions, 20 table cells, and the public font. Use seeded pseudorandom RGBA data in 128 × 96 pixel PNGs to produce a total input between 16 and 24 MiB while staying below every import/pixel limit. Give the paragraphs a synthetic `min-height: 180px` so total height exceeds 100,000 CSS pixels at the desktop viewport. Generate it in memory at test start.

| ID | Required result |
| --- | --- |
| P01 | In Chromium, full large-document import and asset validation completes within the 30-second production timeout. All expected text and assets survive. Record conversion, staging, and total wall time separately. |
| P02 | With 100 comments and 20 pending replacements on distinct passages, initial preview and a single decision update each settle within 5 seconds on the documented local reference machine. Report these measurements; repeat once if a threshold fails and record both runs. They are local performance acceptance criteria, not timing assertions in the default cross-browser suite. |
| P03 | Open/close preview ten times, switch documents ten times, and cancel five imports. At quiescence there are exactly two permanent review frames, zero candidate frames, and no outstanding importer readers/timers. Chromium DOM counters after forced test-only garbage collection must not show accumulation of one complete document per iteration. Report memory before/after; do not claim JS heap alone measures image memory. |
| P04 | During decompression, the import Cancel action is handled within 500 ms on the local reference machine. Record main-thread long tasks. A cancellation test must use enough assets to cover the yielding path. |

Record browser version, OS, CPU, and available memory with performance results. If the reference-machine timing gate fails, optimize the implementation or report it as incomplete; do not quietly increase thresholds or remove images from the fixture.

## 12. Test-data hygiene

All automated acceptance tests use the generated synthetic fixtures described above. Test results must not depend on an external document, filename, path, or content-derived signature. Keep generated downloads and browser artifacts in ignored test-output directories and clean temporary directories owned by a test after it finishes.

## 13. Implementation order and completion gates

Follow this order:

1. Create the synthetic legacy review with the current app; add the test harness and public/synthetic fixtures. Establish existing happy-path behavior.
2. Implement detection, schema/limit enforcement, cancellation-aware asset decoding, and resource rewriting. Run the importer-level portions of I01–I11 and isolation tests; UI assertions wait for integration.
3. Implement structural normalization and the static layout contract. Verify the converted fixture structure through the importer helper.
4. Integrate transactional staging/commit, progress, cancellation, error mapping, and keyboard/busy behavior. Complete the full I01–I11, V01–V07, L01–L06, and X01–X04 suites.
5. Preserve serialization/layout styles and validate download size. Complete A01–A10 and S01–S06, fixing affected reviewer behavior where required by these contracts.
6. Run all three browser projects and the loopback smoke test; then run P01–P04.
7. Update Help and `docs/testing.md`; inspect the final diff and tracked files for unintended input data and generated artifacts.

Setup and validation commands are:

```sh
npm ci
npx playwright install --with-deps chromium firefox webkit
npm test
npm run test:performance
```

The implementation is complete when all required synthetic functional tests pass in Chromium and Firefox, applicable WebKit tests pass with the documented interaction skips and expected-failure probe; defined local performance gates pass; file-based and loopback operation work; saved copies reopen independently; and repository privacy checks pass.

Playwright WebKit is partial engine coverage, not Safari product support. Safari review support remains unsupported until the sandbox event limitation is resolved. Before adding Safari product support, restore and pass the skipped interaction tests and run the following manual release smoke on current macOS Safari and record version/result in `docs/testing.md`: open `index.html` from disk, import the synthetic document bundle, add/preview/accept a suggestion, save and directly reopen both output types offline, and check print preview for visible first/last content and the defined non-repeating header/footer. If a Safari machine is unavailable, explicitly mark that product check unverified; do not block completion of the specified automated implementation or claim it passed.

The final coding report must list changed files, executed checks and results, any unverified platform checks. Report failures honestly. Do not describe a prototype or partially passing test suite as complete.
