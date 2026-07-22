# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Static single-page browser for HED (Hierarchical Event Descriptors) vocabularies. No build step. No package manager. Schema discovery and all schema XML are fetched at runtime from `raw.githubusercontent.com` (the `hed-standard/hed-schemas` repo). The GitHub REST API is **no longer used** — discovery goes through the `schema_versions.json` manifest at the repo root (see "Schema discovery via manifest").

Live site: https://www.hedtags.org/hed-schema-browser/

Deployment: pushing to `main` publishes the site via GitHub Pages (configured in repository settings to deploy from the `main` branch root). No Actions deploy workflow exists.

## Line endings (always LF)

**Always write files with Unix LF (`\n`) line endings — never Windows CRLF (`\r\n`) — regardless of the OS.** This repo is developed on Windows, but `.gitattributes` sets `eol=lf`, so a file saved with CRLF produces a whole-file noisy diff. In particular, **do not write files with Python's text-mode `open(path, 'w')` on Windows** — it silently converts every `\n` to `\r\n` (this once flipped `source/schema-browser.js` to CRLF). If you must write from Python, use binary mode or `open(path, 'w', newline='\n', encoding='utf-8')`; in PowerShell, beware `Set-Content`/`Out-File` emitting CRLF. Prefer the Edit/Write tools (they write LF), keep any shell redirections LF-only, and after writing a file confirm it has no `\r` bytes (`grep -lU $'\r' <file>` prints nothing).

## Running locally

Must be served over HTTP — opening the HTML directly as `file://` breaks CORS (blocks the `raw.githubusercontent.com` fetches) and XSLT loading.

```bash
python -m http.server 8000
# then open http://localhost:8000/schema-browser.html
```

Or `npx serve .`, or the VS Code Live Server extension.

**No more API rate limit**: the browser fetches from `raw.githubusercontent.com` (Fastly-backed, effectively unmetered), not the GitHub REST API (which was 60 req/hr per IP). If the schema list is blank now, it's a manifest fetch failure (network / bad `schema_versions.json`), not a rate limit — check the console.

There is no test suite, no linter, and no build.

## Architecture

Three HTML entry points, all converging on `schema-browser.html`:

| File | Behavior |
|------|----------|
| `index.html` | Redirects to `schema-browser.html`, preserving the query string |
| `prerelease.html` | Redirects to `schema-browser.html?prerelease=true`, preserving other params |
| `schema-browser.html` | Main page. Reads `?prerelease=true` and `?schema=<name>` from URL and calls `load()` |

`index.html` and `prerelease.html` are deliberately thin redirect stubs — `schema-browser.html` is the single source of truth for all markup and behavior. They used to be near-identical full copies of the page (differing only in the `load()` call), which was consolidated to avoid maintaining two copies. Both stubs forward `window.location.search` so links like `index.html?schema=score` still land on the right schema; `prerelease.html` merges `prerelease=true` into whatever params it received.

All logic lives in **`source/schema-browser.js`** — plain ES5-ish JS with jQuery 3.3.1 and Bootstrap 4.4.1, loaded from CDNs. No module system.

### Schema loading pipeline

`load(schemaName)` is the entry point invoked from `schema-browser.html`. It:
1. Reads URL params (`?schema=`, `?version=`, `?prerelease=true`) — these override the argument.
2. `await`s `loadSchemaManifest()` once, up front, so the whole page has the manifest cached before anything else runs.
3. Populates the **Schema** dropdown via `getLibarySchemas()`, which now reads library names from the cached manifest (still a synchronous function, so it works from a non-async caller — but it depends on the manifest already being loaded in step 2).
4. Kicks off the initial schema load via `loadDefaultSchema(name)` (release, falling back to prerelease if the schema has no released version) or `loadPrereleaseSchema(name)` (always loads the prerelease XML).

`loadSchema(schemaName, url)` is the single choke point that actually fetches an XML file, transforms it, and updates the UI. Both `loadDefaultSchema` and `loadPrereleaseSchema` end up calling it. It also sets `currentSchemaName` (the module-global that tracks *what the user is currently viewing*, including a `_prerelease` suffix when applicable) and updates both dropdown-button labels + the prerelease toggle button state.

**Why `load()` is async**: this bit hard once. The prerelease URL lookup was made `async` while `load()` was still synchronous and didn't `await` it, so `loadSchema()` received a `Promise` instead of a URL string. It failed silently at `url.match(re)`, and prerelease-only schemas (like `mouse`) fell through to a non-existent `HED_mouse_Latest.xml`, producing 404s and a blank page. The fix was to make `load()` and the whole prerelease path `async`/`await` end-to-end. Keep it that way: any network result must be `await`ed before it reaches `loadSchema()`.

### Schema discovery via manifest

The `hed-standard/hed-schemas` repo publishes **`schema_versions.json`** at its root, regenerated whenever the schemas change. The browser fetches this once from `raw.githubusercontent.com` (`loadSchemaManifest()`, cached in the `schema_manifest` global) and derives all schema/version/download info from it — no REST API calls.

