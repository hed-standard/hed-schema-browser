var schemaNodes = [];
var allSchemaNodes = [];
var inLibraryNodes = [];
var suggestedTagsDict = {};
var useNewFormat = true;
// All schema data now comes from the schema_versions.json manifest at the root
// of the hed-schemas repo, fetched directly from the raw CDN
// (raw.githubusercontent.com, Fastly-backed) instead of the rate-limited GitHub
// REST API. github_raw_endpoint is the base for both the manifest and every
// schema XML download.
var github_raw_endpoint = "https://raw.githubusercontent.com/hed-standard/hed-schemas/main";
var schema_manifest_url = github_raw_endpoint + "/schema_versions.json";
var schema_manifest = null; // cached parsed manifest (fetched once per page load)
var showDeprecatedSchemas = false; // state of the "Show deprecated / Hide deprecated" toggle
//Get the button
let scrollToTopBtn = null;
var buildSchemaVersionDropdownToken = 0;
var currentSchemaName = 'standard'; // Track currently loaded schema
var currentMaxDepth = 1; // Deepest tag level present in the loaded schema, shown in the "Expand to level" tooltip

/**
 * Escape HTML special characters to prevent XSS and broken rendering
 * @param text The text to escape
 * @returns The HTML-escaped text
 */
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Onload call. Build schema selection and schema versions dropdown
 * and load default schema accordingly to url params.
 *
 * Prerelease mode is determined by either:
 *   - the caller passing a name that contains 'prerelease' (legacy)
 *   - the URL carrying ?prerelease=true, or ?schema=<name>_prerelease
 *
 * In prerelease mode, dropdown clicks call loadPrereleaseSchema(name);
 * otherwise they call loadDefaultSchema(name) which prefers release and
 * falls back to prerelease for prerelease-only schemas like "mouse".
 */
async function load(schema_name) {
    /* Set up scroll to top button
    * https://mdbootstrap.com/docs/standard/extended/back-to-top/
    */
    scrollToTopBtn = document.getElementById("btn-back-to-top");

    // When the user scrolls down 20px from the top of the document, show the button
    window.onscroll = function () {
      scrollFunction();
    };
    // When the user clicks on the button, scroll to the top of the document
    scrollToTopBtn.addEventListener("click", backToTop);

    var urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('schema')) {
        schema_name = urlParams.get('schema');
    }

    // Determine prerelease browsing mode from URL / arg, then normalize base name
    var isPrereleaseMode = urlParams.get('prerelease') === 'true' || schema_name.includes('prerelease');
    var baseSchemaName = schema_name.replace('_prerelease', '');

    // Fetch the schema manifest up front. Everything below (schema list, version
    // dropdowns, prerelease detection) reads from this cached manifest rather
    // than hitting the GitHub REST API.
    try {
        await loadSchemaManifest();
    } catch (err) {
        console.error('Failed to load schema manifest:', err);
        showErrorMessage('Unable to load the schema list. Please try again later.');
        return; // Bail out to prevent broken page state and unhandled promise rejections
    }

    // Build the schema dropdown. Click handler matches current page mode so
    // switching schemas from within prerelease view keeps loading prereleases.
    // Names come from the GitHub API and are inserted via .text() / a bound
    // click handler rather than concatenated into HTML, to avoid injection if
    // a schema folder is ever named with quotes or angle brackets.
    var loaderFn = isPrereleaseMode ? loadPrereleaseSchema : loadDefaultSchema;
    var addSchemaItem = function (name) {
        $('<a class="dropdown-item" href="#"></a>')
            .text(name)
            .on('click', function (e) { e.preventDefault(); loaderFn(name); })
            .appendTo('#schemaDropdown');
    };
    addSchemaItem('standard');
    var library_schemas = getLibarySchemas();
    for (var i = 0; i < library_schemas.length; i++) {
        addSchemaItem(library_schemas[i]);
    }

    // Best-effort initial button text (real value set once loadSchema completes)
    var initialDisplayName = isPrereleaseMode ? baseSchemaName + ' (prerelease)' : baseSchemaName;
    $('#dropdownSchemaButton').text(initialDisplayName);

    // Wire the help dialog (loads help.json on first open).
    bindHelp();

    // Load the initial schema.
    // ?version= only makes sense for releases; ignore it in prerelease mode.
    if (isPrereleaseMode) {
        await loadPrereleaseSchema(baseSchemaName);
    } else if (urlParams.has('version')) {
        var version = urlParams.get('version');
        var url = getSchemaURL(baseSchemaName, version);
        loadSchema(baseSchemaName, url);
    } else {
        await loadDefaultSchema(baseSchemaName);
    }

    // set synonym getter behaviors
    $("#syn_getter_btn").click(function() {
    let host = "http://127.0.0.1:5000/";
    let query = host + "synonym?word=" + $("#searchTags").val();
    var synonyms = null;
        $.ajax({dataType: "json", url: query, async: false, 
        success: function(data) {
        console.log("hide");
            synonyms = [];
            synonyms.push($("#searchTags").val());
            synonyms = synonyms.concat(data["synonyms"]);
            },
        error: function(err) {
            console.log(err);
        }
    });
    if (synonyms != null) {
        $("#syn_getter").empty();
        synonyms.forEach(function(syn) {
            const capitalized = capitalizeFirstLetter(syn);
        let matched_node = allSchemaNodes.filter(elem => elem.includes(capitalized) || elem.includes(syn));
        if (matched_node.length !== 0) {
            matched_node.forEach(node => $("#syn_getter").append(`<option value="${node}" style="font-size:40px;">${node}</option>`));
        }
        });
    }
    });
    $("#syn_getter").change(function() { toNode($(this).val()) });

    // Make the tree/detail split divider draggable. The old Enter-to-freeze
    // behavior is replaced by click-to-pin in the detail panel.
    initSplitDivider();
}

/**
 * Get all currently available library schema names from the cached manifest.
 * The standard schema is keyed by "" in the manifest and is added separately
 * by load(); it is excluded here. Requires loadSchemaManifest() to have run
 * (load() awaits it before calling this).
 */
function getLibarySchemas() {
    if (!schema_manifest || !schema_manifest.libraries) {
        return [];
    }
    return Object.keys(schema_manifest.libraries)
        .filter(function (name) { return name !== ''; })
        .sort();
}

/**
 * Fetch and cache the schema_versions.json manifest from the raw CDN.
 * The manifest lists every standard/library schema together with its
 * released, prerelease, and deprecated versions (each an object with
 * date/file/sha/version). It is fetched once per page load; subsequent calls
 * return the cached copy.
 * @returns Promise resolving to the parsed manifest object
 */
async function loadSchemaManifest() {
    if (schema_manifest) {
        return schema_manifest;
    }
    const response = await fetch(schema_manifest_url);
    if (!response.ok) {
        throw new Error('Failed to fetch schema manifest: HTTP ' + response.status);
    }
    schema_manifest = await response.json();
    return schema_manifest;
}

/**
 * Return the manifest entry (with released/prerelease/deprecated arrays) for a
 * schema. The browser uses "standard" internally, but the manifest keys the
 * standard schema by the empty string "". Returns null if the manifest isn't
 * loaded or the schema is unknown.
 */
function getManifestEntry(schema_name) {
    if (!schema_manifest || !schema_manifest.libraries) {
        return null;
    }
    var key = (schema_name === 'standard') ? '' : schema_name;
    return schema_manifest.libraries[key] || null;
}

/**
 * Build a raw-CDN download URL from a manifest "file" path
 * (e.g. "standard_schema/hedxml/HED8.4.0.xml").
 */
function manifestFileUrl(file) {
    return github_raw_endpoint + '/' + file;
}

/**
 * Derive the version label shown in the version dropdown from a manifest file
 * path: the XML basename without ".xml" and without the leading "HED"/"HED_"
 * prefix, e.g. "HED8.4.0.xml" -> "8.4.0", "HED_lang_1.1.0.xml" -> "lang_1.1.0".
 * The remaining string still contains a semantic version, so the existing
 * sort/compare/latest logic that parses these strings is unaffected.
 */
function versionLabelFromFile(file) {
    return file.split('/').pop().replace(/\.xml$/, '').replace(/^HED_?/, '');
}

/**
 * Display-only version label for the Version dropdown (menu items + button):
 * the semantic-version portion with any leading "<library>_" prefix removed,
 * e.g. "testlib_3.0.0" -> "3.0.0", "lang_1.1.0" -> "1.1.0", "8.4.0" -> "8.4.0".
 * The full "<library>_<version>" form is unchanged everywhere else (version
 * sorting/comparison and the "HED Schema: testlib_3.0.0" title).
 * Only the leading "<name>_" prefix (a non-numeric library token immediately
 * before the version) is removed, so any underscore *within* the version is
 * preserved (e.g. "lang_1.2.0_rc1" -> "1.2.0_rc1", not "rc1").
 */
