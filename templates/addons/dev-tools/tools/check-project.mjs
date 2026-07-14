import {createHash} from "node:crypto";
import {existsSync, readFileSync} from "node:fs";

const interfaceJson = JSON.parse(readFileSync("interface.json", "utf8"));
const project = JSON.parse(readFileSync("maa-project.json", "utf8"));
const lock = JSON.parse(readFileSync("maa-project.lock.json", "utf8"));
const imports = interfaceJson.import ?? [];

if (project.schemaVersion !== lock.schemaVersion) {
    throw new Error("maa-project.json and maa-project.lock.json schemaVersion must match");
}

if (interfaceJson.name !== project.project?.slug) {
    console.warn("[INFO] interface.json name differs from maa-project.json project.slug; this is allowed.");
}

if (!existsSync(".node-version")) {
    throw new Error(".node-version is missing");
}

if (readFileSync(".node-version", "utf8").trim() !== "24") {
    throw new Error(".node-version must pin Node 24");
}

const requiredWorkflows = projectHasGithubAutomation(project)
    ? [
          ".github/workflows/check.yml",
          ".github/workflows/release.yml",
      ]
    : [];
if (project.addons?.schemaSync) {
    requiredWorkflows.push(".github/workflows/schema-sync.yml");
}
if (project.addons?.optimizeImages) {
    requiredWorkflows.push(".github/workflows/optimize-images.yml");
}
for (const workflow of requiredWorkflows) {
    if (!existsSync(workflow)) {
        throw new Error(`${workflow} is missing`);
    }
    if (!workflowPinsNode24(readFileSync(workflow, "utf8"))) {
        throw new Error(`${workflow} must use Node 24 in actions/setup-node`);
    }
}

if (project.features?.vscode?.enabled) {
    if (!existsSync(".vscode/settings.json")) {
        throw new Error(".vscode/settings.json is missing");
    }

    const vscodeSettings = JSON.parse(readFileSync(".vscode/settings.json", "utf8"));
    if (vscodeSettings["editor.formatOnSave"] !== true) {
        throw new Error(".vscode/settings.json editor.formatOnSave must be true");
    }

    if (vscodeSettings["files.eol"] !== "\n") {
        throw new Error(".vscode/settings.json files.eol must be LF");
    }

    if (!hasJsoncFileAssociations(vscodeSettings["files.associations"])) {
        throw new Error(".vscode/settings.json files.associations must map *.json and *.jsonc to jsonc");
    }

    for (const language of [
        "[json]",
        "[jsonc]",
    ]) {
        if (editorDefaultFormatter(vscodeSettings[language]) !== "esbenp.prettier-vscode") {
            throw new Error(`.vscode/settings.json ${language} editor.defaultFormatter must be esbenp.prettier-vscode`);
        }
    }

    if (!hasInterfaceJsonSchema(vscodeSettings["json.schemas"])) {
        throw new Error(
            ".vscode/settings.json json.schemas must map /interface.json to ./tools/schema/interface.schema.json",
        );
    }
}

if (!hasPending(lock, "node-deps") && !existsSync("pnpm-lock.yaml")) {
    throw new Error("pnpm-lock.yaml is missing; run pnpm install");
}

if (!existsSync("maatools.config.mts")) {
    throw new Error("maatools.config.mts is missing");
}

const maatoolsConfigContent = readFileSync("maatools.config.mts", "utf8");
if (maatoolsConfigContent.includes("defineConfig")) {
    throw new Error("maatools.config.mts must not use @nekosu/maa-tools defineConfig");
}
if (!hasMaatoolsRequiredFields(maatoolsConfigContent)) {
    throw new Error("maatools.config.mts must set maaVersion, interfacePath: 'interface.json', and check: {}");
}
for (const path of [
    ...interfaceResourcePaths(interfaceJson.resource),
    ...imports,
]) {
    if (typeof path !== "string" || path.includes("\\")) {
        throw new Error("interface/import paths must be strings with forward slashes");
    }
    if (!isProjectRelativePath(path)) {
        throw new Error(`interface/import paths must stay within the project root: ${path}`);
    }
    if (!existsSync(path)) {
        throw new Error(`referenced path does not exist: ${path}`);
    }
}

