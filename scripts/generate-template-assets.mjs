import {execFile} from "node:child_process";
import {readFile, writeFile} from "node:fs/promises";
import {relative} from "node:path";
import {promisify} from "node:util";
import {format, resolveConfig} from "prettier";

const execFileAsync = promisify(execFile);

const templateRoot = "templates";
const outputPath = "src/template-assets.generated.ts";

const textTemplates = {};
const binaryTemplates = {};

for (const file of await listFiles()) {
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

// git ls-files reports exactly the tracked paths: untracked and ignored files
// (local caches, editor droppings) stay out, and a new template must be
// `git add`-ed before the generator picks it up. The manifest therefore always
// mirrors the tracked template set — nothing is silently filtered here, so a
// junk file that got committed shows up in the manifest and gets fixed in git.
// Paths come back with `/` separators on every platform, which readFile and
// relative() accept as-is.
async function listFiles() {
    const {stdout} = await execFileAsync("git", [
        "ls-files",
        "-z",
        "--",
        templateRoot,
    ]);
    return stdout.split("\0").filter(Boolean).sort();
}

function isTextTemplate(path, content) {
    if (path.endsWith(".png")) return false;
    return !content.includes(0);
}