function versionNumberOnly(version) {
    return String(version).replace(/^[A-Za-z][A-Za-z0-9-]*_(?=\d)/, '');
}

/**
 * Get schema versions for a schema from the cached manifest.
 * Returns an object with parallel version / download_link / isDeprecated
 * arrays — the same shape this code previously built from the GitHub REST API,
 * so downstream consumers (buildSchemaVersionDropdown, findLatestVersion,
 * loadDefaultSchema) are unchanged. Released versions come first, followed by
 * deprecated versions.
 * @param schema_name 'standard' or a library schema name
 * @returns Promise resolving to {version, download_link, isDeprecated}
 */
async function getGithubSchema(schema_name) {
    var githubSchema = {"version": [], "download_link": [], "isDeprecated": []};

    await loadSchemaManifest();
    var entry = getManifestEntry(schema_name);
    if (!entry) {
        console.error('getGithubSchema: no manifest entry for', schema_name);
        return githubSchema;
    }

    (entry.released || []).forEach(function (item) {
        githubSchema["version"].push(versionLabelFromFile(item.file));
        githubSchema["download_link"].push(manifestFileUrl(item.file));
        githubSchema["isDeprecated"].push(false);
    });
    (entry.deprecated || []).forEach(function (item) {
        githubSchema["version"].push(versionLabelFromFile(item.file));
        githubSchema["download_link"].push(manifestFileUrl(item.file));
        githubSchema["isDeprecated"].push(true);
    });

    return githubSchema;
}


/**
 *  Retrieve schema versions and add to version dropdown button.
 *  Deprecated versions are filtered out unless the "Show deprecated schemas"
 *  checkbox is ticked.
 */
function buildSchemaVersionDropdown(schema_name) {
    // clear existing versions
    $("#schemaVersionDropdown").empty();

    // generate unique token to prevent out-of-order updates if user switches schemas quickly
    var requestToken = ++buildSchemaVersionDropdownToken;
    var showDeprecated = showDeprecatedSchemas;

    // get versions based on provided schema name - now async
    getGithubSchema(schema_name).then(function(githubSchema) {
        // discard stale result if user switched schemas
        if (requestToken !== buildSchemaVersionDropdownToken) {
            return;
        }
        // create array of indices and sort by semantic version (descending)
        var indices = [];
        for (var i = 0; i < githubSchema["version"].length; i++) {
            if (!showDeprecated && githubSchema["isDeprecated"][i]) continue;
            indices.push(i);
        }

        // sort indices by semantic version (highest first)
        indices.sort(function(a, b) {
            return compareSemanticVersions(githubSchema["version"][b], githubSchema["version"][a]);
        });

        var isDeprecatedTitleAdded = false;
        // build schema dropdown from Github repo in sorted order.
        // Use jQuery DOM APIs (not string concatenation) so version strings and
        // download URLs are inserted safely.
        for (var i = 0; i < indices.length; i++) {
            var idx = indices[i];
            if (githubSchema["isDeprecated"][idx] && !isDeprecatedTitleAdded) {
                $('<a class="dropdown-header"></a>')
                    .append($('<b>').text('Deprecated'))
                    .appendTo('#schemaVersionDropdown');
                isDeprecatedTitleAdded = true;
            }
            (function (name, version, downloadLink) {
                $('<a class="dropdown-item" href="#"></a>')
                    .text(versionNumberOnly(version))
                    .on('click', function (e) { e.preventDefault(); loadSchema(name, downloadLink); })
                    .appendTo('#schemaVersionDropdown');
            })(schema_name, githubSchema["version"][idx], githubSchema["download_link"][idx]);
        }
    }).catch(function(error) {
        // only show error if this is still the current request
        if (requestToken === buildSchemaVersionDropdownToken) {
            console.error('Error fetching schema versions for %s:', schema_name, error);
        }
    });
}

/**
 * Click handler for the "Show deprecated / Hide deprecated" toggle button.
 * Flips whether deprecated versions appear in the version dropdown, updates the
 * button label to reflect the action it now offers, and rebuilds the version
 * dropdown for whatever schema is currently loaded.
 */
function handleDeprecatedToggle() {
    showDeprecatedSchemas = !showDeprecatedSchemas;
    $("#deprecatedText").text(showDeprecatedSchemas ? "Hide deprecated" : "Show deprecated");
    var baseSchemaName = currentSchemaName.replace('_prerelease', '');
    buildSchemaVersionDropdown(baseSchemaName);
}

/**
 * Get the raw-CDN download URL of the prerelease XML for a schema from the
 * cached manifest. If more than one prerelease is listed, the highest semantic
 * version is chosen. Returns "" when the schema has no prerelease.
 * @returns The download URL of the prerelease XML file, or "" if none
 */
function getPrereleaseUrl(schema_name) {
    var entry = getManifestEntry(schema_name);
    if (!entry || !entry.prerelease || entry.prerelease.length === 0) {
        return "";
    }
    var best = entry.prerelease[0];
    for (var i = 1; i < entry.prerelease.length; i++) {
        if (compareSemanticVersions(entry.prerelease[i].version, best.version) > 0) {
            best = entry.prerelease[i];
        }
    }
    return manifestFileUrl(best.file);
}

/**
 * Get the raw-CDN download URL for a specific schema version by looking it up
 * in the manifest (searching released, then deprecated, then prerelease).
 * @param schema_name 'standard' or library schema name
 * @param version     clean semantic version, e.g. "8.3.0"
 * @returns The schema download link, or "" if the version isn't in the manifest
 */
function getSchemaURL(schema_name, version) {
    var entry = getManifestEntry(schema_name);
    if (entry) {
        var buckets = ['released', 'deprecated', 'prerelease'];
        for (var b = 0; b < buckets.length; b++) {
            var arr = entry[buckets[b]] || [];
            for (var i = 0; i < arr.length; i++) {
                if (arr[i].version === version) {
                    return manifestFileUrl(arr[i].file);
                }
            }
        }
    }
    console.error('getSchemaURL: version "%s" not found for schema "%s"', version, schema_name);
    return "";
}

/**
 * Download the schema given the schema's download link url
 * and reload the html browser with the new schema
 * @param url   schema download link
 */
function loadSchema(schema_name, url)
{
    if (!url || typeof url !== 'string') {
        console.error('loadSchema: missing or invalid URL for', schema_name, url);
        showErrorMessage('Unable to load "' + schema_name + '" (no download URL available).');
        return;
    }
    let re = /HED.*xml/;
    let match = url.match(re);
    if (!match) {
        console.error('loadSchema: URL does not match expected pattern:', url);
        showErrorMessage('Unable to load "' + schema_name + '" (unexpected URL format).');
        return;
    }
    let schemaVersion = match[0];
    // Decide new-format vs old-format rendering.
    // - Library schema filenames are "HED_<name>_<ver>.xml" (e.g. HED_lang_1.1.0.xml).
    //   Libraries only exist in the new-format era, so they always use new format
    //   regardless of their (independent) version number.
    // - Standard schema filenames are "HED<ver>.xml" (e.g. HED8.4.0.xml). New format
    //   applies from HED 8.0.0-alpha.3 onward; treat all 8.x+ as new format.
    // - Test URLs are always new format.
    if (schemaVersion.startsWith('HED_') || url.includes('test')) {
        useNewFormat = true;
    } else {
        let majorMatch = schemaVersion.match(/^HED(\d+)/);
        useNewFormat = !majorMatch || parseInt(majorMatch[1], 10) >= 8;
    }

    if (url.includes('deprecated')) // schema link will be */deprecated/*.xml if deprecated
        var isDeprecated = true;
    else
        var isDeprecated = false;

    currentSchemaName = schema_name; // Track the currently loaded schema

    $.get(url, function(data,status) {
        xml = $.parseXML(data);
        displayResult(xml, useNewFormat, isDeprecated);
        parseMergedSchema();
        toLevel(2);
        getSchemaNodes();
    });
    // Strip the "HED"/"HED_" filename prefix so the version button matches the
    // dropdown labels (e.g. "8.4.0", "score_2.1.0"). schemaVersion itself keeps
    // the prefix above because the new/old-format detection relies on it.
    setDropdownBtnText(schema_name, schemaVersion.split('.xml')[0].replace(/^HED_?/, ''));
    // Fire-and-forget: updatePrereleaseToggleUI is async but its result only
    // affects button state. Catch to avoid unhandled promise rejections if
    // checkSchemaVersionExists() throws unexpectedly.
    updatePrereleaseToggleUI().catch(function (err) {
        console.error('Failed to update prerelease toggle UI:', err);
    });
}

/**
 * Update the "View prerelease / View released schema" button's label and
 * enabled/disabled state based on what is currently loaded.
 * A prerelease-only schema (no release available) will end up with the button
 * disabled and, on click, showing an inline error message.
 */
