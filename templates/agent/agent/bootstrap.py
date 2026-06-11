from __future__ import annotations

import hashlib
import importlib.metadata
import json
import runpy
import sys
from datetime import datetime, timezone
from pathlib import Path

PYTHON_MIN = (3, 11)
PYTHON_MAX = (3, 14)
DEFAULT_PIP_CONFIG = {
    "enable_pip_install": True,
    "mirror": "https://pypi.tuna.tsinghua.edu.cn/simple",
    "backup_mirror": "https://mirrors.ustc.edu.cn/pypi/simple",
}


def main() -> None:
    project_root = find_project_root()
    log(project_root, "bootstrap started")
    if sys.version_info < PYTHON_MIN or sys.version_info >= PYTHON_MAX:
        log(project_root, "unsupported Python version: " + sys.version.split()[0])
        raise SystemExit("Python >=3.11,<3.14 is required")
    log(project_root, "Python " + sys.version.split()[0])
    check_requirements(project_root)
    ensure_runtime_config(project_root)
    check_maafw(project_root)
    runpy.run_path(str(Path(__file__).with_name("main.py")), run_name="__main__")


def find_project_root() -> Path:
    path = Path(__file__).resolve()
    if path.parent.name == "agent" and path.parent.parent.name == "python":
        return path.parent.parent.parent
    return path.parent.parent


def check_requirements(project_root: Path) -> None:
    requirements = find_requirements_file(project_root)
    if not requirements.exists():
        warn(project_root, "requirements.txt is missing; run create-maa-project --update python-deps")
        return
    digest = hashlib.sha256(requirements.read_bytes()).hexdigest()
    log(project_root, "requirements sha256=" + digest)


def find_requirements_file(project_root: Path) -> Path:
    packaged = project_root / "python" / "requirements.txt"
    if packaged.exists():
        return packaged
    return project_root / "requirements.txt"


def ensure_runtime_config(project_root: Path) -> None:
    config_dir = project_root / "config"
    config_path = config_dir / "pip_config.json"
    if config_path.exists():
        return
    try:
        config_dir.mkdir(parents=True, exist_ok=True)
        config_path.write_text(
            json.dumps(DEFAULT_PIP_CONFIG, indent=4, ensure_ascii=False) + "\n",
            encoding="utf8",
        )
        log(project_root, "created config/pip_config.json")
    except OSError as error:
        warn(project_root, "failed to create config/pip_config.json: " + str(error))


def check_maafw(project_root: Path) -> None:
    try:
        version = importlib.metadata.version("maafw")
    except importlib.metadata.PackageNotFoundError:
        warn(project_root, "Python package maafw is not installed; run uv sync for development")
        return
    log(project_root, "maafw " + version)


def warn(project_root: Path, message: str) -> None:
    log(project_root, "WARN " + message)
    print("[WARN] " + message, file=sys.stderr)


def log(project_root: Path, message: str) -> None:
    debug_dir = project_root / "debug"
    debug_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).isoformat()
    with (debug_dir / "agent-bootstrap.log").open("a", encoding="utf8") as handle:
        handle.write(f"{timestamp} {message}\n")


if __name__ == "__main__":
    main()
