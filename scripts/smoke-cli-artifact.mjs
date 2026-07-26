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
const artifactArgs = [
    ...commandArgs,
    "--cli-version",
];
const invocation = windowsCommandInvocation(executable, artifactArgs);
const result = await execFileAsync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: invocation.env,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
});

if (result.stderr) process.stderr.write(result.stderr);
process.stdout.write(result.stdout);

const actualVersion = result.stdout.trim();
if (actualVersion !== expectedVersion) {
    throw new Error(
        `CLI artifact version mismatch: expected ${expectedVersion}, received ${actualVersion || "<empty>"}.`,
    );
}

console.log(`Verified CLI artifact version ${actualVersion}.`);

function windowsCommandInvocation(executable, args) {
    if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) {
        return {command: executable, args, env: process.env, windowsVerbatimArguments: false};
    }

    const env = {
        ...process.env,
        CREATE_MAA_PROJECT_SMOKE_COMMAND: executable,
    };
    const placeholders = args.map((value, index) => {
        const name = `CREATE_MAA_PROJECT_SMOKE_ARG_${index}`;
        env[name] = value;
        return `"%${name}%"`;
    });
    return {
        command: process.env.ComSpec ?? "cmd.exe",
        args: [
            "/d",
            "/s",
            "/v:off",
            "/c",
            `call "%CREATE_MAA_PROJECT_SMOKE_COMMAND%" ${placeholders.join(" ")}`,
        ],
        env,
        windowsVerbatimArguments: true,
    };
}