async function updatePrereleaseToggleUI() {
    var isCurrentlyPrerelease = currentSchemaName.includes('_prerelease');
    var baseSchemaName = currentSchemaName.replace('_prerelease', '');
    var toggleBtn = $('#prereleaseToggle');
    var toggleText = $('#prereleaseText');

    if (isCurrentlyPrerelease) {
        toggleText.text('Show released');
    } else {
        toggleText.text('Show prerelease');
    }

    // Deprecated versions are only meaningful for the released view, so gray out
    // the "Show deprecated" toggle in the prerelease view and reset it to its
    // default (hidden) state.
    var deprecatedBtn = $('#deprecatedToggle');
    if (isCurrentlyPrerelease) {
        showDeprecatedSchemas = false;
        $('#deprecatedText').text('Show deprecated');
        deprecatedBtn.prop('disabled', true)
            .attr('title', 'Deprecated versions are not available in the prerelease view.');
    } else {
        deprecatedBtn.prop('disabled', false).removeAttr('title');
    }

    // Enable only if the "other" version actually exists. When disabled, expose
    // the reason via a native title tooltip since the click-driven error toast
    // can't fire from a disabled button.
    var otherExists = await checkSchemaVersionExists(baseSchemaName, !isCurrentlyPrerelease);
    toggleBtn.prop('disabled', !otherExists);
    if (!otherExists) {
        var versionType = isCurrentlyPrerelease ? 'released' : 'prerelease';
        toggleBtn.attr('title', 'The ' + versionType + ' version of "' + baseSchemaName + '" is not available.');
    } else {
        toggleBtn.removeAttr('title');
    }
}

/**
 * Extract semantic version from a full version string
 * "HED8.4.0" → "8.4.0"
 * "HED_xxx_8.4.0" → "8.4.0"
 */
function extractSemanticVersion(versionStr) {
    var match = versionStr.match(/(\d+)\.(\d+)\.(\d+)/);
    if (match) {
        return match[1] + '.' + match[2] + '.' + match[3];
    }
    return versionStr;
}

/**
 * Compare two semantic versions (e.g., "HED8.4.0" vs "HED8.3.0" or "HED_xxx_8.4.0" vs "HED_xxx_8.3.0")
 * Returns: positive if v1 > v2, negative if v1 < v2, 0 if equal
 */
function compareSemanticVersions(v1, v2) {
    var sem1 = extractSemanticVersion(v1);
    var sem2 = extractSemanticVersion(v2);
    
    var match1 = sem1.match(/(\d+)\.(\d+)\.(\d+)/);
    var match2 = sem2.match(/(\d+)\.(\d+)\.(\d+)/);
    
    if (!match1 || !match2) return 0;
    
    var major1 = parseInt(match1[1]);
    var minor1 = parseInt(match1[2]);
    var patch1 = parseInt(match1[3]);
    
    var major2 = parseInt(match2[1]);
    var minor2 = parseInt(match2[2]);
    var patch2 = parseInt(match2[3]);
    
    if (major1 !== major2) return major1 - major2;
    if (minor1 !== minor2) return minor1 - minor2;
    return patch1 - patch2;
}

/**
 * Find the highest semantic version among non-deprecated versions
 * Returns the download URL of the latest version, or null if none found
 */
function findLatestVersion(versions, isDeprecated, downloadLinks) {
    var latestIndex = -1;
    var latestVersion = null;
    
    for (var i = 0; i < versions.length; i++) {
        // skip non-deprecated entries that lack a parseable semantic version
        if (!isDeprecated[i] && /\d+\.\d+\.\d+/.test(versions[i])) {
            if (latestIndex === -1 || compareSemanticVersions(versions[i], latestVersion) > 0) {
                latestIndex = i;
                latestVersion = versions[i];
            }
        }
    }
    
    if (latestIndex === -1) {
        return null;
    }
    
    return downloadLinks[latestIndex];
}

async function loadDefaultSchema(schema_name) {
    // Prefer the latest release; if none exists (e.g. prerelease-only "mouse"),
    // fall back to prerelease. No HED_*_Latest.xml fallback — that file doesn't
    // exist for prerelease-only schemas and produces a misleading 404.
    buildSchemaVersionDropdown(schema_name);

    var githubSchema = await getGithubSchema(schema_name);
    var latestUrl = findLatestVersion(githubSchema["version"], githubSchema["isDeprecated"], githubSchema["download_link"]);

    if (latestUrl) {
        loadSchema(schema_name, latestUrl);
        return;
    }

    var prereleaseExists = await checkSchemaVersionExists(schema_name, true);
    if (prereleaseExists) {
        await loadPrereleaseSchema(schema_name);
        return;
    }

    showErrorMessage('No release or prerelease version of "' + schema_name + '" is available.');
}

/**
 * Always load the prerelease XML for the given base schema name.
 * Used from the prerelease browsing view and as a fallback from loadDefaultSchema
 * for prerelease-only schemas.
 */
async function loadPrereleaseSchema(base_schema_name) {
    await loadSchemaManifest();
    buildSchemaVersionDropdown(base_schema_name);

    var prereleaseLink = getPrereleaseUrl(base_schema_name);
    if (prereleaseLink) {
        loadSchema(base_schema_name + '_prerelease', prereleaseLink);
    } else {
        showErrorMessage('The prerelease version of "' + base_schema_name + '" is not available.');
    }
}

function setDropdownBtnText(schema_name, version) {
    // Format schema name for display: strip '_prerelease' and add '(prerelease)' suffix if needed
    var displaySchemaName = schema_name;
    if (schema_name.includes('_prerelease')) {
        var nameWithoutPrerelease = schema_name.replace('_prerelease', '');
        displaySchemaName = nameWithoutPrerelease + ' (prerelease)';
    }
    $('#dropdownSchemaButton').text(displaySchemaName);
    $('#dropdownSchemaVersionButton').text(versionNumberOnly(version));
}

/**
 * Check if a schema version (prerelease or release) exists
 * @param schemaName The base schema name (without _prerelease suffix)
 * @param checkPrerelease true = check for prerelease, false = check for release versions
 * @returns Promise<boolean> true if the version exists
 */
async function checkSchemaVersionExists(schemaName, checkPrerelease) {
    await loadSchemaManifest();
    var entry = getManifestEntry(schemaName);
    if (!entry) {
        return false;
    }
    if (checkPrerelease) {
        return (entry.prerelease || []).length > 0;
    }
    return (entry.released || []).length > 0;
}

/**
 * Handle toggle between prerelease and release versions of the current schema.
 * Navigates directly to schema-browser.html with the right ?prerelease= flag
 * and preserves the schema name via ?schema=. Going through the index.html /
 * prerelease.html redirect pages drops query params.
 */
async function handlePrereleaseToggle() {
    var isCurrentlyPrerelease = currentSchemaName.includes('_prerelease');
    var baseSchemaName = currentSchemaName.replace('_prerelease', '');
    var checkingPrerelease = !isCurrentlyPrerelease;

    var exists = await checkSchemaVersionExists(baseSchemaName, checkingPrerelease);

    if (exists) {
        var target = 'schema-browser.html?schema=' + encodeURIComponent(baseSchemaName);
        if (checkingPrerelease) {
            target += '&prerelease=true';
        }
        window.location.href = target;
    } else {
        var versionType = isCurrentlyPrerelease ? 'released' : 'prerelease';
        var message = 'The ' + versionType + ' version of "' + baseSchemaName + '" is not available.';
        showErrorMessage(message);
    }
}

/**
 * Display a red error message tooltip near the prerelease button
 * @param message The error message to display
 */
function showErrorMessage(message) {
    console.log('Showing error message:', message);
    
    // Create or get error message element
    var errorEl = $('#prerelease-error-msg');
    if (errorEl.length === 0) {
        errorEl = $('<div id="prerelease-error-msg"></div>');
        errorEl.css({
            'position': 'fixed',
            'top': '80px',
            'right': '20px',
            'background-color': '#f8d7da',
            'border': '2px solid #721c24',
            'color': '#721c24',
            'padding': '12px 20px',
            'border-radius': '4px',
            'z-index': '10000',
            'max-width': '400px',
            'font-weight': '500',
            'display': 'block'
        });
        $('body').append(errorEl);
    }
    
    errorEl.text(message).show();
    
    // Auto-hide after 4 seconds
    setTimeout(function() {
        errorEl.fadeOut(300);
    }, 4000);
}

// The prerelease toggle button in schema-browser.html has onclick="handlePrereleaseToggle()"
// (no jQuery delegate needed).
// -------------------------------------------------------------------------
// Pure-JS XML → HTML transformation
// Replaces the deprecated XSLTProcessor / XSLT pipeline.
// The generated HTML is structurally identical to what hed-schema.xsl and
// hed-schema-old.xsl produced, so all downstream jQuery code is unchanged.
// -------------------------------------------------------------------------

/** Escape a string for safe insertion into HTML text or attribute values. */
function esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Replicates the XSL translate(translate(name,' ','_'),'0123456789','zowhfvsneit').
 * Used to build CSS-safe id / href values.
 */
