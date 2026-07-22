# HED Schema Browser

Interactive, browser-based viewer for HED (Hierarchical Event Descriptors) vocabularies.

[![Test](https://github.com/hed-standard/hed-schema-browser/actions/workflows/test.yml/badge.svg)](https://github.com/hed-standard/hed-schema-browser/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

The HED Schema Browser is a static, single-page web application for exploring the
HED standard schema and the HED library schemas. It renders each schema as a
collapsible tree of tags, lets you search and inspect individual tags, switch
between released and prerelease versions, and view unit, value, and attribute
definitions. At startup, the browser fetches a manifest (`schema_versions.json`)
from the [hed-standard/hed-schemas](https://github.com/hed-standard/hed-schemas)
repository listing all available schemas and versions, then loads requested XML
files on demand. This ensures the browser always reflects the current published
schemas without needing to bundle any data.

## Live site

The browser is deployed to GitHub Pages and is available at:

**https://www.hedtags.org/hed-schema-browser/**

Useful URL parameters (all optional):

| Parameter | Example | Effect |
|-----------|---------|--------|
| `schema` | `?schema=score` | Select a specific library schema on load. |
| `version` | `?version=8.3.0` | Select a specific schema version on load. |
| `prerelease` | `?prerelease=true` | Show the prerelease view of the selected schema. |

Parameters can be combined, for example
`https://www.hedtags.org/hed-schema-browser/?schema=score&prerelease=true`.

## Features

- Browse the HED standard schema and all HED library schemas (for example
  `score`, `lang`, `testlib`).
- Collapsible tree navigation with per-level expand and collapse controls.
- Search for tags with autocomplete, including an option to search deprecated
  tags.
- Detailed information panel that updates as you hover over a tag, showing its
  full path, description, and attributes. Press Enter/Return to freeze or
  unfreeze the panel so you can copy from it.
- Version switching, including released versions, deprecated versions, and
  prereleases.
- "Show library only" filter that highlights and isolates the tags contributed
  by a library schema on top of the standard schema.
- Display of additional schema properties: unit class, unit modifier, value
  class, schema attribute, and property definitions.
- Synonym and attribute lookup for individual tags.
- Responsive layout built on Bootstrap 4.

## Repository layout

| Path | Description |
|------|-------------|
| `schema-browser.html` | Main page. Reads `?schema=`, `?version=`, and `?prerelease=true` from the URL and calls `load()`. |
| `index.html` | Redirects to `schema-browser.html`, preserving query parameters. |
| `prerelease.html` | Redirects to `schema-browser.html?prerelease=true`, preserving query parameters. |
| `source/schema-browser.js` | All interactive logic (schema loading, XML-to-HTML rendering, search, info board, filtering). |
| `source/hed-collapsible.css` | Styling for the collapsible tree. |
| `source/hed-schema.xsl`, `source/hed-schema-old.xsl` | Legacy XSLT stylesheets. Retained for reference; no longer used at runtime (rendering is now done in JavaScript). |
| `source/README.md` | Developer reference describing the internals in more depth. |
| `.github/workflows/test.yml` | GitHub Actions workflow that runs link checking and HTML validation on push and pull request. |
| `LICENSE` | MIT license. |

There is no build step, no bundler, and no package manager. The site is served
exactly as the files appear in the repository.

## Running locally

The browser must be served over HTTP. Opening the HTML file directly from disk
as a `file://` URL will not work: the browser's cross-origin (CORS) rules block
the remote schema fetches (manifest and XML files from `raw.githubusercontent.com`),
and relative asset loading breaks. Use one of the local servers below instead.

### Option 1: Python (recommended, no extra install)

Python 3 ships with a built-in static file server, which is the simplest way to
run the browser locally.

1. Open a terminal in the root of this repository (the directory that contains
   `schema-browser.html`).
2. Start the server:

   ```bash
   python -m http.server 8000
   ```

   On some systems the command is `python3`:

   ```bash
   python3 -m http.server 8000
   ```

   To bind a different port, replace `8000` with any free port number.

3. Open the following URL in your browser:

   ```
   http://localhost:8000/schema-browser.html
   ```

4. Stop the server with `Ctrl+C` when you are finished.

### Option 2: Node.js

If you have Node.js installed, you can serve the directory without a global
install:

```bash
npx serve .
```

Then open the URL printed in the terminal, for example
`http://localhost:3000/schema-browser.html`.

### Option 3: VS Code Live Server

1. Install the
   [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer)
   extension.
2. Right-click `schema-browser.html` in the Explorer and choose
   **Open with Live Server**. The page opens automatically (typically at
   `http://127.0.0.1:5500/schema-browser.html`; the port may vary).

### Schema discovery and availability

The browser fetches the schema list and all XML files from
`raw.githubusercontent.com` (Fastly-backed CDN), which has no per-IP rate
limits. Schema discovery works by fetching `schema_versions.json` from the
[hed-standard/hed-schemas](https://github.com/hed-standard/hed-schemas)
repository at startup; if this manifest fetch fails, the schema list will be
blank. Troubleshooting: check your network connection and browser console for
error messages. If the manifest fails repeatedly, verify that
`raw.githubusercontent.com` is accessible.

## How it works

At a high level:

1. `load()` in `source/schema-browser.js` reads the URL parameters and populates
   the **Schema** dropdown by fetching `schema_versions.json` from
   `raw.githubusercontent.com`. This manifest lists all available standard and
   library schemas together with their released, prerelease, and deprecated
   versions.
2. Selecting a schema (or loading the default) triggers `loadSchema()`, the
   single point that fetches an XML schema file from
   `raw.githubusercontent.com`, transforms it into HTML, and injects it into the
   page.
3. Two XML formats are supported. Schemas at version 8.x and above use the newer
   format (attributes are child elements); older schemas use the previous format
   (attributes are XML attributes). Both are rendered to structurally identical
   HTML so that search, hover, and filtering work the same way regardless of the
   source format.
4. Library-schema tags are detected and highlighted so the "Show library only"
   filter can isolate them from the standard-schema tags.

### Prerelease convention

Prerelease views are tracked by suffixing the base schema name with
`_prerelease` (for example `score_prerelease`). This suffix appears in the
internal schema name, in the `?schema=` URL parameter, and drives the state of
the "Show prerelease" toggle. It is stripped for display, where it is shown as,
for example, `score (prerelease)`.

For a deeper description of the internals, see
[`source/README.md`](source/README.md) and `CLAUDE.md`.

## Deployment

Deployment is automatic. Pushing to the `main` branch publishes the site via
GitHub Pages (configured in the repository settings to deploy from the `main`
branch root). No build step runs. After a merge to `main`, allow a few minutes
for GitHub Pages to propagate, then verify at
https://www.hedtags.org/hed-schema-browser/.

## Embedding in another site

Because the browser is a self-contained static page, you can embed the hosted
version in your own site with an iframe:

```html
<iframe src="https://www.hedtags.org/hed-schema-browser/"
        width="100%" height="800px" frameborder="0"
        title="HED Schema Browser">
</iframe>
```

You can also point the iframe at a specific schema or version using the URL
parameters described above, for example
`https://www.hedtags.org/hed-schema-browser/?schema=score`.

## Contributing

Issues and pull requests are welcome. Because there is no build or test tooling,
the development loop is simply: edit the files, serve the repository locally
using one of the options above, and reload the page to see your changes.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2022 HED Working Group.

## Related projects

- [hed-standard/hed-schemas](https://github.com/hed-standard/hed-schemas) — the
  source of all HED schema XML files consumed by this browser.
- [HED resources](https://www.hedtags.org/hed-resources) — documentation, tools,
  and tutorials for the HED ecosystem.
