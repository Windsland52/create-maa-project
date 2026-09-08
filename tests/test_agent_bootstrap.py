from __future__ import annotations

import importlib.util
import multiprocessing
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


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
    def test_requirements_lock_path_prefers_project_venv(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            with patch.object(agent_bootstrap, "is_running_in_project_venv", return_value=True):
                lock_path = agent_bootstrap.requirements_lock_path(project_root)

            self.assertEqual(lock_path, project_root / ".venv" / agent_bootstrap.REQUIREMENTS_LOCK)

    def test_requirements_lock_path_falls_back_to_debug_dir(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            with patch.object(agent_bootstrap, "is_running_in_project_venv", return_value=False):
                lock_path = agent_bootstrap.requirements_lock_path(project_root)

            self.assertEqual(lock_path, project_root / "debug" / agent_bootstrap.REQUIREMENTS_LOCK)

    def test_ensure_requirements_installed_skips_index_fallback_when_local_wheels_succeed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            requirements = project_root / "requirements.txt"
            requirements.write_text("maafw==1.0.0\n", encoding="utf8")

            with patch.object(agent_bootstrap, "warn") as warn:
                with patch.object(agent_bootstrap, "install_from_local_wheels", return_value=True):
                    with patch.object(agent_bootstrap, "install_from_indexes") as install_indexes:
                        agent_bootstrap.ensure_requirements_installed(project_root, requirements)

            warn.assert_not_called()
            install_indexes.assert_not_called()

    def test_ensure_requirements_installed_warns_when_all_install_paths_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            requirements = project_root / "requirements.txt"
            requirements.write_text("maafw==1.0.0\n", encoding="utf8")

            with patch.object(agent_bootstrap, "warn") as warn:
                with patch.object(agent_bootstrap, "install_from_local_wheels", return_value=False):
                    with patch.object(agent_bootstrap, "install_from_indexes", return_value=False):
                        agent_bootstrap.ensure_requirements_installed(project_root, requirements)

            warn.assert_called_once_with(project_root, "Python dependencies were not installed successfully")

    def test_install_commands_have_no_upgrade_or_mirror_flags(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            requirements = project_root / "requirements.txt"
            requirements.write_text("maafw==1.0.0\n", encoding="utf8")
            deps_dir = project_root / "deps"
            deps_dir.mkdir()
            (deps_dir / "maafw-1.0.0-py3-none-any.whl").write_bytes(b"wheel")

            commands: list[list[str]] = []

            def record_run_pip(_project_root: Path, command: list[str], _label: str) -> bool:
                commands.append(command)
                return True

            with patch.object(agent_bootstrap, "run_pip", side_effect=record_run_pip):
                self.assertTrue(agent_bootstrap.install_from_local_wheels(project_root, requirements))
                self.assertTrue(agent_bootstrap.install_from_indexes(project_root, requirements))

        self.assertEqual(len(commands), 2)
        for command in commands:
            self.assertIn("--requirement", command)
            self.assertFalse({"-U", "-i", "--extra-index-url"} & set(command))
        self.assertIn("--no-index", commands[0])
        self.assertIn("--find-links", commands[0])

    def test_install_from_local_wheels_without_deps_dir_is_noop(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir)
            requirements = project_root / "requirements.txt"
            requirements.write_text("maafw==1.0.0\n", encoding="utf8")

            with patch.object(agent_bootstrap, "run_pip") as run_pip:
                self.assertFalse(agent_bootstrap.install_from_local_wheels(project_root, requirements))

            run_pip.assert_not_called()

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

    def test_find_compatible_python_skips_incompatible_versions(self) -> None:
        probes: list[list[str]] = []

        def fake_run(command: list[str], **_kwargs: object) -> Mock:
            probes.append(command)
            return Mock(returncode=0, stdout="Python 3.12.10", stderr="")

        with patch.object(agent_bootstrap.shutil, "which", return_value="/usr/bin/python3"):
            with patch.object(agent_bootstrap.subprocess, "run", side_effect=fake_run):
                self.assertIsNone(agent_bootstrap.find_compatible_python())

        self.assertTrue(probes)

    def test_find_compatible_python_returns_first_matching_candidate(self) -> None:
        def fake_run(_command: list[str], **_kwargs: object) -> Mock:
            return Mock(returncode=0, stdout="Python 3.13.5", stderr="")

        with patch.object(agent_bootstrap.shutil, "which", return_value="/usr/bin/python3.13"):
            with patch.object(agent_bootstrap.subprocess, "run", side_effect=fake_run):
                self.assertEqual(agent_bootstrap.find_compatible_python(), Path("/usr/bin/python3.13"))


if __name__ == "__main__":
    unittest.main()