function xslTranslate(name) {
    const digits = {'0':'z','1':'o','2':'w','3':'h','4':'f','5':'v','6':'s','7':'n','8':'e','9':'i'};
    return name.replace(/ /g, '_').replace(/[0-9]/g, d => digits[d] || d);
}

/** Return trimmed text of the first direct child element with the given tag. */
function childText(el, tag) {
    const child = el.querySelector(`:scope > ${tag}`);
    return child ? child.textContent.trim() : '';
}

/**
 * Render <attribute> direct children of el as hidden divs attributed to nodeName.
 * Matches the output of the XSL <attribute> template in hed-schema.xsl.
 */
function renderAttrDivs(el, nodeName) {
    let html = '';
    for (const attr of el.querySelectorAll(':scope > attribute')) {
        const attrName = childText(attr, 'name');
        const values = [...attr.querySelectorAll(':scope > value')].map(v => esc(v.textContent.trim()));
        const valStr = values.length > 0 ? values.join(', ') + ',' : 'true';
        html += `<div class="attribute" style="display: none" name="${esc(nodeName)}">${esc(attrName)}: ${valStr}</div>`;
    }
    return html;
}

/**
 * Render <property> direct children of el as hidden divs attributed to nodeName.
 * Used for schemaAttributeDefinition elements (which carry properties, not attributes).
 */
function renderPropDivs(el, nodeName) {
    let html = '';
    for (const prop of el.querySelectorAll(':scope > property')) {
        const propName = childText(prop, 'name');
        const values = [...prop.querySelectorAll(':scope > value')].map(v => esc(v.textContent.trim()));
        const valStr = values.length > 0 ? values.join(', ') + ',' : 'true';
        html += `<div class="attribute" style="display: none" name="${esc(nodeName)}">${esc(propName)}: ${valStr}</div>`;
    }
    return html;
}

/**
 * Render a <node> element and its children recursively (new format, hed-schema.xsl).
 * Parent nodes  → <a data-toggle="collapse"> + children container div
 * Leaf nodes    → plain <a>
 */
function renderSchemaNode(nodeEl, level) {
    const name = childText(nodeEl, 'name');
    const description = childText(nodeEl, 'description');
    const childNodes = [...nodeEl.querySelectorAll(':scope > node')];

    if (childNodes.length > 0) {
        let html = `<a href="#x${esc(name)}" tag="${esc(name)}" description="${esc(description)}" role="button" class="list-group-item has-children level-${level}" aria-expanded="true" tabindex="0" name="schemaNode"><span class="tw-caret" aria-hidden="true">&#9662;</span>${esc(name)}</a>`;
        html += renderAttrDivs(nodeEl, name);
        html += `<div class="list-group collapse multi-collapse level-${level} show" id="x${esc(name)}">`;
        for (const child of childNodes) {
            html += renderSchemaNode(child, level + 1);
        }
        html += '</div>';
        return html;
    } else {
        // NOTE: the "tag" attribute is only used as a lookup key for jQuery selectors
        // (e.g. a[tag='...']) and for the autocomplete/search node list - it is never used
        // as an actual DOM id/href, so it must NOT be run through xslTranslate(). Using the
        // translated form here previously caused a mismatch with the untranslated "name"
        // attribute that renderAttrDivs() stamps onto each attribute div (name="${nodeName}"),
        // so any leaf tag containing a digit (e.g. "SubnodeE1") could never be matched back to
        // its own attribute divs. This broke inLibrary detection (leaves stayed blue instead of
        // brown) and search/autocomplete for such tags - most visible in the testlib schema,
        // whose test nodes are deliberately named with digits (see GitHub issue #11).
        let html = `<a description="${esc(description)}" role="button" class="list-group-item level-${level}" tag="${esc(name)}" tabindex="0" name="schemaNode"><span class="tw-spacer" aria-hidden="true"></span>${esc(name)}</a>`;
        html += renderAttrDivs(nodeEl, name);
        return html;
    }
}

/** Render the inner HTML of the main schema tree from a <schema> element. */
function renderSchemaTree(schemaEl) {
    let html = '';
    for (const node of schemaEl.querySelectorAll(':scope > node')) {
        html += renderSchemaNode(node, 1);
    }
    return html;
}

function renderUnitClassDefinitions(defsEl) {
    let html = '';
    for (const ucDef of defsEl.querySelectorAll(':scope > unitClassDefinition')) {
        const name = childText(ucDef, 'name');
        const description = childText(ucDef, 'description');
        const idName = xslTranslate(name);
        html += `<a description="${esc(description)}" href="#${esc(idName)}" role="button" class="list-group-item" data-toggle="collapse" aria-expanded="true" name="unitClassDef">${esc(name)}</a>`;
        html += renderAttrDivs(ucDef, name);
        html += `<div class="list-group collapse multi-collapse level-" id="${esc(idName)}">`;
        for (const unit of ucDef.querySelectorAll(':scope > unit')) {
            const uName = childText(unit, 'name');
            const uDesc = childText(unit, 'description');
            html += `<a description="${esc(uDesc)}" role="button" class="list-group-item" tag="${esc(uName)}" name="unitClassDef">${esc(uName)}</a>`;
            html += renderAttrDivs(unit, uName);
        }
        html += '</div>';
    }
    return html;
}

function renderUnitModifierDefinitions(defsEl) {
    let html = '';
    for (const c of defsEl.querySelectorAll(':scope > unitModifierDefinition')) {
        const name = childText(c, 'name');
        const description = childText(c, 'description');
        html += `<a description="${esc(description)}" role="button" class="list-group-item" name="unitModifierDef">${esc(name)}</a>`;
        html += renderAttrDivs(c, name);
    }
    return html;
}

function renderValueClassDefinitions(defsEl) {
    let html = '';
    for (const c of defsEl.querySelectorAll(':scope > valueClassDefinition')) {
        const name = childText(c, 'name');
        const description = childText(c, 'description');
        html += `<a description="${esc(description)}" role="button" class="list-group-item" name="valueClassDef">${esc(name)}</a>`;
        html += renderAttrDivs(c, name);
    }
    return html;
}

function renderSchemaAttributeDefinitions(defsEl) {
    let html = '';
    for (const c of defsEl.querySelectorAll(':scope > schemaAttributeDefinition')) {
        const name = childText(c, 'name');
        const description = childText(c, 'description');
        html += `<a description="${esc(description)}" role="button" class="list-group-item" name="attributeDef">${esc(name)}</a>`;
        html += renderPropDivs(c, name);
    }
    return html;
}

function renderPropertyDefinitions(defsEl) {
    let html = '';
    for (const c of defsEl.querySelectorAll(':scope > propertyDefinition')) {
        const name = childText(c, 'name');
        const description = childText(c, 'description');
        html += `<a description="${esc(description)}" role="button" class="list-group-item" name="propertyDef">${esc(name)}</a>`;
        html += renderAttrDivs(c, name);
    }
    return html;
}

/**
 * Render hidden .attribute divs for a flat definition's extra fields so the info
 * board shows them on hover. Same mechanism renderAttrDivs() uses, but sourced
 * from plain child elements (<link>/<namespace>/<iri>) instead of <attribute>.
 * fields is an array of [label, value]; empty values are skipped.
 */
function renderMetaDivs(nodeName, fields) {
    let html = '';
    for (const [label, value] of fields) {
        if (value) {
            html += `<div class="attribute" style="display: none" name="${esc(nodeName)}">${esc(label)}: ${esc(value)}</div>`;
        }
    }
    return html;
}

/** Render <schemaSources>: each <schemaSource> has name / link / description. */
function renderSchemaSources(defsEl) {
    let html = '';
    for (const c of defsEl.querySelectorAll(':scope > schemaSource')) {
        const name = childText(c, 'name');
        const description = childText(c, 'description');
        html += `<a description="${esc(description)}" role="button" class="list-group-item" tag="${esc(name)}" name="sourceDef">${esc(name)}</a>`;
        html += renderMetaDivs(name, [['link', childText(c, 'link')]]);
    }
    return html;
}

/** Render <schemaPrefixes>: each <schemaPrefix> has name / namespace / description. */
function renderSchemaPrefixes(defsEl) {
    let html = '';
    for (const c of defsEl.querySelectorAll(':scope > schemaPrefix')) {
        const name = childText(c, 'name');
        const description = childText(c, 'description');
        html += `<a description="${esc(description)}" role="button" class="list-group-item" tag="${esc(name)}" name="prefixDef">${esc(name)}</a>`;
        html += renderMetaDivs(name, [['namespace', childText(c, 'namespace')]]);
    }
    return html;
}

