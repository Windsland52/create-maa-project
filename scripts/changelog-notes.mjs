import {readFileSync} from "node:fs";
import {resolve} from "node:path";

/**
 * Print the CHANGELOG.md section for one release version.
 *
 * Usage: node scripts/changelog-notes.mjs <version>
 *
 * Used by the release workflow to build the GitHub Release body, so a missing or
 * empty section fails the release instead of publishing empty notes. Accepts
 * "3.3.0" and "v3.3.0", and both "## [3.3.0] - 2026-09-10" and
 * "## [v3.3.0](compare-url) - 2026-09-10" heading styles.
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
const anyHeading = /^## \[v?[^\]]+\](?:\([^)]*\))?(?:\s|$)/;
const targetHeading = new RegExp(`^## \\[v?${escaped}\\]`);

const start = lines.findIndex((line) => targetHeading.test(line));
if (start === -1) {
    process.stderr.write(`No CHANGELOG.md section found for ${version} in ${changelogPath}\n`);
    process.exit(1);
}

const nextHeading = lines.findIndex((line, index) => index > start && anyHeading.test(line));
const sectionLines = lines.slice(start, nextHeading === -1 ? lines.length : nextHeading);
// Trailing blank lines and reference-style link definitions (the compare URL) are not notes.
// `end` indexes `sectionLines`, which is already relative to `start`.
const linkDefinition = /^\[[^\]]+\]:\s+\S+$/;
let end = sectionLines.length;
while (end > 0) {
    const line = (sectionLines[end - 1] ?? "").trim();
    if (line !== "" && !linkDefinition.test(line)) break;
    end -= 1;
}
const section = sectionLines.slice(0, end).join("\n").trim();

if (!section) {
    process.stderr.write(`CHANGELOG.md section for ${version} is empty\n`);
    process.exit(1);
}

process.stdout.write(`${section}\n`);
