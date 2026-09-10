import {execFile} from "node:child_process";
import {chmod, copyFile, mkdir, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {basename, join, resolve} from "node:path";
import {promisify} from "node:util";
import {build} from "esbuild";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

await mkdir("dist/sea", {recursive: true});
await build({
    entryPoints: [
        "src/index.ts",
    ],
    outfile: "dist/sea/index.js",
    bundle: true,
    platform: "node",
    // Downlevel to the oldest supported line so the bundle parses there too. The SEA binary itself
    // embeds whichever Node builds it (CI uses the newest LTS), so this only widens compatibility.
    target: "node22",
    format: "cjs",
    logOverride: {
        "empty-import-meta": "silent",
    },
});

const blobPath = "dist/sea/create-maa-project.blob";
await writeFile(
    "dist/sea/sea-config.json",
    JSON.stringify(
        {
            main: "dist/sea/index.js",
            output: blobPath,
            disableExperimentalSEAWarning: true,
            assets: await templateAssets(),
        },
        null,
        4,
    ),
    "utf8",
);
await execFileAsync(
    process.execPath,
    [
        "--experimental-sea-config",
        "dist/sea/sea-config.json",
    ],
    {
        stdio: "inherit",
    },
);

const os = releaseOs();
const arch = releaseArch();
const binaryPath = join("dist/sea", `create-maa-project-${os}-${arch}${os === "win" ? ".exe" : ""}`);
await copyFile(process.execPath, binaryPath);
if (process.platform === "darwin") {
    await execFileAsync("codesign", [
        "--remove-signature",
        binaryPath,
    ]).catch(() => undefined);
}
await execFileAsync(
    process.execPath,
    [
        require.resolve("postject/dist/cli.js"),
        binaryPath,
        "NODE_SEA_BLOB",
        blobPath,
        "--sentinel-fuse",
        "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
        ...(process.platform === "darwin"
            ? [
                  "--macho-segment-name",
                  "NODE_SEA",
              ]
            : []),
    ],
    {
        stdio: "inherit",
    },
);
if (process.platform === "darwin") {
    await execFileAsync(
        "codesign",
        [
            "--sign",
            "-",
            binaryPath,
        ],
        {stdio: "inherit"},
    );
}
await chmod(binaryPath, 0o755);
console.log(`Built ${basename(binaryPath)}`);

// git ls-files reports exactly the tracked template paths with `/` separators
// on every platform; the asset keys mirror the templates/<relative-path>
// layout that src/templates.ts reads through sea.getAsset().
async function templateAssets() {
    const {stdout} = await execFileAsync("git", [
        "ls-files",
        "-z",
        "--",
        "templates",
    ]);
    const assets = {};
    for (const path of stdout.split("\0").filter(Boolean).sort()) {
        assets[path] = resolve(path);
    }
    return assets;
}

function releaseOs() {
    const value = process.env.CREATE_MAA_PROJECT_RELEASE_OS;
    if (value === "win" || value === "linux" || value === "macos") return value;
    if (process.platform === "win32") return "win";
    if (process.platform === "darwin") return "macos";
    if (process.platform === "linux") return "linux";
    throw new Error(`Unsupported release OS: ${process.platform}`);
}

function releaseArch() {
    const value = process.env.CREATE_MAA_PROJECT_RELEASE_ARCH;
    if (value === "x86_64" || value === "aarch64") return value;
    if (process.arch === "x64") return "x86_64";
    if (process.arch === "arm64") return "aarch64";
    throw new Error(`Unsupported release architecture: ${process.arch}`);
}