for (const [
    path,
    state,
] of Object.entries(lock.managedFiles ?? {})) {
    if (!existsSync(path)) {
        throw new Error(`managed file is missing: ${path}`);
    }
    const hash = managedFileHash(path, readFileSync(path));
    if (hash !== state.hash) {
        throw new Error(`managed file changed since last accepted baseline: ${path}`);
    }
    if (state.acceptedAt) {
        console.warn("[INFO] Managed file has accepted local changes: " + path);
        console.warn("       Future template updates may conflict with this file.");
    }
}

for (const item of lock.pending ?? []) {
    console.error(`[ERR] Pending ${item.kind}: ${item.command}`);
}

if ((lock.pending ?? []).length > 0) {
    throw new Error("project has pending actions; run create-maa-project --doctor");
}

console.log("[OK] project structure looks valid");

function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}

function projectHasGithubAutomation(project) {
    return Boolean(project.addons?.github) || project.features?.ci?.enabled || project.features?.release?.enabled;
}

function interfaceResources(value) {
    return Array.isArray(value) ? value.filter((item) => isRecord(item)) : [];
}

function arrayOfStrings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function interfaceResourcePaths(value) {
    return interfaceResources(value).flatMap((item) => arrayOfStrings(item.path));
}

function hasPending(lock, kind) {
    return (lock.pending ?? []).some((item) => item?.kind === kind);
}

function workflowPinsNode24(content) {
    return /node-version:\s*['"]?24['"]?/.test(content);
}

function editorDefaultFormatter(value) {
    if (!isRecord(value)) return undefined;
    return typeof value["editor.defaultFormatter"] === "string" ? value["editor.defaultFormatter"] : undefined;
}

function hasInterfaceJsonSchema(value) {
    if (!Array.isArray(value)) return false;
    return value.some((item) => {
        if (!isRecord(item) || item.url !== "./tools/schema/interface.schema.json") return false;
        return Array.isArray(item.fileMatch) && item.fileMatch.includes("/interface.json");
    });
}

function hasJsoncFileAssociations(value) {
    return isRecord(value) && value["*.json"] === "jsonc" && value["*.jsonc"] === "jsonc";
}

function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripDotSlash(path) {
    return path.startsWith("./") ? path.slice(2) : path;
}

function isProjectRelativePath(path) {
    const stripped = stripDotSlash(path);
    return (
        stripped !== "" &&
        stripped !== "." &&
        !stripped.startsWith("/") &&
        !/^[A-Za-z]:/.test(stripped) &&
        !stripped.split("/").includes("..")
    );
}
function managedFileHash(path, content) {
    if (isBinaryManagedPath(path)) {
        return sha256(content);
    }
    const text = content.toString();
    if (path === ".gitignore") {
        return sha256(normalizeManagedText(extractGitignoreBlock(text) ?? text));
    }
    return sha256(normalizeManagedText(text));
}

function isBinaryManagedPath(path) {
    return path.endsWith(".onnx");
}

function normalizeManagedText(content) {
    return content.replace(/\r\n?/g, "\n");
}

function extractGitignoreBlock(content) {
    const start = content.indexOf("# BEGIN create-maa-project");
    if (start < 0) return undefined;
    const markerEnd = content.indexOf("# END create-maa-project", start);
    if (markerEnd < 0) return undefined;
    const endOfLine = content.indexOf("\n", markerEnd);
    return content.slice(start, endOfLine >= 0 ? endOfLine + 1 : content.length);
}

function hasMaatoolsRequiredFields(content) {
    return (
        /\bmaaVersion\s*:\s*['"][^'"]+['"]/.test(content) &&
        /\binterfacePath\s*:\s*['"]interface\.json['"]/.test(content) &&
        /\bcheck\s*:\s*\{/.test(content)
    );
}
