import io
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

from utils.logger import _BraceFormatLogger, _enrich_file_template, _std_logger  # noqa: E402

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


def _loguru_logger():
    # 顶层不 import：无 loguru 时 BraceFormat 回退路径仍要能跑；FileSink 用例自己炸。
    from loguru import logger as loguru_logger

    return loguru_logger


def _file_log_record(message: str, *args: object):
    """走 loguru 0.8 真实路径取 record，再喂给文件 sink 的 template filter 与 format。"""
    loguru_logger = _loguru_logger()
    records = []

    def sink(msg) -> None:
        records.append(msg.record)

    sink_id = loguru_logger.add(sink, format="{message}")
    try:
        loguru_logger.debug(message, *args)
    finally:
        loguru_logger.remove(sink_id)
    return records[0]


class FileSinkLoguruTest(unittest.TestCase):
    def test_loguru_record_exposes_unformatted_template(self) -> None:
        """0.7 没有 record['template']：这条必须红，不能等用户跑 Agent 才 KeyError。"""
        record = _file_log_record("{}={}", "key", "value")
        self.assertIn("template", record)
        self.assertEqual(record["template"], "{}={}")

    def test_file_sink_template_field_tracks_brace_call_sites(self) -> None:
        """有占位符时文件日志应附 template（同一调用点不同参数聚成一条的关键）。"""
        record = _file_log_record("{}={}", "key", "value")
        _enrich_file_template(record)
        self.assertEqual(record["extra"]["template"], " | tpl={}={}")

    def test_file_sink_template_field_blank_when_no_placeholders(self) -> None:
        """无占位符时 message 即 template，按 message 聚合等价，附字段留空省一格。"""
        record = _file_log_record("plain literal")
        _enrich_file_template(record)
        self.assertEqual(record["extra"]["template"], "")

    def test_file_sink_format_appends_timezone_and_template(self) -> None:
        """文件 sink 的 format 必须带时区偏移（跨时区排查不用猜）+ template 字段。"""
        buf = io.StringIO()
        loguru_logger = _loguru_logger()
        sink_id = loguru_logger.add(
            buf,
            format="{time:YYYY-MM-DD HH:mm:ss.SSSZ} | {level: <8} | {name}:{function}:{line} | {message}{extra[template]}",
            filter=_enrich_file_template,
        )
        try:
            loguru_logger.debug("{}={}", "key", "value")
        finally:
            loguru_logger.remove(sink_id)
        line = buf.getvalue().rstrip("\n")
        self.assertRegex(line, r"\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2}) \| DEBUG")
        self.assertTrue(line.endswith("key=value | tpl={}={}"))


if __name__ == "__main__":
    unittest.main()
