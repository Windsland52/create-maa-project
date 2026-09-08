from __future__ import annotations

import errno
import re
import runpy
import shutil
import subprocess
import sys
import time
from collections.abc import Generator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import BinaryIO

PYTHON_MIN = (3, 13)
PYTHON_MAX = (3, 14)
VENV_NAME = ".venv"
REQUIREMENTS_LOCK = ".create-maa-project-requirements.lock"
REQUIREMENTS_LOCK_TIMEOUT_SECONDS = 300.0


def main() -> None:
    project_root = find_project_root()
    log(project_root, "bootstrap started")
    if should_use_linux_project_venv():
        ensure_venv_and_relaunch(project_root)
    if sys.version_info < PYTHON_MIN or sys.version_info >= PYTHON_MAX:
        log(project_root, "unsupported Python version: " + sys.version.split()[0])
        raise SystemExit("Python >=3.13,<3.14 is required")
    log(project_root, "Python " + sys.version.split()[0])
    requirements = check_requirements(project_root)
    if requirements is not None:
        ensure_requirements_installed(project_root, requirements)
    runpy.run_path(str(Path(__file__).with_name("main.py")), run_name="__main__")


def find_project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def should_use_linux_project_venv() -> bool:
    return sys.platform.startswith("linux") and not is_running_in_venv()


def is_running_in_venv() -> bool:
    return sys.prefix != sys.base_prefix


def is_running_in_project_venv(project_root: Path) -> bool:
    if not is_running_in_venv():
        return False
    try:
        return Path(sys.prefix).resolve() == venv_dir(project_root).resolve()
    except OSError:
        return False


def venv_dir(project_root: Path) -> Path:
    return project_root / VENV_NAME


def ensure_venv_and_relaunch(project_root: Path) -> None:
    if sys.version_info >= PYTHON_MIN and sys.version_info < PYTHON_MAX:
        python_exe = Path(sys.executable)
    else:
        python_exe = find_compatible_python()
        if python_exe is None:
            warn(project_root, "Python >=3.13,<3.14 is required but no compatible version was found")
            raise SystemExit(1)

    target_venv = venv_dir(project_root)
    if not target_venv.exists():
        log(project_root, "creating virtual environment: " + str(target_venv))
        try:
            subprocess.run(
                [str(python_exe), "-m", "venv", str(target_venv)],
                check=True,
                capture_output=True,
                text=True,
                encoding="utf8",
                errors="replace",
            )
        except subprocess.CalledProcessError as error:
            warn(project_root, "failed to create .venv: " + command_output(error))
            raise SystemExit(1) from error

    python = venv_python(target_venv)
    if not python.exists():
        warn(project_root, "Python executable is missing in .venv: " + str(python))
        raise SystemExit(1)

    try:
        result = subprocess.run(
            [str(python), "--version"],
            capture_output=True,
            text=True,
            encoding="utf8",
            errors="replace",
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        warn(project_root, "failed to check venv Python version: " + str(error))
        raise SystemExit(1) from error

    if result.returncode != 0:
        warn(project_root, "venv Python is not working: " + (result.stderr or "unknown error"))
        raise SystemExit(1)

    try:
        parts = result.stdout.strip().split()[1].split(".")
        major, minor = int(parts[0]), int(parts[1])
    except (IndexError, ValueError):
        warn(project_root, "unexpected venv Python version output: " + result.stdout.strip())
        raise SystemExit(1) from None

    if (major, minor) < PYTHON_MIN or (major, minor) >= PYTHON_MAX:
        warn(
            project_root,
            f"venv Python is {result.stdout.strip()}, but Python >=3.13,<3.14 is required. "
            "This usually happens when the .venv was created with an older Python version. "
            "Delete .venv and run again:\n"
            "    rm -rf .venv\n"
            "    python3.13 agent/bootstrap.py",
        )
        raise SystemExit(1)

    log(project_root, "relaunching with virtual environment Python: " + str(python))
    result = subprocess.run(
        [str(python), str(Path(__file__).resolve()), *sys.argv[1:]],
        cwd=str(project_root),
        check=False,
    )
    raise SystemExit(result.returncode)


def venv_python(target_venv: Path) -> Path:
    if sys.platform.startswith("win"):
        return target_venv / "Scripts" / "python.exe"
    python3 = target_venv / "bin" / "python3"
    if python3.exists():
        return python3
    return target_venv / "bin" / "python"


def check_requirements(project_root: Path) -> Path | None:
    requirements = project_root / "requirements.txt"
    if not requirements.exists():
        warn(
            project_root,
            "requirements.txt is missing; run create-maa-project --update python-deps",
        )
        return None
    return requirements


def ensure_requirements_installed(project_root: Path, requirements: Path) -> None:
    with requirements_install_lock(project_root):
        # Requirements are fully pinned, so pip is a no-op when everything is
        # already installed; no marker recheck is needed after waiting for the lock.
        if install_from_local_wheels(project_root, requirements) or install_from_indexes(
            project_root,
            requirements,
        ):
            return
        warn(project_root, "Python dependencies were not installed successfully")


def requirements_lock_path(project_root: Path) -> Path:
    if is_running_in_project_venv(project_root):
        return venv_dir(project_root) / REQUIREMENTS_LOCK
    return project_root / "debug" / REQUIREMENTS_LOCK


@contextmanager
def requirements_install_lock(
    project_root: Path,
    timeout_seconds: float = REQUIREMENTS_LOCK_TIMEOUT_SECONDS,
) -> Generator[None]:
    lock_path = requirements_lock_path(project_root)
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        handle = lock_path.open("a+b")
    except OSError as error:
        warn(project_root, "failed to open Python requirements install lock: " + str(error))
        raise SystemExit(1) from error

    with handle:
        try:
            ensure_lock_file_byte(handle)
        except OSError as error:
            warn(project_root, "failed to initialize Python requirements install lock: " + str(error))
            raise SystemExit(1) from error

        deadline = time.monotonic() + timeout_seconds
        waiting_logged = False
        while True:
            try:
                acquired = try_lock_file(handle)
            except OSError as error:
                warn(project_root, "failed to acquire Python requirements install lock: " + str(error))
                raise SystemExit(1) from error
            if acquired:
                break
            if not waiting_logged:
                log(project_root, "waiting for Python requirements install lock: " + str(lock_path))
                waiting_logged = True
            if time.monotonic() >= deadline:
                warn(project_root, "timed out waiting for Python requirements install lock: " + str(lock_path))
                raise SystemExit(1)
            time.sleep(0.1)

        log(project_root, "acquired Python requirements install lock: " + str(lock_path))
        try:
            yield
        finally:
            try:
                unlock_file(handle)
            except OSError as error:
                warn(project_root, "failed to release Python requirements install lock: " + str(error))


def ensure_lock_file_byte(handle: BinaryIO) -> None:
    handle.seek(0, 2)
    if handle.tell() == 0:
        handle.write(b"\0")
        handle.flush()
    handle.seek(0)


def try_lock_file(handle: BinaryIO) -> bool:
    handle.seek(0)
    try:
        if sys.platform.startswith("win"):
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EAGAIN):
            return False
        raise
    return True


