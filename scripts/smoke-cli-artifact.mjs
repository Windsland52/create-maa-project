import {execFile} from "node:child_process";
import {readFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

const execFileAsync = promisify(execFile);
const [
    command,
    ...commandArgs
] = process.argv.slice(2);

if (!command) {
    throw new Error("Usage: node scripts/smoke-cli-artifact.mjs <command> [...arguments]");
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const expectedVersion = String(packageJson.version);
const executable = command.includes("/") || command.includes("\\") ? resolve(command) : command;
const result = await execFileAsync(
    executable,
    [
        ...commandArgs,
        "--cli-version",
    ],
    {
        encoding: "utf8",
        windowsHide: true,
    },
);

if (result.stderr) process.stderr.write(result.stderr);
process.stdout.write(result.stdout);

const actualVersion = result.stdout.trim();
if (actualVersion !== expectedVersion) {
    throw new Error(
        `CLI artifact version mismatch: expected ${expectedVersion}, received ${actualVersion || "<empty>"}.`,
    );
}

console.log(`Verified CLI artifact version ${actualVersion}.`);