Manifest shape: `libraries` is keyed by schema name, with the **standard schema keyed by the empty string `""`** (the browser uses `"standard"` internally — `getManifestEntry()` maps between them). Each entry has `released`, `prerelease`, and `deprecated` arrays of `{date, file, sha, version}`. `file` is a repo-relative path; `manifestFileUrl()` prepends the raw-CDN base to produce a download URL identical to what the REST API's `download_url` used to return, so `loadSchema()` and the rendering pipeline are unchanged.

Helper roles:
- `getLibarySchemas()` → library names from `Object.keys(manifest.libraries)` minus `""`.
- `getGithubSchema(name)` → `{version, download_link, isDeprecated}` (released then deprecated). Same shape it used to build from the API, so `buildSchemaVersionDropdown` / `findLatestVersion` / `loadDefaultSchema` are untouched. Version labels are kept in the old `HED8.4.0` / `HED_lang_1.1.0` filename form (`versionLabelFromFile()`) so the version-compare/sort code still parses them.
- `getSchemaURL(name, version)` → manifest lookup (released → deprecated → prerelease), `""` if absent.
- `getPrereleaseUrl(name)` → raw-CDN URL of the highest-version prerelease (replaced the old `getPrereleaseXml()`).
- `checkSchemaVersionExists(name, isPre)` → checks the length of the manifest's `prerelease` / `released` array.

### Prerelease naming convention

Prerelease schemas are tracked by suffixing the base name: **`mouse`** = release view of the mouse library schema; **`mouse_prerelease`** = prerelease view. This suffix appears in:
- `currentSchemaName`
- URL param `?schema=mouse_prerelease`
- The internal string passed to `loadSchema()`

`setDropdownBtnText()` strips the suffix and formats it as `"mouse (prerelease)"` for display. Any new code that reasons about the "base" schema name should call `.replace('_prerelease', '')`.

### XML → HTML rendering

Schema XML files come in two formats. `useNewFormat` (global) selects between them, based on the first digit of the version number in the URL:
- **New format** (>= 8.x): `transformNewFormat()` → `renderSchemaTree()` etc. Attributes are child `<attribute>` elements.
- **Old format** (< 8.x): `transformOldFormat()` → `renderSchemaNodeOld()`. Attributes are XML attributes on the node.

Both branches produce structurally identical HTML that the rest of the code (search, hover info, library-tag coloring) consumes without caring which format was used. This replaced the original `hed-schema.xsl` / `hed-schema-old.xsl` XSLT pipeline; the `.xsl` files are still in the repo but are dead code.

`xslTranslate()` reproduces a specific `translate()` chain from the old XSLT to build CSS-safe IDs. **Do not** run the leaf-tag `tag=` attribute through it — that attribute is used as a jQuery selector key and must match the raw `name` used by `renderAttrDivs()`. This bit the codebase before (GitHub issue #11) with digit-containing tag names in the test library. See the comment in `renderSchemaNode()`.

### Library-tag detection (`inLibrary`)

`parseMergedSchema()` runs after each `loadSchema()`. It scans hidden `.attribute` divs for the `inLibrary` marker, adds the `inLibrary` class to those `<a>` nodes, propagates a `hasInLibrary` class up the ancestors, and colors them brown. The "Show library only" button uses `hasInLibrary` to filter which nodes stay visible.

### Version dropdown ordering

`buildSchemaVersionDropdown()` sorts by semantic version *descending* using `compareSemanticVersions()`. There's a token-based guard (`buildSchemaVersionDropdownToken`) that discards stale async results if the user switches schemas mid-fetch — preserve this if you touch the dropdown code.

## Common gotchas

- **The manifest must be loaded first**: `getLibarySchemas()` is synchronous and reads the cached `schema_manifest`. It only works because `load()` `await`s `loadSchemaManifest()` before calling it. The manifest-reading helpers that stayed `async` (`getGithubSchema`, `checkSchemaVersionExists`, `loadPrereleaseSchema`) each `await loadSchemaManifest()` themselves (a no-op once cached), so they're safe from any caller — but still `await` them, since passing an unawaited Promise into `loadSchema()` fails silently at `url.match(re)`.
- **Prerelease-only schemas** (like `mouse`) have an empty `released` array in the manifest (only `prerelease` is populated). `loadDefaultSchema` handles this: if no release version is found, it checks for prerelease and loads that. Don't add a `HED_<name>_Latest.xml` fallback — that file doesn't exist and will 404.
- **Don't reintroduce the REST API**: discovery is manifest-only now. There's no directory-listing call to fail, no `getPrereleaseXml`, and no deprecated-folder 404 to swallow — a schema simply has whatever `released`/`prerelease`/`deprecated` entries the manifest lists.
- **`currentSchemaName` drives the toggle button**: the "View prerelease/released schema" button's label and enabled/disabled state depend on `currentSchemaName`, not on URL params. Whenever a new schema is loaded, `updatePrereleaseToggleUI()` must be called (it already is, from `loadSchema()`).

## References

- `source/README.md` — user-facing "how does this work" doc; kept in sync with reality but written for humans.
