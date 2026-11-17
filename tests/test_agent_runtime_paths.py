import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "templates" / "agent" / "agent" / "utils" / "runtime_paths.py"
SPEC = importlib.util.spec_from_file_location("agent_runtime_paths_under_test", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
RUNTIME_PATHS = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RUNTIME_PATHS
SPEC.loader.exec_module(RUNTIME_PATHS)


class RuntimePathsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp_dir.name)
        self.project = self.root / "project"
        self.work = self.root / "work"
        self.project.mkdir()
        self.work.mkdir()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write(self, relative: str, content: str) -> pathlib.Path:
        path = self.project / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def paths(self):
        return RUNTIME_PATHS.build_runtime_paths(project_root=self.project, work_root=self.work)

    def test_resolve_reads_project_root(self) -> None:
        baseline = self.write("resource/pipeline/foo.json", "baseline")
        work_file = self.work / "resource/pipeline/foo.json"
        work_file.parent.mkdir(parents=True)
        work_file.write_text("overlay", encoding="utf-8")

        self.assertEqual(self.paths().resolve("resource/pipeline/foo.json"), baseline)

    def test_package_dirs_stay_inside_project_root(self) -> None:
        paths = self.paths()
        self.assertEqual(paths.resource_dir, self.project / "resource")
        self.assertEqual(paths.interface_file, self.project / "interface.json")
        self.assertEqual(paths.config_dir, self.work / "config")
        self.assertEqual(paths.debug_dir, self.work / "debug")

    def test_link_work_root_does_not_link_config_or_debug(self) -> None:
        self.write("config/template.json", "template")
        self.write("debug/custom/old.log", "log")
        user_config = self.work / "config/user.json"
        user_config.parent.mkdir(parents=True)
        user_config.write_text("keep", encoding="utf-8")

        RUNTIME_PATHS.link_work_root(self.paths())

        self.assertFalse((self.work / "config").is_symlink())
        self.assertFalse((self.work / "debug").is_symlink())
        self.assertEqual(user_config.read_text(encoding="utf-8"), "keep")
        self.assertFalse((self.work / "config/template.json").exists())

    def test_link_work_root_links_read_only_assets(self) -> None:
        self.write("resource/image/Item-1.png", "png")
        self.write("interface.json", "{}")
        try:
            (self.work / "user_note.txt").write_text("user", encoding="utf-8")
        except OSError:
            self.skipTest("platform does not allow creating the test fixture")

        RUNTIME_PATHS.link_work_root(self.paths())

        link = self.work / "resource"
        if not link.is_symlink():
            self.skipTest("platform does not allow creating symlinks")
        self.assertTrue((link / "image/Item-1.png").is_file())
        self.assertTrue((self.work / "interface.json").is_symlink())
        self.assertEqual(RUNTIME_PATHS._ensure_link(link, self.project / "resource"), 0)
        self.assertEqual(RUNTIME_PATHS._ensure_link(self.work / "user_note.txt", self.project / "resource"), 0)

    def test_link_work_root_is_noop_for_identical_roots(self) -> None:
        paths = RUNTIME_PATHS.build_runtime_paths(project_root=self.project, work_root=self.project)

        self.assertEqual(RUNTIME_PATHS.link_work_root(paths), 0)

    def test_link_work_root_skips_a_project_local_work_root(self) -> None:
        work_root = self.project / "userdata"
        work_root.mkdir()
        self.write("resource/image/Item-1.png", "png")
        paths = RUNTIME_PATHS.build_runtime_paths(project_root=self.project, work_root=work_root)

        RUNTIME_PATHS.link_work_root(paths)

        self.assertFalse((work_root / "userdata").exists())
        link = work_root / "resource"
        if not link.is_symlink():
            self.skipTest("platform does not allow creating symlinks")
        self.assertTrue((link / "image/Item-1.png").is_file())

    def test_default_work_root_resolves_a_relative_env(self) -> None:
        previous = os.environ.get("PI_USER_DATA_DIR")
        previous_cwd = os.getcwd()
        os.chdir(self.root)
        os.environ["PI_USER_DATA_DIR"] = "userdata"
        try:
            self.assertEqual(RUNTIME_PATHS.default_work_root(), (self.root / "userdata").resolve())
        finally:
            os.chdir(previous_cwd)
            if previous is None:
                os.environ.pop("PI_USER_DATA_DIR", None)
            else:
                os.environ["PI_USER_DATA_DIR"] = previous


if __name__ == "__main__":
    unittest.main()
