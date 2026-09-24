# Testing the HTML reviewer

The distributed application is a single offline `index.html` with no runtime installation. Open it directly from disk in current Chrome/Chromium or Firefox. Development uses deterministic builds to embed the text model, HTML and Markdown workers, and dependency licenses. Changes to `src/roundtrip/` or `src/markdown/` require regenerating `index.html`.

## Setup and commands

Use Node.js 22 or later:

```sh
npm ci
npm run build
npm run check:build
npx playwright install --with-deps chromium firefox webkit
npm test
npm run test:performance
```

Playwright is pinned to 1.57.0 in the lockfile. The build also pins parse5 8.0.0, entities 6.0.1, esbuild 0.28.2, fflate 0.8.3, and micromark 4.0.2. Parser/dependency licenses are retained verbatim in `LICENSES/` and embedded in saved copies. `check:build` runs both read-only artifact checks. The Markdown worker uses the `worker` package-export condition for DOM-free entity decoding. Its browser builds are Chromium 143.0.7499.4 (revision 1200), Firefox 144.0.2 (revision 1497), and WebKit 26.0 (revision 2227). On Linux, use a distribution supported by Playwright's dependency installer or supply the corresponding browser libraries for your distribution. Browser downloads and operating-system libraries are not application dependencies.

Useful focused commands:

```sh
npm run test:chromium
npm run test:roundtrip
npm run test:markdown
npm test -- --project=firefox
npm test -- --project=webkit
npm test -- --grep 'L03|L06'
```

`npm test` runs functional tests in all three engines. Production-size limit cases run only in Chromium; smaller boundary tests run across engines. Performance tests are excluded from the default suite and run separately, with one worker, to keep their measurements meaningful. Run commands sequentially: concurrent Playwright invocations sharing `test-results/` can remove one another's artifacts. Failures retain synthetic screenshots and traces in ignored `test-results/`. Inspect a trace with `npx playwright show-trace <path-to-trace.zip>`.

To save the performance annotations as JSON:

```sh
mkdir -p playwright-report
npm run test:performance -- --reporter=json > playwright-report/performance.json
```

## GitHub Pages deployment

GitHub Pages publishes the committed files from the root of `main`. Keep the empty root `.nojekyll` file: the application is already built, and documentation contains literal template syntax that Jekyll would otherwise interpret. [GitHub documents this static publishing configuration](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site). Markdown documentation remains available as source files on the site and can be read with formatting on GitHub.

Before pushing application changes, run `npm run build` and `npm run check:build` and include the updated `index.html`. After pushing, verify that the `pages-build-deployment` run for the pushed commit completes successfully, including deployment. Confirm that the published `https://ciefa.github.io/` serves the same `index.html` bytes as that commit; local application tests alone do not verify deployment.

## Coverage and browser limitation

The test titles retain the I01–I11, V01–V07, A01–A10, S01–S06, L01–L06, X01–X04, and P01–P04 IDs from [the implementation specification](bundle-import-implementation.md). Additional cases cover corrupt review state, mixed compression, escaped font declarations, pixel limits, UTF-16BE/newlines, exact download boundaries, and cancellation while decoding or awaiting a frame.

Tests exercise the actual inline importer and public review controls. Focused boundary tests extract that importer and substitute uniquely identified constant declarations; production code has no mutable test limits or timing hooks. Deferred browser operations and Playwright's clock make cancellation and timeout tests deterministic. The request guard aborts and fails unexpected external HTTP(S) requests. Persistence tests use fresh offline browser contexts, file URLs, and downloaded annotated/revised copies. A loopback HTTP smoke test verifies served operation too.

