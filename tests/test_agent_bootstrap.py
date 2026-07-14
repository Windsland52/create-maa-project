from __future__ import annotations

import importlib.util
import multiprocessing
import tempfile
import time
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch


BOOTSTRAP_PATH = Path(__file__).resolve().parents[1] / "templates" / "agent" / "agent" / "bootstrap.py"
SPEC = importlib.util.spec_from_file_location("agent_bootstrap_template", BOOTSTRAP_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load Agent bootstrap template")
agent_bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent_bootstrap)


def acquire_requirements_lock_and_touch(project_root: str, touched_path: str) -> None:
    with agent_bootstrap.requirements_install_lock(Path(project_root), timeout_seconds=5.0):
        Path(touched_path).write_text("acquired\n", encoding="utf8")


class AgentBootstrapRequirementsTest(unittest.TestCase):
    def test_external_maafw_without_marker_does_not_skip_requirements(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            with patch.object(agent_bootstrap, "is_package_installed", return_value=True):
                with patch.object(agent_bootstrap, "is_running_in_project_venv", return_value=False):
                    self.assertTrue(agent_bootstrap.needs_requirement_install(project_root, "digest"))

    def test_matching_marker_skips_reinstall_when_maafw_is_available(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            marker = project_root / "debug" / agent_bootstrap.REQUIREMENTS_MARKER
            marker.parent.mkdir()
            marker.write_text("digest\n", encoding="utf8")

            with patch.object(agent_bootstrap, "is_package_installed", return_value=True):
                with patch.object(agent_bootstrap, "is_running_in_project_venv", return_value=False):
                    self.assertFalse(agent_bootstrap.needs_requirement_install(project_root, "digest"))

    def test_system_python_bin_is_not_treated_as_embedded(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            with patch.object(agent_bootstrap.sys, "executable", "/usr/bin/python3"):
                self.assertFalse(agent_bootstrap.is_running_in_embedded_python(project_root))

    def test_macos_packaged_python_path_is_treated_as_embedded(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            embedded_python = project_root / "python" / "bin" / "python3"
            with patch.object(agent_bootstrap.sys, "executable", str(embedded_python)):
                self.assertTrue(agent_bootstrap.is_running_in_embedded_python(project_root))

    def test_project_venv_marker_takes_priority_over_embedded_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            with patch.object(agent_bootstrap, "is_running_in_project_venv", return_value=True):
                with patch.object(agent_bootstrap, "is_running_in_embedded_python", return_value=True):
                    marker = agent_bootstrap.requirements_marker(project_root)

            self.assertEqual(marker, project_root / ".venv" / agent_bootstrap.REQUIREMENTS_MARKER)

    def test_waiting_installer_rechecks_marker_after_acquiring_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            requirements = project_root / "requirements.txt"
            requirements.write_text("maafw==1.0.0\n", encoding="utf8")

            with patch.object(agent_bootstrap, "requirements_install_lock", return_value=nullcontext()):
                with patch.object(agent_bootstrap, "needs_requirement_install", return_value=False):
                    with patch.object(agent_bootstrap, "install_from_local_wheels") as install_local:
                        with patch.object(agent_bootstrap, "install_from_indexes") as install_indexes:
                            agent_bootstrap.ensure_requirements_installed(project_root, requirements, "digest")

            install_local.assert_not_called()
            install_indexes.assert_not_called()

    def test_requirements_lock_retries_and_releases(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)

            with patch.object(agent_bootstrap, "try_lock_file", side_effect=[False, True]):
                with patch.object(agent_bootstrap, "unlock_file") as unlock:
                    with patch.object(agent_bootstrap.time, "monotonic", side_effect=[0.0, 0.0]):
                        with patch.object(agent_bootstrap.time, "sleep") as sleep:
                            with agent_bootstrap.requirements_install_lock(project_root, timeout_seconds=1.0):
                                pass

            sleep.assert_called_once_with(0.1)
            unlock.assert_called_once()

    def test_requirements_lock_timeout_stops_bootstrap(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)

            with patch.object(agent_bootstrap, "try_lock_file", return_value=False):
                with patch.object(agent_bootstrap.time, "monotonic", side_effect=[0.0, 2.0]):
                    with patch.object(agent_bootstrap, "warn") as warn:
                        with self.assertRaises(SystemExit):
                            with agent_bootstrap.requirements_install_lock(project_root, timeout_seconds=1.0):
                                pass

            warn.assert_called_once()

    def test_requirements_lock_serializes_processes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            touched_path = project_root / "second-process-acquired"
            process = multiprocessing.get_context("spawn").Process(
                target=acquire_requirements_lock_and_touch,
                args=(str(project_root), str(touched_path)),
            )

            with agent_bootstrap.requirements_install_lock(project_root, timeout_seconds=5.0):
                process.start()
                time.sleep(0.3)
                self.assertFalse(touched_path.exists())

            process.join(timeout=5.0)
            self.assertEqual(process.exitcode, 0)
            self.assertTrue(touched_path.exists())

    def test_requirements_marker_is_written_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            with patch.object(agent_bootstrap, "is_running_in_project_venv", return_value=False):
                with patch.object(agent_bootstrap, "is_running_in_embedded_python", return_value=False):
                    agent_bootstrap.write_requirements_marker(project_root, "digest")

            marker = project_root / "debug" / agent_bootstrap.REQUIREMENTS_MARKER
            self.assertEqual(marker.read_text(encoding="utf8"), "digest\n")
            self.assertFalse(marker.with_name(marker.name + ".tmp").exists())

    def test_empty_package_version_is_not_installed(self) -> None:
        with patch.object(agent_bootstrap.importlib.metadata, "version", return_value=None):
            self.assertFalse(agent_bootstrap.is_package_installed("maafw"))

    def test_empty_maafw_version_reports_invalid_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            with patch.object(agent_bootstrap.importlib.metadata, "version", return_value=None):
                with patch.object(agent_bootstrap, "warn") as warn:
                    agent_bootstrap.check_maafw(project_root)

            warn.assert_called_once_with(project_root, "Python package maafw has invalid or incomplete metadata")


if __name__ == "__main__":
    unittest.main()
