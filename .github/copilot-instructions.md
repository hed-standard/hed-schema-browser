# hed-schema-browser — Copilot instructions

Guidance for GitHub Copilot when working in this repository.

## What this repo is

A static, single-page web app for browsing HED (Hierarchical Event Descriptors)
schemas — the standard schema and the HED library schemas. **No build step, no
bundler, no package manager.** It is served exactly as the files appear in the
repo and is deployed to GitHub Pages.

Live site: https://www.hedtags.org/hed-schema-browser/

- **Stack:** plain HTML, CSS, and ES5-ish JavaScript with jQuery 3.3.1 and
  Bootstrap 4.4.1. These libraries are **vendored locally** under `vendor/`
  (no CDN dependency at runtime).
- **Data:** all schema data is fetched at runtime from
  `raw.githubusercontent.com` (the
  [hed-standard/hed-schemas](https://github.com/hed-standard/hed-schemas) repo).
  Schema discovery reads the `schema_versions.json` manifest at that repo's
  root; the GitHub REST API is not used.
- **No test suite, linter, or build.**

## Key files

| Path | Purpose |
|------|---------|
| `schema-browser.html` | Main page. Reads `?schema=`, `?version=`, `?prerelease=true` from the URL and calls `load()`. |
| `index.html`, `prerelease.html` | Thin redirect stubs to `schema-browser.html`, preserving query params. |
| `source/schema-browser.js` | All interactive logic: schema loading, XML→HTML rendering, the tag tree, search, and the detail panel. |
| `source/hed-collapsible.css` | Tree and layout styling. |
| `vendor/` | Locally vendored jQuery, jQuery-UI, Popper, and Bootstrap. |
| `CLAUDE.md` | Fuller architecture notes — read it for detail before larger changes. |

## Development environment

- Development happens on **Windows with PowerShell** — shell commands should use
  PowerShell syntax (no `&&`; use `;` or separate lines).
- **Run locally over HTTP** — opening `file://` breaks the cross-origin schema
  fetches. Use `python -m http.server 8000`, then open
  `http://localhost:8000/schema-browser.html`.

## Line endings — always LF

**Always write files with Unix LF (`\n`) line endings, never Windows CRLF
(`\r\n`), regardless of the OS.** The repo's `.gitattributes` sets `eol=lf`; a
file saved with CRLF produces a noisy whole-file diff.
- Do **not** write files with Python's text-mode `open(path, 'w')` on Windows —
  it silently converts every `\n` to `\r\n`. Use binary mode or
  `open(path, 'w', newline='\n', encoding='utf-8')`.
- In PowerShell, `Set-Content`/`Out-File` can emit CRLF — prefer the editor's
  file-writing tools, and keep any shell redirection output LF-only.
- After creating or rewriting a file, verify it has no `\r` bytes.

## Conventions

- JavaScript is plain ES5-ish with jQuery — no module system or transpilation.
  Match the surrounding style (the existing `source/schema-browser.js` idioms).
- Working notes/summaries go in the `.status/` directory at the repo root, which
  is git-ignored.
- In markdown titles, capitalize only the first letter of the first word.

## HED background (context only)

HED is a hierarchical, orthogonal vocabulary organized as tag trees; tags use
forward slashes for hierarchy (e.g. `Sensory-event/Visual-presentation`).
Library schemas extend the standard schema with domain-specific vocabulary.
This app only **displays** schemas — it does not validate HED annotations.

## Related resources

- [HED Schemas repository](https://github.com/hed-standard/hed-schemas) — source of all schema XML.
- [HED Resources](https://www.hedtags.org/hed-resources)
- [HED Standard organization](https://github.com/hed-standard)
