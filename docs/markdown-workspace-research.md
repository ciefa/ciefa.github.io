# Multi-document Markdown review: research

Date: 2026-09-21. Application baseline: `965be6fb94dacf32920ad5a9e7d8247da17499b7`.

## Conclusion

A local Markdown workspace can retain multiple independent documents and export each document under its original relative path. Use a ZIP as transport, not as a merged document. The existing reviewer already supplies annotation decisions, durable text runs, offline saved copies, sandboxed frames, and cancellable worker operations. Extend these components with a separate workspace format.

The normative decisions and acceptance criteria are in [the implementation specification](markdown-workspace-implementation.md). This report uses synthetic examples exclusively.

## Rendering and source fidelity

Markdown source and its rendered text are different coordinate systems. Formatting delimiters, escapes, character references, indentation, and generated template output prevent a general character-for-character correspondence. Parser positions alone do not resolve selections inside decoded text. A rendered editing implementation would require a new mapping layer plus explicit rules for structural edits. The [mdast parser](https://github.com/syntax-tree/mdast-util-from-markdown) exposes syntax trees with positions and extension hooks; it is a candidate for a future rendered-editing mode, not a complete source-preserving editor.

For this release, review the literal Markdown source in a wrapping monospace pane and show a separate formatted preview with pending suggestions applied. Reuse annotation-owned runs over one immutable source unit per file. Suggestions are literal source replacements, including Markdown syntax. This avoids guessing which source produced a rendered label. It also handles custom templates without executing their code. Existing source line endings remain in unchanged runs; newly typed newlines use the document's first original newline convention.

Use pinned `micromark` 4.0.2 for preview. Its default HTML handling escapes raw HTML and disallows dangerous protocols. Keep both dangerous options false, strip image loads, disable navigation, and preserve the existing sandbox/CSP. Template expressions are displayed literally rather than expanded. The preview is a CommonMark approximation, not a project build. [micromark documentation](https://github.com/micromark/micromark#security)

## Archive behavior

The [ZIP specification](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) defines a central directory, local headers, compression methods, optional descriptors, filename encodings, and CRC-32. A ZIP decoder alone does not establish application policies for duplicate paths, traversal, unsupported entry types, or resource consumption. Validate this directory before decompressing and verify actual output sizes and checksums afterward.

Use pinned `fflate` 0.8.3 in a dedicated worker: incremental DEFLATE for bounded import, and ZIP generation for export. Its API supports browser operation, explicit paths, Unicode names, and fixed timestamps. Avoid converting an unvalidated archive directly to a filename-keyed object, since duplicate names can be lost. [fflate documentation](https://github.com/101arrowz/fflate#usage)

Preserve file contents and relative filenames, not the ZIP container bytes, entry order, permissions, timestamps, or empty directory records. Export all workspace documents, including unchanged ones. A Markdown-only archive contract makes omissions explicit: unsupported non-Markdown entries fail import rather than silently disappearing from export.

## Alternatives resolved

| Option | Decision |
| --- | --- |
| Merge all Markdown into one source file | Reject: destroys independent file identity and complicates export. |
| One review per browser tab | Reject as the primary workflow: there is no single save/export for the collection. |
| Convert HTML edits back to Markdown | Reject: generated text need not have a unique source location. |
| Source review plus formatted preview | Select: literal edits, existing review controls, reliable source export. |
| Inline annotations in clean Markdown | Reject: comments and pending suggestions belong to the saved review. |
| Store every original source in the saved workspace | Select: these bounded text sources allow fully offline reopen and export without reattachment. |
| Native directory handles | Defer: ZIP and multi-file selection need no persistent filesystem permissions. |
| Reproduce custom documentation builds | Defer: requires producer-specific code, configuration, assets, and source mappings. |

## Verification required

Test independent annotation ownership for identical text in different files, stable file paths, byte-identical unchanged sources, original newline/BOM preservation, and accepted edits surviving comment removal and reopen. Exercise duplicate and unsafe archive names, corruption, decompression limits, cancellation, and transactional failure. Test saved copies offline in Chromium and Firefox. Retain the existing documented WebKit interaction limitation. Specific test IDs, bounds, module contracts, and delivery gates are fixed in the specification.
