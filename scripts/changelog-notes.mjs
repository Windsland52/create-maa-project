import {readFileSync} from "node:fs";
import {resolve} from "node:path";

/**
 * Print the CHANGELOG.md section for one release version.
 *
 * Usage: node scripts/changelog-notes.mjs <version>
 *
 * Used by the release workflow to build the GitHub Release body, so a missing or
 * empty section fails the release instead of publishing empty notes. Accepts
 * "3.3.0" and "v3.3.0", and both bracketed and bare headings:
 *
 *     ## [3.3.0] - 2026-09-10
 *     ## [3.3.0](compare-url) - 2026-09-10
 *     ## 3.3.0 - 2026-09-10
 *
 * Keep a Changelog writes version headings and cross-references as reference-style
 * links ("[3.3.0]") whose definitions live elsewhere in the file. The definitions
 * do not belong in a release body, so each reference that has one is resolved to an
 * inline link here. Leaving them unresolved would publish literal "[3.3.0]" text.
 */

const versionArgument = process.argv[2];
if (!versionArgument) {
    process.stderr.write("Usage: node scripts/changelog-notes.mjs <version>\n");
    process.exit(2);
}

const changelogPath = resolve(import.meta.dirname, "..", "CHANGELOG.md");
const version = versionArgument.startsWith("v") ? versionArgument : `v${versionArgument}`;
const bareVersion = version.replace(/^v/, "");
const escaped = bareVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const lines = readFileSync(changelogPath, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);

// Reference-style link definitions may sit after the section or in a block at the end.
const definitionPattern = /^\[([^\]]+)\]:\s+(\S+)\s*$/;
const definitions = new Map();
for (const line of lines) {
    const match = definitionPattern.exec(line.trim());
    if (match && !definitions.has(match[1])) definitions.set(match[1], match[2]);
}

// A section heading is "## [3.3.0] …", "## [3.3.0](url) …" or "## 3.3.0 …".
const anyHeading = /^## (?:\[v?[^\]]+\](?:\([^)]*\))?|v?\d+\.\d+\.\d+)(?:\s|$)/;
const targetHeading = new RegExp(`^## (?:\\[v?${escaped}\\]|v?${escaped})(?:\\s|$)`);

const start = lines.findIndex((line) => targetHeading.test(line));
if (start === -1) {
    process.stderr.write(`No CHANGELOG.md section found for ${version} in ${changelogPath}\n`);
    process.exit(1);
}

const nextHeading = lines.findIndex((line, index) => index > start && anyHeading.test(line));
const sectionLines = lines.slice(start, nextHeading === -1 ? lines.length : nextHeading);

// Trailing blank lines and link definitions are not part of the notes. `end` indexes
// `sectionLines`, which is already relative to `start`.
let end = sectionLines.length;
while (end > 0) {
    const line = (sectionLines[end - 1] ?? "").trim();
    if (line !== "" && !definitionPattern.test(line)) break;
    end -= 1;
}

// Resolve reference-style links that have a definition. The lookahead keeps inline links
// ("[text](url)") and images ("![alt]") untouched.
const section = sectionLines
    .slice(0, end)
    .join("\n")
    .replace(/(!?)\[([^\]]+)\](?!\()/g, (whole, bang, label) => {
        if (bang) return whole;
        const url = definitions.get(label);
        return url === undefined ? whole : `[${label}](${url})`;
    })
    .trim();

if (!section) {
    process.stderr.write(`CHANGELOG.md section for ${version} is empty\n`);
    process.exit(1);
}

process.stdout.write(`${section}\n`);