**Full review support is Chromium and Firefox. Safari is unsupported for review interactions.** WebKit blocks parent-owned event handlers attached to the script-blocked document frame, matching [WebKit issue 218086](https://bugs.webkit.org/show_bug.cgi?id=218086). This breaks selection handling, shortcuts, and linked scrolling. The application detects that event capability and displays a message directing users to Chrome or Firefox. The frame sandbox and restrictive content security policy remain unchanged.

WebKit still runs importer, resource, rendering, serialization, and applicable lifecycle/isolation tests. Cases that require the blocked event handlers are explicitly skipped by the named fixture in `tests/helpers/reviewer.cjs`. K01 is a small **expected failure** reproducing the upstream defect. If it unexpectedly passes after a browser update, the suite fails: investigate and restore the skipped coverage. These skips and the expected failure are not evidence of Safari support. The shipping macOS Safari application has not been tested.

## Fixtures

`tests/helpers/bundle-fixtures.cjs` generates deterministic synthetic prose, UUIDs, PNGs, SVGs, manifests, and gzip data using Node built-ins. The large fixture is generated in memory and contains 250 headings, 400 paragraphs, 320 unique images and captions, 20 table cells, and the public test font. It has a 16–24 MiB input and over 100,000 CSS pixels of document height.

The only third-party fixture asset is the public Fira Sans font. Its source revision, hashes, and license are in [tests/assets/README.md](../tests/assets/README.md). Do not replace it with an extracted document asset. All other fixture content is newly authored synthetic data.

Generate an inspectable synthetic bundle without checking it in:

```sh
node -e "const fs=require('node:fs');fs.mkdirSync('tests/generated',{recursive:true});fs.writeFileSync('tests/generated/synthetic-bundle.html',require('./tests/helpers/bundle-fixtures.cjs').documentBundle())"
```

`tests/fixtures/legacy-review.html` was created through the pre-importer application at commit `0475ba8`. It contains five synthetic paragraphs with, in order, accepted/open/rejected replacement suggestions and resolved/open plain comments. Keep this fixture as an old-format compatibility artifact. Its expected states and accepted wording are asserted directly; it should not be regenerated by the new application.

## Markdown workspace coverage

The [Markdown workspace specification](markdown-workspace-implementation.md) fixes the multi-document source-review workflow. Open multiple `.md`/`.markdown` files or one Markdown-only ZIP with **Open Markdown / ZIP**. The document list switches independent reviews. The left pane reviews literal source; the right pane is a CommonMark preview with pending replacements. Template calls are inert and images are not loaded. Markdown extensions such as custom callouts are not a complete documentation build.

**Save annotated copy** includes every document and its original source, runs, and comments in one offline HTML file. **Export Markdown ZIP** retains each relative file path and includes all documents with accepted edits. **Export current Markdown** downloads only the active document. Unchanged content, BOMs, and unselected line endings remain byte-identical. ZIP container metadata and empty directories are not preserved. Non-Markdown archive files, unsafe/colliding names, encrypted/ZIP64 archives, and non-UTF-8 sources fail explicitly.

`tests/helpers/markdown-fixtures.cjs` creates synthetic loose files and ZIP records, including deliberately malformed headers. `tests/markdown-archive.spec.cjs` checks archive/source/model contracts; `markdown-workspace.spec.cjs` exercises the public controls and offline persistence; `markdown-lifecycle.spec.cjs` covers worker cleanup, cancellation, failure, timeout, grapheme boundaries, size limits, build determinism, and layout. `markdown-performance.spec.cjs` measures a 40-document workspace and real worker cancellation. These fixtures contain only synthetic content.

## Markdown workspace validation record

Validated 2026-09-21 on Node.js 22.23.1, AMD Ryzen 9 9900X, 31 GiB RAM, Manjaro Linux 6.18.49, using the pinned Playwright browsers above. WebKit compatibility libraries were supplied outside the repository.

The full functional suites completed with zero unexpected failures:

| Engine | Functional passes | Skipped | Expected failures |
| --- | ---: | ---: | ---: |
| Chromium | 217 | 0 | 0 |
| Firefox | 211 | 6 | 0 |
| WebKit | 157 | 59 | 1 |
| Total | 585 | 65 | 1 |

Commands were `npm test -- --project=chromium --project=firefox` and `npm test -- --project=webkit`. Playwright includes K01's expected WebKit failure in its passed count (586 across these runs). Firefox skips production-size cases and the cross-engine case exercised from Chromium. WebKit additionally skips review interactions blocked by the unchanged sandbox limitation.

After final UI/lifecycle refinements, `npm run test:markdown -- --output=/tmp/html-reviewer-md-final-results` passed **131 checks with 7 documented skips** across all engines. The new feature contributes 46 functional cases per engine. Visual inspection of a synthetic workspace verified source/preview layout; an automated pane-height assertion guards the document-list grid layout.

`npm run test:performance -- --reporter=list,json` passed **all 8 checks** in approximately 190 seconds, without relaxing thresholds:

| Measurement | Result |
| --- | --- |
| MD-P01 40 documents × 32 KiB | Import 147 ms; document switch 99 ms; ZIP export 192 ms; real worker cancellation 37 ms. |
| P01 existing large HTML import | 3,784 ms total; conversion 801 ms; staging 213 ms. |
| P02 existing 100-comment preview | Initial preview 1,075 ms; decision update 2,668 ms. |
| P03 retained documents | 3 before and after repeated cycles. |
| P04 decompression cancellation | 23 ms. |
| RT-P01 original-format workflow | Import 3,764 ms; cached export 2,641 ms; reattach/export 6,421 ms; preview 1,068 ms; decision 2,638 ms. |
| RT-P02 ten complete cycles | 3 retained documents, zero remaining workers/URLs/candidates, peak 1 worker; combined used heap/backing-storage increase 347,830 bytes, below 32 MiB. |
| RT-P03 worker cancellation | 15 ms. |

`npm run build`, `npm run check:build`, and `git diff --check` passed. Both artifact generators and their bundled notices are reproducible. Dependency installation audited 37 packages with zero reported vulnerabilities at validation time. These measurements describe the reference machine, not a performance guarantee for other devices.

## Markdown indentation coverage

The [Markdown indentation specification](markdown-indentation-implementation.md) makes restructuring source, such as nesting list items, practical in the replacement field. `tests/markdown-indentation.spec.cjs` covers MI01–MI04: the pure `indentLines` line and selection rules (all engines); Tab/Shift+Tab indentation, native undo, the Esc-then-Tab focus release, and preview/export of a nested list; the monospace, auto-growing Markdown replacement field; and unchanged Tab, font, and hint behavior in HTML reviews. The interactive cases skip WebKit for the documented sandbox limitation.

## Markdown indentation validation record

Validated 2026-09-23 on Node.js 26.10.0, Intel Core Ultra 5 235U, 31 GiB RAM, Arch Linux 7.2.4, using the pinned Playwright browser builds listed above.

Environment deviations: Playwright's installer downloaded each pinned browser archive but stalled while extracting it on this host, so the same archives were unpacked into `PLAYWRIGHT_BROWSERS_PATH` with Playwright's completion marker. WebKit's Ubuntu 24.04 libraries (libicu74, libxml2 2.9.14, libvpx9, libflite1) were supplied outside the repository by extracting the Ubuntu noble packages into the WebKit bundle's `sys/lib` fallback folder.

| Command | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| `npx playwright test tests/markdown-indentation.spec.cjs` | 4 passed | 4 passed | 1 passed, 3 skipped |
| `npm run test:markdown` | 50 passed | 48 passed, 1 skipped, 1 failed | 41 passed, 9 skipped |
| `npm test` (run as `--project=chromium --project=firefox`, then `--project=webkit`) | 221 passed | 214 passed, 6 skipped, 1 failed | 158 passed, 62 skipped, 1 expected failure (K01) |

Playwright's summaries were 139 passed / 10 skipped / 1 failed for `test:markdown`, 435 passed / 6 skipped / 1 failed for Chromium and Firefox, and 159 passed (including K01) / 62 skipped for WebKit. `npm run build`, `npm run check:build`, and `git diff --check` passed. Regeneration changed only the Markdown core bundle functionally; the worker bundle differs by one renamed minified identifier, and `LICENSES/markdown-dependencies.txt` is unchanged.

Both Firefox failures are `MD17 preview timeout and worker failure preserve editable source`, which is intermittent on this machine independent of this change. Running `tests/markdown-lifecycle.spec.cjs` alone in Firefox failed it in 2 of 3 runs with this change and 1 of 3 runs on an unmodified export of baseline `e84875c`; run by itself it passed 8 of 8 repeats. Its instrumentation shortens every 10,000 ms and 30,000 ms timer to 80 ms, which also shortens the 30-second `IMPORT_TIMEOUT_MS`. An inspected failure snapshot shows the import abandoned with no document open, consistent with Firefox exceeding that 80 ms import deadline. The test was left unchanged.

## Original-format export coverage

The RT01–RT35 cases in [the original-format export specification](bundle-roundtrip-implementation.md) are covered by `tests/roundtrip-*.spec.cjs`. They exercise the shipped model and worker, real converter projections, public export controls, byte comparisons, and an independently authored executable bundle. Tests cover accepted-only exports, retained edits after annotation removal, repeated/duplicate text, empty ownership boundaries, inline formatting, moved slots, entities and Unicode, CR/preformatted newlines, source reattachment, tampered projections, v1 compatibility, cross-engine offline reopening, isolation, cancellation, and fixed limits.

`tests/helpers/roundtrip-build.cjs` substitutes named source constants through esbuild plugins. Boundary tests use the actual compiled modules at one below, equal to, and one above their limits; the application exposes no mutable test configuration. Full-size unit/node/depth/attribute cases run in Chromium. Model, worker, and noninteraction export tests run in all three engines. New tests requiring document-frame events have explicit WebKit skips, alongside the existing K01 expected failure.

The worker transport uses transferable byte buffers. A WebKit local-file worker cannot read even its own Blob (`NotReadableError`), so Blob reads/download construction stay in the parent; parsing, hashing, and bounded byte assembly remain in the worker. This does not change the frame sandbox or Safari review-interaction limitation. Literal CR uses `&#13;`; the parser permits only the specific character-reference diagnostic for that exact sequence, and static/review serialization preserves it too.

The new performance fixture retains 80 accepted and 20 pending annotations, plus 20 accepted edits whose annotations were removed: 100 active annotations and 100 changed source units. Gates are 10 seconds for fresh import and cached export, 15 seconds for source reattachment plus export, 5 seconds for preview/decision updates, and 500 ms for worker cancellation. Ten complete large-document cycles must release workers and object URLs, retain exactly two permanent frames, avoid document growth after garbage collection, and retain less than 32 MiB additional main-thread JavaScript heap. Peak heap and long tasks are diagnostics, not portable whole-browser memory guarantees.

## Original-format implementation validation

Validation date: 2026-09-16, on the same reference machine and browser builds listed below, with Node.js 22.23.2. `npm ci`, generation, reproducibility checks, and `git diff --check` succeeded.

The final functional run took approximately 4.4 minutes with zero unexpected failures:

| Engine | Passed | Skipped | Expected failures |
| --- | ---: | ---: | ---: |
| Chromium | 171 | 0 | 0 |
| Firefox | 166 | 5 | 0 |
| WebKit | 117 | 53 | 1 |
| Total | 454 | 58 | 1 |

Playwright reports `455 passed` because that summary includes K01's expected failure. There are 60 new functional test cases, expanded across the engine projects. Firefox skips four production-size cases and the cross-engine transfer case, which runs once from Chromium and launches fresh offline Firefox/Chromium contexts. WebKit skips those production cases plus tests requiring its blocked document-frame listeners. It runs the model, worker, parser, resource, byte-preservation, and applicable lifecycle/export tests.

All seven performance checks passed in approximately 3.2 minutes. The fixture remained 18,314,105 bytes with 320 embedded images and the public font.

| Check | Final result |
| --- | --- |
| Existing P01 complete import | 4,811 ms; conversion 794 ms and staging 211 ms measured separately. |
| Existing P02 preview / decision | 1,120 / 2,804 ms, below 5,000 ms. |
| Existing P03 retained documents | 3 before and after; two permanent frames, no candidate. |
| Existing P04 decompression cancellation | 28 ms; longest observed import task 765 ms. |
| RT-P01 v2 import | 3,772 ms, below 10,000 ms. |
| RT-P01 cached original-format export | 2,718 ms, below 10,000 ms. |
| RT-P01 source reattachment plus export | 6,530 ms, below 15,000 ms. |
| RT-P01 preview / decision | 1,127 / 2,841 ms, below 5,000 ms. |
| RT-P02 ten large-document cycles | 3 documents before/after; two permanent frames; zero remaining workers, worker/download URLs, or candidates. Peak concurrent workers: 1. |
| RT-P02 memory diagnostics | Used JS heap 21,641,420 → 3,719,540 bytes; backing storage 303,333 → 18,568,104 bytes. Their combined increase was 342,891 bytes, below 32 MiB. Sampled peak used JS heap: 41,990,620 bytes. |
| RT-P02 responsiveness diagnostics | 32 long tasks; maximum 765 ms. |
| RT-P03 worker-active cancellation | 16 ms, below 500 ms. |

An additional focused Chromium/Firefox run passed the literal-CR acceptance, preview, save/reopen, static export, and restored-file reimport assertions; WebKit retained its explicit interaction skip. Parser/build notices match their pinned upstream license files verbatim. All fixtures use synthetic prose and public assets.

## Previous validation record

Validation date: 2026-09-16. Reference machine: AMD Ryzen 9 9900X, approximately 31 GiB total RAM, Manjaro Linux 6.18.49-1-MANJARO, Node.js 22.23.2. The Playwright browsers listed above were used. WebKit's required compatibility libraries were provided outside the repository.

The final functional run completed in approximately 145 seconds with **zero unexpected failures**:

| Engine | Passed | Skipped | Expected failures |
| --- | ---: | ---: | ---: |
| Chromium | 111 | 0 | 0 |
| Firefox | 108 | 3 | 0 |
| WebKit | 81 | 29 | 1 |
| Total | 300 | 32 | 1 |

Firefox's three skips are the production-size limit cases assigned to Chromium. WebKit skips those three cases and 26 cases requiring sandboxed event handlers. Its expected failure is K01, the explicit upstream compatibility probe. Playwright counts that expected failure in its `301 passed` summary; it is separated here to avoid presenting it as working review functionality.

All four performance checks passed on this machine, with approximately 23–24 GiB of available RAM:

| Check | Result |
| --- | --- |
| P01 input | 18,314,105 bytes (17.47 MiB), all 320 images decoded and all expected content retained. |
| P01 conversion / staging / total import | 793 ms / 208 ms / 2,806 ms. |
| P02 initial preview / decision update | 978 ms / 2,464 ms, both below 5,000 ms. |
| P03 retained documents | 3 before and 3 after; exactly two permanent iframes and no candidate. DOM nodes: 3,237 → 3,299; listeners: 60 → 80. |
| P04 cancellation | 24 ms during decompression, below 500 ms. One 768 ms main-thread long task was observed during import. |

The first P02 measurement included bringing an off-screen Accept button into view: initial preview 994 ms and decision action 5,054 ms. A repeat measured 988 ms and 5,032 ms. Instrumentation then separated the time before the actual click from preview loading. The benchmark now makes the button visible/actionable before starting the decision timer; this preparatory navigation is recorded separately (977 ms in the passing run). The final click call took 46 ms. Neither the 5-second threshold nor the document/comment counts were reduced.

The performance report records conversion separately from total import; staging is measured from candidate insertion to commit. Conversion is a separate measurement and is not added to the measured total. P02 measures initial preview and one decision with 100 comments and 20 pending suggestions, after positioning the decision control. P03 uses Chromium DOM counters after test-only garbage collection to detect accumulated documents; those counters do not measure all browser image memory. P04 measures cancellation during real multi-asset decompression and records main-thread long tasks. These timings describe this local reference machine, not a guarantee for every device.
