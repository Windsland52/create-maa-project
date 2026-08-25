// Keep pnpm-workspace.yaml `overrides` ahead of security advisories.
//
// Runs `pnpm audit`, upserts every flagged package into `overrides` with its
// minimal patched version (mirroring the existing exact-pin convention),
// reinstalls, and re-audits until clean. Exits non-zero only when some finding
// has no available patch - that case genuinely needs a human decision.

import {spawnSync} from "node:child_process";
import {readFileSync, writeFileSync} from "node:fs";

const AUDIT_LEVEL = "low";
const WORKSPACE_FILE = "pnpm-workspace.yaml";
const MAX_ROUNDS = 3;

for (let round = 1; round <= MAX_ROUNDS; round++) {
    const findings = collectFindings();
    if (findings.length === 0) {
        console.log(
            round === 1 ? `No known vulnerabilities at level "${AUDIT_LEVEL}". Nothing to do.` : "Audit is now clean.",
        );
        process.exit(0);
    }

    console.log(`Round ${round}: ${findings.length} advisory package(s):`);
    const updated = [];
    for (const finding of findings) {
        const bumped = upsertOverride(finding.name, finding.patched);
        console.log(
            `  ${finding.name} -> ${finding.patched} (${finding.severity}, ${finding.url ?? "no advisory url"})`,
        );
        if (bumped) updated.push(`${finding.name}@${finding.patched}`);
    }

    if (updated.length === 0) {
        // Nothing changed although findings exist: pinned versions are already
        // at/above every reported patch, yet audit still complains. Likely a
        // lockfile drift - reinstall once, then give up if it persists.
        run("pnpm", ["install"]);
        continue;
    }

    run("pnpm", ["install"]);
}

const remaining = collectFindings();
if (remaining.length > 0) {
    console.error(`Still vulnerable after ${MAX_ROUNDS} rounds (missing upstream patches?):`);
    for (const finding of remaining) {
        console.error(`  ${finding.name} ${finding.vulnerable} (${finding.severity})`);
    }
    process.exit(1);
}
console.log("Audit is now clean.");

function run(command, args) {
    const result = spawnSync(command, args, {stdio: "inherit", shell: process.platform === "win32"});
    if (result.status !== 0) {
        console.error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
        process.exit(result.status ?? 1);
    }
}

function auditJson() {
    // `pnpm audit` exits non-zero whenever findings exist, so capture instead of inheriting.
    const result = spawnSync(
        "pnpm",
        [
            "audit",
            "--json",
            "--audit-level",
            AUDIT_LEVEL,
        ],
        {
            encoding: "utf8",
            shell: process.platform === "win32",
        },
    );
    const text = (result.stdout ?? "").trim();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function collectFindings() {
    const data = auditJson();
    if (!data) return [];

    const byName = new Map();
    const consider = (name, patchedText, severity, url, vulnerable) => {
        const patched = parseFloorVersion(patchedText);
        if (!name || !patched) return;
        const previous = byName.get(name);
        if (!previous || compareVersions(patched, previous.patched) > 0) {
            byName.set(name, {name, patched, severity, url, vulnerable});
        }
    };

    // npm-classic shape: advisories keyed by id.
    for (const advisory of Object.values(data.advisories ?? {})) {
        consider(
            advisory.module_name,
            advisory.patched_versions,
            advisory.severity,
            advisory.url,
            advisory.vulnerable_versions,
        );
    }
    // npm-modern shape: vulnerabilities with fixAvailable objects.
    for (const [
        name,
        entry,
    ] of Object.entries(data.vulnerabilities ?? {})) {
        const fix = entry.fixAvailable;
        if (fix && typeof fix === "object" && fix.name && fix.version) {
            consider(fix.name, fix.version, entry.severity, undefined, entry.range);
        }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** ">=3.3.18" | "=1.2.3" | "^4.5.6 || ^5.0.0" -> lowest concrete x.y.z mentioned. */
function parseFloorVersion(text) {
    if (typeof text !== "string") return null;
    const match = text.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
    return match ? match[0] : null;
}

function compareVersions(a, b) {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let index = 0; index < 3; index++) {
        if ((pa[index] ?? 0) !== (pb[index] ?? 0)) return (pa[index] ?? 0) - (pb[index] ?? 0);
    }
    return 0;
}

/** Upsert `  name: version` inside the top-level overrides block; returns true when the file changed. */
function upsertOverride(name, version) {
    const original = readFileSync(WORKSPACE_FILE, "utf8");
    const lines = original.split("\n");

    let start = lines.findIndex((line) => /^overrides:\s*$/.test(line));
    if (start === -1) {
        start = lines.findIndex((line) => /^allowBuilds:/s.test(line)) + 1;
        lines.splice(start, 0, "", "overrides:");
        start += 2;
    }

    let end = start + 1;
    while (end < lines.length && /^(?:\s|$)/.test(lines[end]) && lines[end].trim() !== "") end++;

    const keyPattern = `^ {2}(?<quote>"?)${escapeRegExp(name)}\\k<quote>: `;
    const existing = lines.slice(start + 1, end).findIndex((line) => new RegExp(keyPattern).test(line));
    const renderedKey = renderKey(name);

    if (existing !== -1) {
        const lineIndex = start + 1 + existing;
        if (lines[lineIndex] === `  ${renderedKey}: ${version}`) return false;
        lines[lineIndex] = `  ${renderedKey}: ${version}`;
    } else {
        const entry = `  ${renderedKey}: ${version}`;
        let insertAt = start + 1;
        while (insertAt < end && compareKeys(sortKeyOf(lines[insertAt]), sortKeyOf(entry)) <= 0) {
            insertAt++;
        }
        lines.splice(insertAt, 0, entry);
    }

    const updatedFile = lines.join("\n");
    if (updatedFile === original) return false;
    writeFileSync(WORKSPACE_FILE, updatedFile);
    return true;
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderKey(name) {
    // Plain scalars must not start with YAML reserved indicators such as "@".
    return name.startsWith("@") ? `"${name}"` : name;
}

function sortKeyOf(line) {
    const match = line.match(/^ {2}"?([^":]+)"?: /);
    return match ? match[1].toLowerCase() : "\uffff";
}

function compareKeys(a, b) {
    return a === b ? 0 : a < b ? -1 : 1;
}
