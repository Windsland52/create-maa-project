from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py-wrapper"))

import create_maa_project.__main__ as wrapper_main  # noqa: E402
from create_maa_project import __version__  # noqa: E402
from create_maa_project.__main__ import (  # noqa: E402
    execution_failure_message,
    fallback_message,
    manifest_version,
    parse_manifest,
    select_asset,
    validate_manifest_version,
)


class PyWrapperTrustChainTest(unittest.TestCase):
    def test_fallback_message_points_to_manual_npx_or_source(self) -> None:
        message = fallback_message(RuntimeError("offline"))

        self.assertIn("offline", message)
        self.assertIn("npx create-maa-project", message)
        self.assertIn("TypeScript CLI from source", message)
        self.assertIn("does not install Node.js or invoke npx automatically", message)

    def test_main_does_not_invoke_npx_when_binary_resolution_fails(self) -> None:
        with patch.object(wrapper_main, "ensure_binary", side_effect=RuntimeError("offline")):
            with patch.object(wrapper_main.subprocess, "call") as subprocess_call:
                with self.assertRaises(SystemExit) as raised:
                    wrapper_main.main()

        self.assertIn("npx create-maa-project", str(raised.exception))
        subprocess_call.assert_not_called()

    def test_execution_failure_message_includes_windows_guidance(self) -> None:
        message = execution_failure_message(
            Path("C:/Users/test/.cache/create-maa-project/create-maa-project.exe"),
            OSError("blocked"),
            system_name="Windows",
        )

        self.assertIn("Unable to run downloaded create-maa-project binary", message)
        self.assertIn("PowerShell execution policy", message)
        self.assertIn("uvx or pipx is available on PATH", message)
        self.assertIn("unblock the downloaded .exe", message)
        self.assertIn("does not modify PowerShell execution policy", message)

    def test_main_reports_binary_execution_failure(self) -> None:
        binary = Path("/tmp/create-maa-project")
        with patch.object(wrapper_main, "ensure_binary", return_value=binary):
            with patch.object(wrapper_main.subprocess, "call", side_effect=OSError("not executable")):
                with self.assertRaises(SystemExit) as raised:
                    wrapper_main.main()

        message = str(raised.exception)
        self.assertIn(str(binary), message)
        self.assertIn("not executable", message)
        self.assertIn("npx create-maa-project", message)

    def test_ensure_binary_reports_asset_download_failure(self) -> None:
        manifest_bytes = json.dumps(
            {
                "version": __version__,
                "assets": [
                    {
                        "kind": "sea",
                        "os": "linux",
                        "arch": "x86_64",
                        "version": __version__,
                        "url": "https://example.test/create-maa-project-linux-x64",
                        "sha256": "b" * 64,
                    }
                ],
            },
            sort_keys=True,
        ).encode()
        manifest_digest = hashlib.sha256(manifest_bytes).hexdigest()

        with tempfile.TemporaryDirectory() as cache_dir:
            with patch.dict(wrapper_main.os.environ, {"CREATE_MAA_PROJECT_CACHE": cache_dir}):
                with patch.object(wrapper_main, "RELEASE_MANIFEST_SHA256", manifest_digest):
                    with patch.object(wrapper_main.platform, "system", return_value="Linux"):
                        with patch.object(wrapper_main.platform, "machine", return_value="x86_64"):
                            with patch.object(
                                wrapper_main,
                                "download",
                                side_effect=[manifest_bytes, OSError("offline")],
                            ) as download:
                                with self.assertRaisesRegex(
                                    RuntimeError,
                                    "Unable to download create-maa-project binary asset",
                                ):
                                    wrapper_main.ensure_binary()

        self.assertEqual(download.call_count, 2)

    def test_ensure_binary_reuses_verified_cached_binary_without_download(self) -> None:
        binary_bytes = b"cached create-maa-project binary"

        with tempfile.TemporaryDirectory() as cache_dir:
            with patch.dict(wrapper_main.os.environ, {"CREATE_MAA_PROJECT_CACHE": cache_dir}):
                with patch.object(wrapper_main.platform, "system", return_value="Linux"):
                    target = Path(cache_dir) / __version__ / "create-maa-project"
                    target.parent.mkdir(parents=True)
                    target.write_bytes(binary_bytes)
                    wrapper_main.binary_digest_path(target).write_text(
                        f"{hashlib.sha256(binary_bytes).hexdigest()}\n",
                        encoding="utf8",
                    )

                    with patch.object(wrapper_main, "download") as download:
                        self.assertEqual(wrapper_main.ensure_binary(), target)

        download.assert_not_called()

    def test_ensure_binary_redownloads_unverified_cached_binary(self) -> None:
        binary_bytes = b"fresh create-maa-project binary"
        binary_digest = hashlib.sha256(binary_bytes).hexdigest()
        manifest_bytes = json.dumps(
            {
                "version": __version__,
                "assets": [
                    {
                        "kind": "sea",
                        "os": "linux",
                        "arch": "x86_64",
                        "version": __version__,
                        "url": "https://example.test/create-maa-project-linux-x64",
                        "sha256": binary_digest,
                    }
                ],
            },
            sort_keys=True,
        ).encode()
        manifest_digest = hashlib.sha256(manifest_bytes).hexdigest()

        with tempfile.TemporaryDirectory() as cache_dir:
            with patch.dict(wrapper_main.os.environ, {"CREATE_MAA_PROJECT_CACHE": cache_dir}):
                with patch.object(wrapper_main, "RELEASE_MANIFEST_SHA256", manifest_digest):
                    with patch.object(wrapper_main.platform, "system", return_value="Linux"):
                        with patch.object(wrapper_main.platform, "machine", return_value="x86_64"):
                            target = Path(cache_dir) / __version__ / "create-maa-project"
                            target.parent.mkdir(parents=True)
                            target.write_bytes(b"stale binary")
                            wrapper_main.binary_digest_path(target).write_text("not-a-sha256\n", encoding="utf8")

                            with patch.object(
                                wrapper_main,
                                "download",
                                side_effect=[manifest_bytes, binary_bytes],
                            ) as download:
                                self.assertEqual(wrapper_main.ensure_binary(), target)

                            self.assertEqual(target.read_bytes(), binary_bytes)
                            self.assertEqual(
                                wrapper_main.binary_digest_path(target).read_text(encoding="utf8").strip(),
                                binary_digest,
                            )

        self.assertEqual(download.call_count, 2)

    def test_parse_manifest_requires_json_object(self) -> None:
        self.assertEqual(parse_manifest(b'{"version":"v0.1.0","assets":[]}')["version"], "v0.1.0")

        with self.assertRaisesRegex(RuntimeError, "not valid JSON"):
            parse_manifest(b"{")
        with self.assertRaisesRegex(RuntimeError, "must be a JSON object"):
            parse_manifest(b"[]")

    def test_manifest_version_normalizes_v_prefix(self) -> None:
        self.assertEqual(manifest_version({"version": "v0.1.0"}), "0.1.0")
        self.assertEqual(manifest_version({"tag": "0.1.0"}), "0.1.0")
        self.assertEqual(manifest_version({}), "")

    def test_validate_manifest_version_matches_wrapper_version(self) -> None:
        validate_manifest_version({"version": __version__})

        with self.assertRaisesRegex(RuntimeError, "does not match PyPI wrapper version"):
            validate_manifest_version({"version": "9.9.9"})

    def test_select_asset_requires_matching_platform_and_asset_version(self) -> None:
        manifest = {
            "version": __version__,
            "assets": [
                {
                    "kind": "sea",
                    "os": "linux",
                    "arch": "x86_64",
                    "version": __version__,
                    "url": "https://example.test/create-maa-project",
                    "sha256": "a" * 64,
                }
            ],
        }

        self.assertEqual(
            select_asset(manifest, system_name="Linux", machine_name="x86_64"),
            {
                "url": "https://example.test/create-maa-project",
                "sha256": "a" * 64,
            },
        )

        bad_asset_manifest = json.loads(json.dumps(manifest))
        bad_asset_manifest["assets"][0]["version"] = "9.9.9"
        with self.assertRaisesRegex(RuntimeError, "CLI binary asset version"):
            select_asset(bad_asset_manifest, system_name="Linux", machine_name="x86_64")

        with self.assertRaisesRegex(RuntimeError, "No CLI binary is available"):
            select_asset(manifest, system_name="Darwin", machine_name="x86_64")

    def test_select_asset_validates_asset_url_and_digest(self) -> None:
        manifest = {
            "version": __version__,
            "assets": [
                {
                    "kind": "sea",
                    "os": "linux",
                    "arch": "x86_64",
                    "version": __version__,
                    "url": "https://example.test/create-maa-project",
                    "sha256": "a" * 64,
                }
            ],
        }

        missing_url_manifest = json.loads(json.dumps(manifest))
        del missing_url_manifest["assets"][0]["url"]
        with self.assertRaisesRegex(RuntimeError, "non-empty url"):
            select_asset(missing_url_manifest, system_name="Linux", machine_name="x86_64")

        bad_url_manifest = json.loads(json.dumps(manifest))
        bad_url_manifest["assets"][0]["url"] = "http://example.test/create-maa-project"
        with self.assertRaisesRegex(RuntimeError, "https URL"):
            select_asset(bad_url_manifest, system_name="Linux", machine_name="x86_64")

        bad_digest_manifest = json.loads(json.dumps(manifest))
        bad_digest_manifest["assets"][0]["sha256"] = "abc"
        with self.assertRaisesRegex(RuntimeError, "64-character sha256"):
            select_asset(bad_digest_manifest, system_name="Linux", machine_name="x86_64")


if __name__ == "__main__":
    unittest.main()