/** Render <externalAnnotations>: each <externalAnnotation> has name / id / iri / description. */
function renderExternalAnnotations(defsEl) {
    let html = '';
    for (const c of defsEl.querySelectorAll(':scope > externalAnnotation')) {
        const prefix = childText(c, 'name');       // e.g. "dc:"
        const id = childText(c, 'id');             // e.g. "contributor"
        const label = prefix + id;                 // e.g. "dc:contributor"
        const description = childText(c, 'description');
        html += `<a description="${esc(description)}" role="button" class="list-group-item" tag="${esc(label)}" name="externalAnnotationDef">${esc(label)}</a>`;
        html += renderMetaDivs(label, [['iri', childText(c, 'iri')]]);
    }
    return html;
}

/**
 * For each extra-section item, insert hidden inline description / attribute lines
 * right below the item name. They span the full width and are revealed by the
 * "Show descriptions" / "Show attributes" toggles (which add show-ex-desc /
 * show-ex-attrs to #schemaDefinitions). Re-run after each schema load.
 */
function buildExtraInlineInfo() {
    $("#schemaDefinitions .list-group-item").each(function () {
        var $item = $(this);
        var desc = $item.attr('description') || '';
        // Attribute divs follow the item, up to the next item <a> or a children
        // .list-group (for unit classes with nested units).
        var attrs = [];
        $item.nextUntil("a, .list-group", ".attribute").each(function () {
            var text = $(this).text().trim().replace(/,\s*$/, '');
            if (text) { attrs.push(text); }
        });
        // Description goes inline on the item's own line, right after the name.
        if (desc) { $item.append(' <span class="ex-desc">— ' + escapeHtml(desc) + '</span>'); }
        // Attributes go on their own full-width line below the item.
        if (attrs.length) {
            $item.after('<div class="ex-attrs">' + attrs.map(function (a) {
                var i = a.indexOf(':');
                return '<span class="ex-a">' + (i >= 0
                    ? '<span class="lbl">' + escapeHtml(a.slice(0, i).trim()) + ':</span> ' + escapeHtml(a.slice(i + 1).trim())
                    : escapeHtml(a)) + '</span>';
            }).join('') + '</div>');
        }
    });
}

/** Reflect a toggle's on/off state in its label, .active class, and aria-pressed. */
function syncExtraToggle($btn, containerClass, word) {
    var on = $("#schemaDefinitions").hasClass(containerClass);
    $btn.text((on ? 'Hide ' : 'Show ') + word)
        .toggleClass('active', on)
        .attr('aria-pressed', on ? 'true' : 'false');
}

/**
 * Wire the "Show/Hide descriptions" and "Show/Hide attributes" toggles. The
 * state lives on #schemaDefinitions (so it persists across schema reloads); the
 * buttons are (re)initialized from it here, keeping label + aria-pressed in sync.
 */
function bindExtraToggles() {
    syncExtraToggle($("#toggleExtraDesc"), 'show-ex-desc', 'descriptions');
    syncExtraToggle($("#toggleExtraAttrs"), 'show-ex-attrs', 'attributes');
    $("#toggleExtraDesc").off('click.ex').on('click.ex', function () {
        $("#schemaDefinitions").toggleClass('show-ex-desc');
        syncExtraToggle($(this), 'show-ex-desc', 'descriptions');
    });
    $("#toggleExtraAttrs").off('click.ex').on('click.ex', function () {
        $("#schemaDefinitions").toggleClass('show-ex-attrs');
        syncExtraToggle($(this), 'show-ex-attrs', 'attributes');
    });
}

// Guard so help.json is fetched only once, no matter how often the dialog opens.
var helpLoaded = false;

/** True only for http/https URLs — used to keep unsafe schemes out of help links. */
function isHttpUrl(url) {
    return /^https?:\/\//i.test(String(url).trim());
}

/**
 * Wire the "?" help button's dialog. The help text lives in help.json (repo
 * root) so it can be edited without changing any code; it is fetched the first
 * time the dialog is opened and rendered into #helpModalBody.
 */
function bindHelp() {
    $('#helpModal').off('show.bs.modal.help').on('show.bs.modal.help', loadHelp);
}

/** Fetch help.json (once) and render it into the help dialog. */
function loadHelp() {
    if (helpLoaded) {
        return;
    }
    helpLoaded = true;
    fetch('help.json')
        .then(function (r) {
            if (!r.ok) {
                throw new Error('HTTP ' + r.status);
            }
            return r.json();
        })
        .then(renderHelp)
        .catch(function (err) {
            helpLoaded = false;   // allow a retry on the next open
            $('#helpModalBody').html(
                '<div class="text-danger">Could not load help ('
                + escapeHtml(String(err && err.message ? err.message : err)) + ').</div>');
        });
}

/** Render the parsed help.json object into the dialog title + body. */
function renderHelp(help) {
    if (help.title) {
        $('#helpModalTitle').text(help.title);
    }
    var html = '';
    if (help.intro) {
        html += '<p>' + escapeHtml(help.intro) + '</p>';
    }
    (help.sections || []).forEach(function (section) {
        html += '<h6 class="mt-3 font-weight-bold">' + escapeHtml(section.heading || '') + '</h6>';
        if (Array.isArray(section.items)) {
            html += '<ul>';
            section.items.forEach(function (item) {
                html += '<li>' + escapeHtml(item) + '</li>';
            });
            html += '</ul>';
        } else if (section.body) {
            html += '<p>' + escapeHtml(section.body) + '</p>';
        }
    });
    if (Array.isArray(help.links) && help.links.length) {
        html += '<h6 class="mt-3 font-weight-bold">Links</h6><ul>';
        help.links.forEach(function (link) {
            var label = escapeHtml(link.label || link.url);
            // help.json is content-editable, so only linkify http(s) URLs — a
            // scheme like "javascript:" would still execute on click even when
            // the attribute value is HTML-escaped. Unsafe URLs render as text.
            if (isHttpUrl(link.url)) {
                html += '<li><a href="' + escapeHtml(link.url) + '" target="_blank" rel="noopener">'
                    + label + '</a></li>';
            } else {
                html += '<li>' + label + '</li>';
            }
        });
        html += '</ul>';
    }
    $('#helpModalBody').html(html);
}

/**
 * Transform a new-format HED XML document (schema >= 8.x) into section HTML strings.
 * Replicates the output of hed-schema.xsl.
 */
function transformNewFormat(xmlDoc) {
    const hed = xmlDoc.querySelector('HED');
    const library = hed.getAttribute('library');
    const version = hed.getAttribute('version') || '';
    const versionStr = library ? `${library}_${version}` : version;

    const get = tag => hed.querySelector(`:scope > ${tag}`);

    return {
        version: versionStr,
        schema:                    renderSchemaTree(get('schema') || document.createElement('schema')),
        prologue:                  (get('prologue') || {textContent: ''}).textContent,
        epilogue:                  (get('epilogue') || {textContent: ''}).textContent,
        unitClassDefinitions:      get('unitClassDefinitions')      ? renderUnitClassDefinitions(get('unitClassDefinitions'))           : '',
        unitModifierDefinitions:   get('unitModifierDefinitions')   ? renderUnitModifierDefinitions(get('unitModifierDefinitions'))     : '',
        valueClassDefinitions:     get('valueClassDefinitions')     ? renderValueClassDefinitions(get('valueClassDefinitions'))         : '',
        schemaAttributeDefinitions:get('schemaAttributeDefinitions')? renderSchemaAttributeDefinitions(get('schemaAttributeDefinitions')): '',
        propertyDefinitions:       get('propertyDefinitions')       ? renderPropertyDefinitions(get('propertyDefinitions'))             : '',
        schemaSources:             get('schemaSources')             ? renderSchemaSources(get('schemaSources'))                         : '',
        schemaPrefixes:            get('schemaPrefixes')            ? renderSchemaPrefixes(get('schemaPrefixes'))                       : '',
        externalAnnotations:       get('externalAnnotations')       ? renderExternalAnnotations(get('externalAnnotations'))             : '',
    };
}

/**
 * Render a <node> element for old-format schemas (hed-schema-old.xsl).
 * Old-format schemas store tag attributes as XML attributes, not child elements.
 */
function renderSchemaNodeOld(nodeEl, level) {
    const name = childText(nodeEl, 'name');
    const description = nodeEl.getAttribute('description') || '';
    const tagId = xslTranslate(name);
    const childNodes = [...nodeEl.querySelectorAll(':scope > node')];

    // Attributes are XML attributes in the old format
    const attrParts = [];
    for (const attr of nodeEl.attributes) {
        attrParts.push(`${esc(attr.name)}: ${esc(attr.value)},`);
    }
    const attrHtml = `<div class="attribute" style="display: none">${attrParts.join(' ')}</div>`;

    if (childNodes.length > 0) {
        let html = `<a href="#${esc(tagId)}" tag="${esc(tagId)}" description="${esc(description)}" role="button" class="list-group-item has-children level-${level}" aria-expanded="true" tabindex="0" name="schemaNode"><span class="tw-caret" aria-hidden="true">&#9662;</span>${esc(name)}</a>`;
        html += attrHtml;
        html += `<div class="list-group collapse multi-collapse level-${level} show" id="${esc(tagId)}">`;
        for (const child of childNodes) {
            html += renderSchemaNodeOld(child, level + 1);
        }
        html += '</div>';
        return html;
    } else {
        let html = `<a description="${esc(description)}" role="button" class="list-group-item level-${level}" tag="${esc(tagId)}" tabindex="0" name="schemaNode"><span class="tw-spacer" aria-hidden="true"></span>${esc(name)}</a>`;
        html += attrHtml;
        return html;
    }
}

