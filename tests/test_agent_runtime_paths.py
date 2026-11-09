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

    def write(self, relative: str, content: str, mtime: int | None = None) -> pathlib.Path:
        path = self.project / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    def paths(self):
        return RUNTIME_PATHS.build_runtime_paths(project_root=self.project, work_root=self.work)

    def test_resolve_prefers_newer_work_file(self) -> None:
        self.write("data/activity/cn.json", "baseline", 1000)
        work_file = self.work / "data/activity/cn.json"
        work_file.parent.mkdir(parents=True)
        work_file.write_text("hot", encoding="utf-8")
        os.utime(work_file, (2000, 2000))

        self.assertEqual(self.paths().resolve("data/activity/cn.json"), work_file)

    def test_resolve_prefers_newer_project_baseline(self) -> None:
        baseline = self.write("data/activity/cn.json", "baseline", 2000)
        work_file = self.work / "data/activity/cn.json"
        work_file.parent.mkdir(parents=True)
        work_file.write_text("hot", encoding="utf-8")
        os.utime(work_file, (1000, 1000))

        self.assertEqual(self.paths().resolve("data/activity/cn.json"), baseline)

    def test_resolve_dir_prefers_work_directory(self) -> None:
        (self.project / "data/redeem_code").mkdir(parents=True)
        work_dir = self.work / "data/redeem_code"
        work_dir.mkdir(parents=True)

        self.assertEqual(self.paths().resolve_dir("data/redeem_code"), work_dir)

    def test_resolve_user_exists_wins_over_mtime(self) -> None:
        self.write("config/m9a_data.json", "baseline", 9000)
        user_file = self.work / "config/m9a_data.json"
        user_file.parent.mkdir(parents=True)
        user_file.write_text("user", encoding="utf-8")
        os.utime(user_file, (1000, 1000))

        self.assertEqual(self.paths().resolve_user("config/m9a_data.json"), user_file)
        self.assertEqual(self.paths().resolve_user("config/missing.json"), self.project / "config/missing.json")

    def test_seed_work_root_copies_baseline_and_keeps_user_config(self) -> None:
        self.write("data/a.json", "baseline", 1000)
        self.write("data/sub/b.json", "baseline", 1000)
        self.write("interface.json", "{}", 1000)
        self.write("config/hot_update.json", "{}", 1000)
        user_config = self.work / "config/m9a_data.json"
        user_config.parent.mkdir(parents=True)
        user_config.write_text("user", encoding="utf-8")
        os.utime(user_config, (500, 500))

        copied = RUNTIME_PATHS.seed_work_root(self.paths())

        self.assertGreaterEqual(copied, 3)
        self.assertTrue((self.work / "data/sub/b.json").is_file())
        self.assertTrue((self.work / "interface.json").is_file())
        self.assertTrue((self.work / "config/hot_update.json").is_file())
        self.assertEqual(user_config.read_text(encoding="utf-8"), "user")

    def test_seed_work_root_links_read_only_assets(self) -> None:
        self.write("resource/base/image/Warehouse/Item-1.png", "png", 1000)
        try:
            (self.work / "user_note.txt").write_text("user", encoding="utf-8")
        except OSError:
            self.skipTest("platform does not allow creating the test fixture")

        RUNTIME_PATHS.seed_work_root(self.paths())

        link = self.work / "resource"
        if not link.is_symlink():
            self.skipTest("platform does not allow creating symlinks")
        self.assertTrue((link / "base/image/Warehouse/Item-1.png").is_file())
        self.assertEqual(RUNTIME_PATHS._ensure_link(link, self.project / "resource"), 0)
        self.assertEqual(RUNTIME_PATHS._ensure_link(self.work / "user_note.txt", self.project / "resource"), 0)

    def test_seed_work_root_is_noop_for_identical_roots(self) -> None:
        paths = RUNTIME_PATHS.build_runtime_paths(project_root=self.project, work_root=self.project)

        self.assertEqual(RUNTIME_PATHS.seed_work_root(paths), 0)


if __name__ == "__main__":
    unittest.main()
