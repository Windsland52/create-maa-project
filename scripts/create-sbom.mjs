import {execFileSync} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {pathToFileURL} from "node:url";

function packageParts(name) {
    if (!name.startsWith("@")) return {name};
    const separator = name.indexOf("/");
    if (separator < 0) return {name};
    return {
        group: name.slice(0, separator),
        name: name.slice(separator + 1),
    };
}

function packageUrl(name, version) {
    const parts = packageParts(name);
    const encodedName = encodeURIComponent(parts.name);
    const path = parts.group ? `${encodeURIComponent(parts.group)}/${encodedName}` : encodedName;
    return `pkg:npm/${path}@${encodeURIComponent(version)}`;
}

function licensesByPackage(licenseReport) {
    const result = new Map();
    for (const [
        fallbackLicense,
        packages,
    ] of Object.entries(licenseReport)) {
        for (const entry of packages) {
            for (const version of entry.versions ?? []) {
                result.set(`${entry.name}@${version}`, String(entry.license ?? fallbackLicense));
            }
        }
    }
    return result;
}

function cycloneDxLicense(value) {
    const key = /^[A-Za-z0-9.+-]+$/.test(value) ? "id" : "name";
    return [{license: {[key]: value}}];
}

export function createCycloneDxBom(packageJson, dependencyRoot, licenseReport) {
    const licenseMap = licensesByPackage(licenseReport);
    const components = new Map();
    const dependencyEdges = new Map();

    function visit(name, node) {
        if (!node?.version) {
            throw new Error(`Production dependency ${name} has no resolved version.`);
        }

        const version = String(node.version);
        const ref = packageUrl(name, version);
        if (!components.has(ref)) {
            const parts = packageParts(name);
            const component = {
                type: "library",
                "bom-ref": ref,
                ...parts,
                version,
                purl: ref,
            };
            const license = licenseMap.get(`${name}@${version}`);
            if (license) component.licenses = cycloneDxLicense(license);
            components.set(ref, component);
        }

        const childRefs = dependencyEdges.get(ref) ?? new Set();
        dependencyEdges.set(ref, childRefs);
        for (const [
            childName,
            childNode,
        ] of Object.entries(node.dependencies ?? {})) {
            const childRef = visit(childName, childNode);
            childRefs.add(childRef);
        }
        return ref;
    }

    const rootRef = packageUrl(packageJson.name, packageJson.version);
    const directRefs = new Set();
    for (const [
        name,
        node,
    ] of Object.entries(dependencyRoot.dependencies ?? {})) {
        directRefs.add(visit(name, node));
    }

    const rootParts = packageParts(packageJson.name);
    const rootComponent = {
        type: "application",
        "bom-ref": rootRef,
        ...rootParts,
        version: String(packageJson.version),
        purl: rootRef,
    };
    if (packageJson.license) rootComponent.licenses = cycloneDxLicense(String(packageJson.license));

    const dependencies = [
        {ref: rootRef, dependsOn: [...directRefs].sort()},
        ...[...components.keys()].sort().map((ref) => ({
            ref,
            dependsOn: [...(dependencyEdges.get(ref) ?? [])].sort(),
        })),
    ];

    return {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: {component: rootComponent},
        components: [...components.values()].sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"])),
        dependencies,
    };
}

function pnpmJson(args) {
    const pnpmScript = process.env.npm_execpath;
    const command = pnpmScript ? process.execPath : process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const commandArgs = pnpmScript
        ? [
              pnpmScript,
              ...args,
          ]
        : args;
    const output = execFileSync(command, commandArgs, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
    });
    return JSON.parse(output);
}

async function main() {
    const outputPath = process.argv[2] ?? "dist/release/create-maa-project.cdx.json";
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const dependencyTrees = pnpmJson([
        "list",
        "--prod",
        "--json",
        "--depth",
        "Infinity",
    ]);
    if (dependencyTrees.length !== 1) {
        throw new Error(`Expected one workspace dependency root, found ${dependencyTrees.length}.`);
    }
    const licenseReport = pnpmJson([
        "licenses",
        "list",
        "--prod",
        "--json",
    ]);
    const bom = createCycloneDxBom(packageJson, dependencyTrees[0], licenseReport);
    await mkdir(dirname(outputPath), {recursive: true});
    await writeFile(outputPath, `${JSON.stringify(bom, null, 4)}\n`, "utf8");
    console.log(`Wrote ${outputPath}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    await main();
}