/**
 * Transform an old-format HED XML document into an HTML string.
 * Replicates the output of hed-schema-old.xsl.
 * The hed-version div is included inline (the old displayResult read it back from #schema).
 */
function transformOldFormat(xmlDoc) {
    const hed = xmlDoc.querySelector('HED');
    const version = hed.getAttribute('version') || '';

    let html = `<div id="hed-version" style="display: none;">${esc(version)}</div>`;
    for (const node of hed.querySelectorAll(':scope > node')) {
        html += renderSchemaNodeOld(node, 1);
    }
    return { version, schema: html };
}

/**
 * Reload html browser with new schema.
 * @param xml          Parsed XML document of the schema
 * @param useNewFormat true for schemas >= 8.0.0-alpha.3 (new child-element attribute format)
 * @param isDeprecated true if this is a deprecated schema version
 */
function displayResult(xml, useNewFormat, isDeprecated) {
    if (useNewFormat) {
        const result = transformNewFormat(xml);
        $("#schema").html(result.schema);
        $("#prologue").html(escapeHtml(result.prologue).replace(/\n/g, "<br>"));
        $("#epilogue").html(escapeHtml(result.epilogue).replace(/\n/g, "<br>"));
        $("#schemaDefinitions").show();
        $("#unitClassDefinitions").html(result.unitClassDefinitions);
        $("#unitModifierDefinitions").html(result.unitModifierDefinitions);
        $("#valueClassDefinitions").html(result.valueClassDefinitions);
        $("#schemaAttributeDefinitions").html(result.schemaAttributeDefinitions);
        $("#propertyDefinitions").html(result.propertyDefinitions);
        $("#schemaSources").html(result.schemaSources);
        $("#schemaPrefixes").html(result.schemaPrefixes);
        $("#externalAnnotations").html(result.externalAnnotations);
        buildExtraInlineInfo();   // inline description/attribute lines (hidden until toggled)
        bindExtraToggles();
        var versionText = "HED Schema: " + result.version;
        versionText = isDeprecated ? versionText + " (deprecated)" : versionText;
        $("#hed").html(versionText);
    } else {
        const result = transformOldFormat(xml);
        $("#schema").html(result.schema);
        $("#schemaDefinitions").hide();
        var versionText = "HED Schema: " + result.version;
        versionText = isDeprecated ? versionText + " (deprecated)" : versionText;
        $("#hed").html(versionText);
    }

    // Wire tree interaction: hover/focus preview, click-to-pin, caret expand.
    bindTreeInteractions();

    // Font colors: parents and leaves get blue; leaves get bold. inLibrary nodes
    // are re-colored brown by parseMergedSchema(). "Parent" = a tree .has-children
    // item or (in the extra sections) a Bootstrap collapse toggle.
    $(".list-group-item:not(.inLibrary)").css('color', '#0072B2');
    $(".list-group-item:not(.inLibrary):not(.has-children):not([data-toggle='collapse'])").css('font-weight', 'bold');
}


// ---------------------------------------------------------------------------
// Schema-tree detail panel (right pane). Hovering a tag previews it in
// #tagPreview; clicking a tag name adds a pinned section for it to
// #tagPinnedList, so several tags can be shown at once. Each pinned section has
// a remove (×) control, and "Clear all" empties the list.
// ---------------------------------------------------------------------------
var pinCounter = 0;   // unique id per pinned section (handles duplicate tag names)

/** Text of a tree <a> excluding its caret/spacer span (i.e. the tag name). */
function nodeLabel($a) {
    return $a.clone().children().remove().end().text().trim();
}

/**
 * Inner detail HTML for a tree tag <a>: name, description, attributes, then
 * Long form (path) and hedId at the bottom. hedId is pulled out of the
 * attribute list so it can sit at the bottom.
 */
function tagDetailHtml($a) {
    var name = nodeLabel($a);
    var nodeName = $a.attr('tag');
    var description = $a.attr('description') || '';
    var path = getPath($a);

    var attrLines = [], hedId = '';
    // Gather this node's attribute divs. New format (>= 8.x) emits one
    // .attribute[name=...] div per attribute (values may themselves be
    // comma-separated); old format (< 8.x) emits a single unnamed .attribute div
    // holding all attributes comma-separated. nextUntil stops at the next tag
    // <a>, so it picks up exactly this node's attribute divs in both formats.
    $a.nextUntil("a", ".attribute").each(function () {
        var $d = $(this);
        var raw = $d.text().trim().replace(/,\s*$/, '');
        if (!raw) { return; }
        // Only split the unnamed (old-format) div — a named div is one attribute.
        var parts = $d.attr('name') ? [raw] : raw.split(',');
        parts.forEach(function (p) {
            p = p.trim();
            if (!p) { return; }
            var m = p.match(/^\s*hedId\s*:\s*(.+)$/i);
            if (m) { hedId = m[1].trim(); }
            else { attrLines.push(p); }
        });
    });

    var html = '<div class="i-name">' + escapeHtml(name) + '</div>';
    if (description) html += '<div class="i-desc">' + escapeHtml(description) + '</div>';
    if (attrLines.length) {
        html += '<div class="i-attr">' + attrLines.map(function (a) {
            var i = a.indexOf(':');
            return '<div>' + (i >= 0
                ? '<span class="lbl">' + escapeHtml(a.slice(0, i).trim()) + ':</span> ' + escapeHtml(a.slice(i + 1).trim())
                : escapeHtml(a)) + '</div>';
        }).join('') + '</div>';
    }
    html += '<div class="i-bottom"><div><span class="lbl">Long form:</span> ' + escapeHtml(path) + '</div>';
    if (hedId) html += '<div><span class="lbl">hedId:</span> ' + escapeHtml(hedId) + '</div>';
    html += '</div>';
    return html;
}

/** Show a tag in the transient preview slot (does not touch the pinned list). */
function previewTag($a) {
    $("#schema .list-group-item").removeClass('previewing');
    $a.addClass('previewing');
    if ($a.hasClass('pinned')) {
        $("#tagPreview").empty();   // already in the pinned list; don't preview a copy
    } else {
        $("#tagPreview").html('<div class="tag-section preview">' + tagDetailHtml($a) + '</div>');
    }
}

/** Add — or, if already pinned, remove — a pinned detail section for a tag. */
function togglePinnedTag($a) {
    if ($a.hasClass('pinned')) {
        removePinned($a.attr('data-pinid'));
        previewTag($a);
        return;
    }
    var id = ++pinCounter;
    $a.addClass('pinned').attr('data-pinid', id);
    $('<div class="tag-section pinned"></div>')
        .attr('data-pinid', id)
        .html('<button type="button" class="unpin-x" title="Remove">&times;</button>' + tagDetailHtml($a))
        .appendTo("#tagPinnedList");
    updateClearAllState();
    previewTag($a);   // refresh the preview note to "already pinned below"
}

/** Remove the pinned section (and untag the tree) for a given pin id. */
function removePinned(pid) {
    $("#tagPinnedList .tag-section[data-pinid='" + pid + "']").remove();
    $("#schema .list-group-item[data-pinid='" + pid + "']").removeClass('pinned').removeAttr('data-pinid');
    updateClearAllState();
}

function clearAllPinned() {
    $("#tagPinnedList").empty();
    $("#schema .list-group-item.pinned").removeClass('pinned').removeAttr('data-pinid');
    updateClearAllState();
}

function updateClearAllState() {
    $("#clearAllTags").prop('disabled', $("#tagPinnedList .tag-section").length === 0);
}

/** Sync each parent caret glyph AND aria-expanded to whether its children show. */
function syncCarets() {
    $("#schema .list-group-item.has-children").each(function () {
        // The <a> is followed by hidden .attribute divs, then the children
        // container, so use nextAll(...).first() rather than next().
        var shown = $(this).nextAll(".list-group.collapse").first().hasClass('show');
        $(this).children('.tw-caret').html(shown ? '▾' : '▸');
        $(this).attr('aria-expanded', shown ? 'true' : 'false');
    });
}