def unlock_file(handle: BinaryIO) -> None:
    handle.seek(0)
    if sys.platform.startswith("win"):
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def install_from_local_wheels(project_root: Path, requirements: Path) -> bool:
    deps_dir = project_root / "deps"
    if not deps_dir.exists() or not any(deps_dir.glob("*.whl")):
        log(project_root, "local deps wheels are not present")
        return False
    return run_pip(
        project_root,
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--no-warn-script-location",
            "--requirement",
            str(requirements),
            "--find-links",
            str(deps_dir),
            "--no-index",
        ],
        "installing Python dependencies from local wheels",
    )


def install_from_indexes(project_root: Path, requirements: Path) -> bool:
    return run_pip(
        project_root,
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--no-warn-script-location",
            "--requirement",
            str(requirements),
        ],
        "installing Python dependencies from indexes",
    )


def run_pip(project_root: Path, command: list[str], label: str) -> bool:
    log(project_root, label + ": " + " ".join(command))
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf8",
            errors="replace",
        )
    except OSError as error:
        warn(project_root, label + " failed: " + str(error))
        return False

    if result.stdout.strip():
        log(project_root, label + " stdout:\n" + result.stdout.strip())
    if result.stderr.strip():
        log(project_root, label + " stderr:\n" + result.stderr.strip())
    if result.returncode != 0:
        warn(project_root, label + f" failed with exit code {result.returncode}")
        return False
    log(project_root, label + " completed")
    return True


def command_output(error: subprocess.CalledProcessError) -> str:
    output = []
    if error.stdout:
        output.append(str(error.stdout).strip())
    if error.stderr:
        output.append(str(error.stderr).strip())
    return "\n".join(item for item in output if item) or str(error)


def warn(project_root: Path, message: str) -> None:
    log(project_root, "WARN " + message)
    print("[WARN] " + message, file=sys.stderr)


def log(project_root: Path, message: str) -> None:
    debug_dir = project_root / "debug"
    debug_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).isoformat()
    with (debug_dir / "agent-bootstrap.log").open("a", encoding="utf8") as handle:
        handle.write(f"{timestamp} {message}\n")


def find_compatible_python() -> Path | None:
    candidates = (
        "python3.13",
        "python313",
        "python3",
        "python",
        "/usr/local/bin/python3.13",
        "/usr/bin/python3.13",
    )
    for candidate in candidates:
        path = shutil.which(candidate)
        if path is None:
            continue
        try:
            result = subprocess.run(
                [path, "--version"],
                capture_output=True,
                text=True,
                encoding="utf8",
                errors="replace",
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        version_str = (result.stdout or result.stderr).strip()
        m = re.search(r"(\d+)\.(\d+)", version_str)
        if m:
            major, minor = int(m.group(1)), int(m.group(2))
            if (major, minor) >= PYTHON_MIN and (major, minor) < PYTHON_MAX:
                return Path(path)
    return None


if __name__ == "__main__":
    main()
