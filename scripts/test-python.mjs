import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawn} from "node:child_process";

const candidates =
    process.platform === "win32"
        ? [
              [
                  "py",
                  "-3",
              ],
              [
                  "python",
              ],
              [
                  "python3",
              ],
          ]
        : [
              [
                  "python3",
              ],
              [
                  "python",
              ],
          ];

// 0 = loguru>=0.8; 1 = not installed; 2 = installed but too old (must fail tests, do not upgrade).
const probeLoguru = [
    "from importlib.metadata import PackageNotFoundError, version",
    "try:",
    "    raw = version('loguru')",
    "except PackageNotFoundError:",
    "    raise SystemExit(1)",
    "parts = []",
    "for piece in raw.split('.'):",
    "    digits = ''.join(ch for ch in piece if ch.isdigit())",
    "    if digits == '':",
    "        break",
    "    parts.append(int(digits))",
    "raise SystemExit(0 if tuple(parts[:2]) >= (0, 8) else 2)",
].join("\n");

for (const [
    command,
    ...baseArgs
] of candidates) {
    const probe = await run(command, [
        ...baseArgs,
        "-c",
        probeLoguru,
    ]);
    if (probe === undefined) continue;

    let python = [
        command,
        ...baseArgs,
    ];
    if (probe === 1) {
        // Fresh CI / schema-sync has no loguru. Isolate the install so PEP 668 system Python
        // cannot block `pnpm check`. An already-installed 0.7 is left alone so FileSink tests red.
        const venv = mkdtempSync(join(tmpdir(), "cmp-py-tests-"));
        const venvCode = await run(command, [
            ...baseArgs,
            "-m",
            "venv",
            venv,
        ]);
        if (venvCode !== 0) {
            process.exitCode = venvCode ?? 1;
            process.exit();
        }
        python =
            process.platform === "win32"
                ? [
                      join(venv, "Scripts", "python.exe"),
                  ]
                : [
                      join(venv, "bin", "python"),
                  ];
        const pipCode = await run(python[0], [
            "-m",
            "pip",
            "install",
            "--quiet",
            "loguru>=0.8.0",
        ]);
        if (pipCode !== 0) {
            process.exitCode = pipCode ?? 1;
            process.exit();
        }
    } else if (probe === 2) {
        console.error(
            "loguru>=0.8.0 is required (record['template']). Refusing to upgrade an older install so the FileSink tests fail here instead of in a generated project.",
        );
    }

    const [
        interpreter,
        ...interpreterArgs
    ] = python;
    const code = await run(interpreter, [
        ...interpreterArgs,
        "-m",
        "unittest",
        "discover",
        "-s",
        "tests",
        "-p",
        "test_*.py",
    ]);
    process.exitCode = code;
    process.exit();
}

console.error("No Python interpreter found for PyPI wrapper tests.");
process.exitCode = 1;

function run(command, args) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            stdio: "inherit",
        });
        child.on("error", () => resolve(undefined));
        child.on("close", (code) => resolve(code ?? 1));
    });
}
