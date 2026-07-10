from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


BOOTSTRAP_PATH = Path(__file__).resolve().parents[1] / "templates" / "agent" / "agent" / "bootstrap.py"
SPEC = importlib.util.spec_from_file_location("agent_bootstrap_template", BOOTSTRAP_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load Agent bootstrap template")
agent_bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent_bootstrap)


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


if __name__ == "__main__":
    unittest.main()
