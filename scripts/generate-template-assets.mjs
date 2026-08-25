import {readdir, readFile, writeFile} from "node:fs/promises";
import {join, relative} from "node:path";
import {format, resolveConfig} from "prettier";

const templateRoot = "templates";
const outputPath = "src/template-assets.generated.ts";
const textTemplates = {};
const binaryTemplates = {};

for (const file of await listFiles(templateRoot)) {
    const key = relative(templateRoot, file).replaceAll("\\", "/");
    const content = await readFile(file);
    if (isTextTemplate(key, content)) {
        textTemplates[key] = content.toString("utf8");
    } else {
        binaryTemplates[key] = content.toString("base64");
    }
}

let source =
    `export const embeddedTextTemplates: Record<string, string> = ${JSON.stringify(textTemplates, null, 4)}\n` +
    `export const embeddedBinaryTemplates: Record<string, string> = ${JSON.stringify(binaryTemplates, null, 4)}\n`;

// Format with the repo Prettier config so a freshly generated snapshot always
// satisfies `format:check`; otherwise the raw JSON.stringify output drifts from
// what Prettier expects and every regeneration re-dirtyies the whole file.
const config = await resolveConfig(outputPath, {editorconfig: true});
source = await format(source, {...config, filepath: outputPath});

await writeFile(outputPath, source, "utf8");

async function listFiles(root) {
    const entries = await readdir(root, {withFileTypes: true});
    const files = [];
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listFiles(path)));
        } else if (entry.isFile()) {
            files.push(path);
        }
    }
    return files.sort();
}

function isTextTemplate(path, content) {
    if (path.endsWith(".png")) return false;
    return !content.includes(0);
}
