from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import sys
import urllib.request
from urllib.parse import urlparse
from pathlib import Path
from typing import Optional

from . import __version__
from .release_manifest import RELEASE_MANIFEST_SHA256

RELEASE_REPOSITORY = "Windsland52/create-maa-project"


def main() -> None:
    try:
        binary = ensure_binary()
    except RuntimeError as error:
        raise SystemExit(fallback_message(error))

    try:
        raise SystemExit(subprocess.call([str(binary), *sys.argv[1:]]))
    except OSError as error:
        raise SystemExit(execution_failure_message(binary, error))


def fallback_message(error: RuntimeError) -> str:
    return (
        f"{error}\n"
        "Install Node.js and run `npx create-maa-project`, or run the TypeScript CLI from source. "
        "The PyPI wrapper does not install Node.js or invoke npx automatically."
    )


def execution_failure_message(
    binary: Path,
    error: OSError,
    system_name: Optional[str] = None,
) -> str:
    message = [
        f"Unable to run downloaded create-maa-project binary at {binary}: {error}",
        "Check that the cached binary is executable and has not been blocked by the operating system.",
    ]
    if (system_name or platform.system()) == "Windows":
        message.extend(
            [
                "On Windows, check the PowerShell execution policy used by your shell, "
                "confirm uvx or pipx is available on PATH if you launched through it, "
                "and unblock the downloaded .exe if Windows marked it as downloaded from the Internet.",
                "The PyPI wrapper does not modify PowerShell execution policy.",
            ]
        )
    message.append("You can also install Node.js and run `npx create-maa-project`, or run the TypeScript CLI from source.")
    return "\n".join(message)


def ensure_binary() -> Path:
    cache_dir = Path(os.getenv("CREATE_MAA_PROJECT_CACHE", Path.home() / ".cache" / "create-maa-project"))
    target = cache_dir / __version__ / binary_name()
    if cached_binary_is_valid(target):
        return target
    if not RELEASE_MANIFEST_SHA256:
        raise RuntimeError(
            "PyPI wrapper is missing the trusted CLI release manifest digest. "
            "Install Node.js and run `npx create-maa-project`, or use an official release wheel."
        )

    manifest_url = (
        f"https://github.com/{RELEASE_REPOSITORY}/releases/download/v{__version__}/"
        "create-maa-project-manifest.json"
    )
    try:
        manifest_bytes = download(manifest_url)
    except OSError as error:
        raise RuntimeError(
            "Unable to download create-maa-project binary. Install Node.js and run "
            "`npx create-maa-project`, or retry with network access."
        ) from error

    digest = hashlib.sha256(manifest_bytes).hexdigest()
    if digest != RELEASE_MANIFEST_SHA256:
        raise RuntimeError("Downloaded CLI release manifest failed sha256 verification.")

    manifest = parse_manifest(manifest_bytes)
    validate_manifest_version(manifest)
    asset = select_asset(manifest)
    try:
        binary_bytes = download(asset["url"])
    except OSError as error:
        raise RuntimeError(
            "Unable to download create-maa-project binary asset. Retry with network access."
        ) from error
    binary_digest = hashlib.sha256(binary_bytes).hexdigest()
    if binary_digest != asset["sha256"]:
        raise RuntimeError("Downloaded CLI binary failed sha256 verification.")

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(binary_bytes)
    binary_digest_path(target).write_text(f"{binary_digest}\n", encoding="utf8")
    target.chmod(0o755)
    return target


def cached_binary_is_valid(target: Path) -> bool:
    if not target.exists():
        return False
    digest_path = binary_digest_path(target)
    if not digest_path.exists():
        return False
    try:
        expected_digest = digest_path.read_text(encoding="utf8").strip()
        actual_digest = hashlib.sha256(target.read_bytes()).hexdigest()
    except OSError:
        return False
    try:
        validate_sha256(expected_digest)
    except RuntimeError:
        return False
    return actual_digest == expected_digest


def binary_digest_path(target: Path) -> Path:
    return target.with_name(f"{target.name}.sha256")


def binary_name() -> str:
    suffix = ".exe" if platform.system() == "Windows" else ""
    return f"create-maa-project{suffix}"


def parse_manifest(manifest_bytes: bytes) -> dict[str, object]:
    try:
        manifest = json.loads(manifest_bytes)
    except json.JSONDecodeError as error:
        raise RuntimeError("Downloaded CLI release manifest is not valid JSON.") from error
    if not isinstance(manifest, dict):
        raise RuntimeError("Downloaded CLI release manifest must be a JSON object.")
    return manifest


def validate_manifest_version(manifest: dict[str, object]) -> None:
    version = manifest_version(manifest)
    if version != __version__:
        raise RuntimeError(
            f"CLI release manifest version {version or '<missing>'} does not match "
            f"PyPI wrapper version {__version__}."
        )


def select_asset(
    manifest: dict[str, object],
    system_name: Optional[str] = None,
    machine_name: Optional[str] = None,
) -> dict[str, str]:
    validate_manifest_version(manifest)
    system = {"Windows": "win", "Linux": "linux", "Darwin": "macos"}.get(system_name or platform.system())
    machine = (machine_name or platform.machine()).lower()
    arch = "aarch64" if machine in {"arm64", "aarch64"} else "x86_64"
    for asset in manifest.get("assets", []):
        if not isinstance(asset, dict):
            continue
        if asset.get("os") == system and asset.get("arch") == arch and asset.get("kind") == "sea":
            asset_version = manifest_version(asset)
            if asset_version != __version__:
                raise RuntimeError(
                    f"CLI binary asset version {asset_version or '<missing>'} does not match "
                    f"PyPI wrapper version {__version__}."
                )
            url = asset_string(asset, "url")
            sha256 = asset_string(asset, "sha256")
            validate_asset_url(url)
            validate_sha256(sha256)
            return {
                "url": url,
                "sha256": sha256,
            }
    raise RuntimeError(f"No CLI binary is available for {system}/{arch}.")


def manifest_version(manifest: dict[str, object]) -> str:
    for key in ("version", "tag"):
        value = manifest.get(key)
        if isinstance(value, str) and value:
            return value[1:] if value.startswith("v") else value
    return ""


def asset_string(asset: dict[str, object], key: str) -> str:
    value = asset.get(key)
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"CLI binary asset must include a non-empty {key}.")
    return value


def validate_asset_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise RuntimeError("CLI binary asset must include an https URL.")


def validate_sha256(value: str) -> None:
    if len(value) != 64 or any(char not in "0123456789abcdefABCDEF" for char in value):
        raise RuntimeError("CLI binary asset must include a 64-character sha256 digest.")


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": f"create-maa-project/{__version__}"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


if __name__ == "__main__":
    main()
