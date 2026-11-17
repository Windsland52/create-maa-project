import logging
import os
import pathlib
import sys
import tempfile
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
UTILS_DIR = ROOT / "templates" / "agent" / "agent" / "utils"

# logger.py 在 import 时就会 setup_logger()；把数据目录指到临时路径，避免在仓库根写下 debug/。
_LOG_ROOT = tempfile.TemporaryDirectory()
_PREVIOUS_USER_DATA = os.environ.get("PI_USER_DATA_DIR")
os.environ["PI_USER_DATA_DIR"] = _LOG_ROOT.name

_utils_pkg = types.ModuleType("utils")
_utils_pkg.__path__ = [str(UTILS_DIR)]
_utils_pkg.__package__ = "utils"
sys.modules.setdefault("utils", _utils_pkg)

from utils.logger import _BraceFormatLogger, _std_logger  # noqa: E402

for _handler in list(_std_logger.handlers):
    _handler.close()
    _std_logger.removeHandler(_handler)

if _PREVIOUS_USER_DATA is None:
    os.environ.pop("PI_USER_DATA_DIR", None)
else:
    os.environ["PI_USER_DATA_DIR"] = _PREVIOUS_USER_DATA


class _ListHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


class BraceFormatLoggerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.handler = _ListHandler()
        wrapped = logging.getLogger("brace-format-under-test")
        wrapped.handlers.clear()
        wrapped.propagate = False
        wrapped.setLevel(logging.DEBUG)
        wrapped.addHandler(self.handler)
        self.logger = _BraceFormatLogger(wrapped)

    def test_percent_placeholders_reach_stdlib(self) -> None:
        self.logger.error("DisableNode: %s", "missing")

        self.assertEqual(self.handler.records[0].getMessage(), "DisableNode: missing")

    def test_brace_placeholders_still_expand(self) -> None:
        self.logger.debug("{}={}", "key", "value")

        self.assertEqual(self.handler.records[0].getMessage(), "key=value")


if __name__ == "__main__":
    unittest.main()