/** (Re)bind hover/focus preview, click-to-pin (accumulate), and caret expand. */
function bindTreeInteractions() {
    $("#tagPreview").empty();
    $("#tagPinnedList").empty();
    updateClearAllState();
    $("#schema")
        .off('.tree')
        .on('mouseenter.tree', '.list-group-item', function (e) { e.stopPropagation(); previewTag($(this)); })
        .on('focus.tree', '.list-group-item', function () { previewTag($(this)); })
        .on('click.tree', '.list-group-item', function (e) {
            if ($(e.target).is('.tw-caret')) {                 // caret => expand/collapse only
                e.preventDefault(); e.stopPropagation();
                $(this).nextAll(".list-group.collapse").first().toggleClass('show');
                syncCarets();
            } else {                                           // name => add/remove a pinned section
                e.preventDefault();
                togglePinnedTag($(this));
            }
        })
        // Keyboard expand/collapse for parent rows (the caret is mouse-only):
        // ArrowRight expands, ArrowLeft collapses. Enter/Space still pins.
        .on('keydown.tree', '.list-group-item.has-children', function (e) {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') { return; }
            e.preventDefault();
            var $target = $(this).nextAll(".list-group.collapse").first();
            var shown = $target.hasClass('show');
            if (e.key === 'ArrowRight' && !shown) { $target.addClass('show'); syncCarets(); }
            else if (e.key === 'ArrowLeft' && shown) { $target.removeClass('show'); syncCarets(); }
        });
    // Remove one pinned section via its × button.
    $("#tagPinnedList").off('.tree').on('click.tree', '.unpin-x', function (e) {
        e.stopPropagation();
        removePinned($(this).closest('.tag-section').attr('data-pinid'));
    });
    // "Clear all" empties the pinned list.
    $("#clearAllTags").off('.tree').on('click.tree', clearAllPinned);
}

/**
 * A horizontal drag handle that resizes a target element's height. Dragging up
 * shrinks it, down grows it; the target keeps overflow:auto so it scrolls.
 */
function makeVerticalResizer(target, handle, minH) {
    if (!target || !handle || handle.dataset.bound) return;
    handle.dataset.bound = '1';
    var dragging = false;
    handle.addEventListener('mousedown', function (e) { dragging = true; e.preventDefault(); document.body.style.cursor = 'row-resize'; });
    document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        var top = target.getBoundingClientRect().top;
        target.style.height = Math.max(minH, e.clientY - top) + 'px';
    });
    document.addEventListener('mouseup', function () { dragging = false; document.body.style.cursor = ''; });
}

/**
 * Wire the resize handles. Runs once. The vertical divider rebalances the tree
 * and detail panes; the two horizontal handles resize the tree area and the
 * extra-sections area heights (each pane keeps its own scrollbar).
 */
function initSplitDivider() {
    var split = document.getElementById('treeSplit'),
        div = document.getElementById('treeDivider'),
        tree = split ? split.querySelector('.pane-tree') : null;
    if (split && div && tree && !div.dataset.bound) {
        div.dataset.bound = '1';
        var dragging = false;
        div.addEventListener('mousedown', function (e) { dragging = true; e.preventDefault(); document.body.style.cursor = 'col-resize'; });
        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            var r = split.getBoundingClientRect(), w = e.clientX - r.left;
            w = Math.max(140, Math.min(w, r.width - 140));
            tree.style.flex = '0 0 ' + w + 'px';
        });
        document.addEventListener('mouseup', function () { dragging = false; document.body.style.cursor = ''; });
    }
    // Height resizers for the tree area and the extra-sections body.
    makeVerticalResizer(document.getElementById('treeSplit'), document.getElementById('treeResize'), 200);
    makeVerticalResizer(document.getElementById('extraScroll'), document.getElementById('extraResize'), 120);
}

/**
 *  Get full path of a tag node, e.g. "Event/Sensory-event". Uses nodeLabel so
 *  the caret/spacer span doesn't leak into the path text.
 */
function getPath(node) {
    var path = nodeLabel(node);
    node = node.parent();
    while (node != null) {
        var aNode = node.prevAll("a.list-group-item:first");
        var label = nodeLabel(aNode);
        if (label) {
            path = label + "/" + path;
            node = node.parent();
        }
        else
            break;
    }
    return path;
}

function hideAll() {
    $("#schema").find(".collapse").removeClass("show");
    $("#schema").attr("status","hide");
}
/**
 * Find the deepest tag level present in the currently loaded schema tree,
 * used to bound/annotate the "Expand to level" box. Recomputed on every schema
 * load since different schemas/libraries nest to different depths.
 */
function getMaxDepth() {
    var max = 1;
    $("#schema a.list-group-item").each(function () {
        var match = ($(this).attr("class") || "").match(/level-(\d+)/);
        if (match) {
            max = Math.max(max, parseInt(match[1], 10));
        }
    });
    return max;
}
/**
 * Show tags down to (and including) the given depth level, hiding deeper ones,
 * and refresh the "Expand to level" box/tooltip to reflect the applied value.
 */
function toLevel(level) {
    currentMaxDepth = getMaxDepth();
    level = Math.max(1, Math.min(parseInt(level, 10) || 1, currentMaxDepth));
    hideAll()
    for (var i=1; i < level; i++) {
        $("#schema").find(`.level-${i}`).addClass("show");
    }
    $("#schema").attr("status","show");
    $("#toLevel").val(level).attr("title", "Enter the depth level to expand to (max " + currentMaxDepth + ")");
    syncExpandCollapseBtn(level);
    syncCarets();   // keep parent caret glyphs in sync with the .show state
}
function expandLevelInputChanged(value) {
    toLevel(value);
}
function collapseAllNodes() {
    toLevel(1);
}
function expandAllNodes() {
    toLevel(getMaxDepth());
}
/**
 * Keep the single Expand/Collapse toggle button in sync with the actual tree
 * state. When everything down to the deepest level is shown, the button offers
 * "Collapse all"; otherwise it offers "Expand all". Called from toLevel() so it
 * also reflects manual "Expand to level" entries, not just button clicks.
 */
function syncExpandCollapseBtn(level) {
    var fullyExpanded = level >= currentMaxDepth;
    $("#expandCollapseBtn")
        .attr("data-state", fullyExpanded ? "expanded" : "collapsed")
        .text(fullyExpanded ? "Collapse all" : "Expand all");
}
/**
 * Click handler for the Expand/Collapse toggle button. Expands the whole tree
 * when currently collapsed, collapses to the top level when currently expanded.
 * The label/state is updated by syncExpandCollapseBtn() via toLevel().
 */
function toggleExpandCollapse() {
    if ($("#expandCollapseBtn").attr("data-state") === "expanded") {
        toLevel(1);
    } else {
        expandAllNodes();
    }
}
function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}
function toNode(nodeName) {
    let node = $("#schema a[tag='"+nodeName+"']").first();
    if (!node.length) return;
    // \d+ (not \d?) so levels >= 10 are captured correctly; null-guard the match.
    let levelMatch = (node.attr("class") || "").match(/level-(\d+)/);
    if (!levelMatch) return;
    toLevel(levelMatch[1]);
    // The tree scrolls inside .pane-tree, so scroll that pane (not the window).
    node[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    previewTag(node);   // show the found tag's details in the preview slot
    node.effect("highlight", {}, 3000);
}
function getSchemaNodes() {
    /**
     * Set autocomplete behavior
     */
    allowDeprecated = $("#searchDeprecatedTags")[0].checked;
    // clear array
    schemaNodes.length = 0;
    allSchemaNodes.length = 0;

    // clear dictionary
    suggestedTagsDict = {};
    /* Initialize schema nodes list and set behavior of search box */
    $("a[name='schemaNode']").each(function() {
        attributes = getAttributesOfNode($(this));
        if (!allowDeprecated && attributes.includes('deprecatedFrom')) {
            return;
        }
        
        var nodeName = $(this).attr("tag");
        allSchemaNodes.push(nodeName);

        // build the suggestedtags dictionary
        $(this).nextAll(`.attribute[name='${nodeName}']`).each(function(index) {
            var parsed = $(this).text();
            if (parsed.includes("suggestedTag")) {
                var suggestedTags = parsed.split(":")[1].trim();
                suggestedTags = suggestedTags.split(",");
                clean_suggestedTags = [];
                suggestedTags.forEach(element => {
                    // for non empty string, remove whitespace and newline characters and tab characters and push to clean_suggestedTags
                    if (element.trim().length > 0) {
                        cleaned = element.trim();
                        cleaned.replace((/[\t\n\r]/gm),"");
                        cleaned = cleaned.toLowerCase();
                        clean_suggestedTags.push(cleaned);
                    }
                });
                // for each clean_suggestedTags, add its mapping with nodeName to the suggestedTagsDict
                clean_suggestedTags.forEach(element => {
                    if (!(element in suggestedTagsDict)) {
                        suggestedTagsDict[element] = [nodeName];
                    }
                    else {
                        suggestedTagsDict[element].push(nodeName);
                    }
                });
            }
        });
    });    
    
    /* add autocomplete and search */
    autocomplete(document.getElementById("searchTags"), allSchemaNodes, suggestedTagsDict);

    /* go to tag on enter key press */
    $("#searchTags").on('keyup', function (e) {
        if (e.key === 'Enter' || e.keyCode === 13) {
        var searchText = $("#searchTags").val();
        searchText = searchText.toLowerCase();
        searchText = capitalizeFirstLetter(searchText);
        if (allSchemaNodes.includes(searchText))
            toNode(searchText);
        }
    });
}

function getAttributesOfNode(tagNode) {
    attributes = []
    attributeDivs = tagNode.nextUntil("a", ".attribute");
    for (var i=0; i < attributeDivs.length; i++) {
        attributes.push(attributeDivs[i].innerText.split(':')[0]);
    }
    return attributes
}

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}
/* For scroll to top button */
function scrollFunction() {
  if (
    document.body.scrollTop > 20 ||
    document.documentElement.scrollTop > 20
  ) {
    scrollToTopBtn.style.display = "block";
  } else {
    scrollToTopBtn.style.display = "none";
  }
}
function backToTop() {
  document.body.scrollTop = 0;
  document.documentElement.scrollTop = 0;
}
/**
 * From autocomplete online tutorial
 */
function autocomplete(inp, arr, suggestedTagsDict) {
    /*the autocomplete function takes two arguments,
    the text field element and an array of possible autocompleted values:*/
    var currentFocus;
    /*execute a function when someone writes in the text field:*/
    inp.addEventListener("input", function(e) {
        var a, b, i, val = this.value;
        val = val.toLowerCase(); // make uniform
        /*close any already open lists of autocompleted values*/
        closeAllLists();
        if (!val) { return false;}
        currentFocus = -1;
        /*create a DIV element that will contain the items (values):*/
        a = document.createElement("DIV");
        a.setAttribute("id", this.id + "autocomplete-list");
        a.setAttribute("class", "autocomplete-items");
        /*append the DIV element as a child of the autocomplete container:*/
        this.parentNode.appendChild(a);
        /*for each item in the array...*/
        for (i = 0; i < arr.length; i++) {
          /*check if the item starts with the same letters as the text field value:*/
          if (arr[i].toLowerCase().includes(val)) {
            /*create a DIV element for each matching element:*/
            b = document.createElement("DIV");
            /*make the matching letters bold:*/
            b.innerHTML = arr[i].substr(0, arr[i].toLowerCase().indexOf(val));
            b.innerHTML += "<strong>" + arr[i].substr(arr[i].toLowerCase().indexOf(val), val.length) + "</strong>";
            b.innerHTML += arr[i].substr(arr[i].toLowerCase().indexOf(val)+val.length);
            /*insert a input field that will hold the current array item's value:*/
            b.innerHTML += "<input type='hidden' value='" + arr[i] + "'>";
            /*execute a function when someone clicks on the item value (DIV element):*/
            b.addEventListener("click", function(e) {
                /*insert the value for the autocomplete text field:*/
                inp.value = this.getElementsByTagName("input")[0].value;
                toNode(inp.value);
                /*close the list of autocompleted values,
                (or any other open lists of autocompleted values:*/
                closeAllLists();
            });
            a.appendChild(b);
          }
        }
        if (val in suggestedTagsDict) {
            b = document.createElement("DIV");
            b.innerHTML = "<strong>Suggested Tags Of:</strong>";
            a.appendChild(b)
            suggestedTagsDict[val].forEach(element => {
                b = document.createElement("DIV");
                b.innerHTML = element
                /*insert a input field that will hold the current array item's value:*/
                b.innerHTML += "<input type='hidden' value='" + element + "'>";
                /*execute a function when someone clicks on the item value (DIV element):*/
                b.addEventListener("click", function(e) {
                    /*insert the value for the autocomplete text field:*/
                    inp.value = this.getElementsByTagName("input")[0].value;
                    toNode(inp.value);
                    /*close the list of autocompleted values,
                    (or any other open lists of autocompleted values:*/
                    closeAllLists();
                });
                a.appendChild(b);
            });
        }
    });
    /*execute a function presses a key on the keyboard:*/
    inp.addEventListener("keydown", function(e) {
        var x = document.getElementById(this.id + "autocomplete-list");
        if (x) x = x.getElementsByTagName("div");
        if (e.keyCode == 40) {
          /*If the arrow DOWN key is pressed,
          increase the currentFocus variable:*/
          currentFocus++;
          /*and and make the current item more visible:*/
          addActive(x);
        } else if (e.keyCode == 38) { //up
          /*If the arrow UP key is pressed,
          decrease the currentFocus variable:*/
          currentFocus--;
          /*and and make the current item more visible:*/
          addActive(x);
        } else if (e.keyCode == 13) {
          /*If the ENTER key is pressed, prevent the form from being submitted,*/
          e.preventDefault();
          if (currentFocus > -1) {
            /*and simulate a click on the "active" item:*/
            if (x) x[currentFocus].click();
          }
        }
    });
    function addActive(x) {
      /*a function to classify an item as "active":*/
      if (!x) return false;
      /*start by removing the "active" class on all items:*/
      removeActive(x);
      if (currentFocus >= x.length) currentFocus = 0;
      if (currentFocus < 0) currentFocus = (x.length - 1);
      /*add class "autocomplete-active":*/
      x[currentFocus].classList.add("autocomplete-active");
    }
    function removeActive(x) {
      /*a function to remove the "active" class from all autocomplete items:*/
      for (var i = 0; i < x.length; i++) {
        x[i].classList.remove("autocomplete-active");
      }
    }
    function closeAllLists(elmnt) {
      /*close all autocomplete lists in the document,
      except the one passed as an argument:*/
      var x = document.getElementsByClassName("autocomplete-items");
      for (var i = 0; i < x.length; i++) {
        if (elmnt != x[i] && elmnt != inp) {
        x[i].parentNode.removeChild(x[i]);
      }
    }
  }
  
  /*execute a function when someone clicks in the document:*/
  document.addEventListener("click", function (e) {
      closeAllLists(e.target);
  });
} 

function parseMergedSchema() {
    // clear inLibraryNodes
    inLibraryNodes.length = 0;
    // parse merged library schema
    // scan through all <a> tags with name="schameNode" and detect whether its siblings contain <div> tag with class="attribute" whose values contains "inLibrary"
    // if so, add the class "inLibrary" to the <a> tag
    $("a[name='schemaNode']").each(function() {
        var nodeName = $(this).attr("tag");
        $(this).nextAll(`.attribute[name='${nodeName}']`).each(function(index) {
            var parsed = $(this).text();
            if (parsed.includes("inLibrary")) {
                inLibraryNodes.push(nodeName);
                $(this).prevAll("a.list-group-item:first").addClass("inLibrary");
                $(this).prevAll("a.list-group-item:first").addClass("hasInLibrary");
            }
        });
    });

    $("#schema").attr("inlibrarystatus","show");
    // reset button text and enable/disable based on whether this schema has any merged library content
    $("#toggleInLibrary").text("Show library only");
    $("#toggleInLibrary").prop("disabled", inLibraryNodes.length === 0);

    // mark all tags as has inLibrary class or not
    // for each <a> with list-group-item class
    $("a.list-group-item").each(function() {
        // print the href of this node
        div_id = $(this).attr("href");
        // if the div with id div_id has a child with class inLibrary
        if ($(div_id).find('a.inLibrary').length !== 0) {
            $(this).addClass("hasInLibrary");
        }
    });
   
    // make inLibrary tag a different color (parents = .has-children, leaves get bold)
    $(".inLibrary").css('color', '#a0522d');
    $(".inLibrary:not(.has-children)").css('font-weight', 'bold');

}

/**
 * Button listener
 * Show/hide merged library tags
 */
function showHideMergedLibrary() {
    if ($("#schema").attr("inlibrarystatus") == "show") {
        // hide base schema, show only merged library tags
        $(".list-group-item:not(.hasInLibrary)").hide();
        $("#schema").attr("inlibrarystatus","hide");
        $("#toggleInLibrary").text("Show merged");
        autocomplete(document.getElementById("searchTags"), inLibraryNodes, suggestedTagsDict);
    }
    else {
        // restore full schema view
        $(".list-group-item:not(.hasInLibrary)").show();
        $("#schema").attr("inlibrarystatus","show");
        $("#toggleInLibrary").text("Show library only");
        autocomplete(document.getElementById("searchTags"), allSchemaNodes, suggestedTagsDict);
    }
}

// Update url params
function replaceUrlParam(url, paramName, paramValue)
{
    if (paramValue == null) {
        paramValue = '';
    }
    var pattern = new RegExp('\\b('+paramName+'=).*?(&|#|$)');
    if (url.search(pattern)>=0) {
        return url.replace(pattern,'$1' + paramValue + '$2');
    }
    url = url.replace(/[?#]$/,'');
    return url + (url.indexOf('?')>0 ? '&' : '?') + paramName + '=' + paramValue;
}

