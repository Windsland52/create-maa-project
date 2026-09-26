from __future__ import annotations

import importlib.metadata
import os
import sys

from utils import logger
from utils.runtime_paths import configure_runtime_paths

PI_ENV_KEYS = (
    "PI_INTERFACE_VERSION",
    "PI_CLIENT_NAME",
    "PI_CLIENT_VERSION",
    "PI_CLIENT_LANGUAGE",
    "PI_CLIENT_MAAFW_VERSION",
    "PI_VERSION",
    "PI_CONTROLLER",
    "PI_RESOURCE",
)


def _log_maafw_version() -> None:
    """报告 agent 进程实际加载的原生库版本。

    pip 元数据不可信：客户端增量更新往 site-packages 写新版 dist-info 时不删旧版，两份
    并存时 importlib.metadata.version 返回哪份并无保证（实测返回过时值）。因此以原生库
    的 MaaVersion() 为准，元数据只在原生查询失败时兜底，失败原因会先记一行 debug。

    必须在导入 maa.agent 之后调用：version() 会首次触发 API 属性初始化，而 Library.open
    撞上已初始化标志就早退，提前调用会把 Library 钉死在非 agent 模式。

    全部走 debug：版本是维护者排查用的诊断信息，不进用户看的 GUI 日志；agent 文件
    sink 固定 DEBUG 级，debug/custom/*.log 里始终可查。
    """
    try:
        from maa.library import Library

        version = Library.version()
        if not version:
            raise RuntimeError("MaaVersion() 返回空值")
    except Exception as error:
        logger.debug("查询原生 MaaFW 版本失败，改用 binding 元数据: {}", error)
        try:
            logger.debug("maafw {}", importlib.metadata.version("maafw"))
        except importlib.metadata.PackageNotFoundError:
            pass
        return

    logger.debug("maafw {}", version)


def run_agent(project_root_dir: str) -> int:
    configure_runtime_paths(project_root=project_root_dir, work_root=os.getcwd())

    if len(sys.argv) < 2:
        logger.error("Missing MaaFW Agent socket id argument.")
        return 2

    try:
        from maa.agent.agent_server import AgentServer
        from maa.tasker import Tasker
    except ImportError as error:
        logger.error("Failed to import MaaFW Agent runtime: {}", error)
        logger.error("Run `uv sync` for development or sync runtime before release.")
        return 1

    # 必须在导入 maa.agent 之后调用，原因见 _log_maafw_version
    _log_maafw_version()

    import custom

    custom.register_all()
    Tasker.set_log_dir("./debug")

    socket_id = sys.argv[-1]
    logger.debug("socket_id: {}", socket_id)
    log_pi_environment()

    AgentServer.start_up(socket_id)
    logger.info("AgentServer started.")
    AgentServer.join()
    AgentServer.shut_down()
    logger.info("AgentServer stopped.")
    return 0


def log_pi_environment() -> None:
    logger.debug("PI environment snapshot:")
    for key in PI_ENV_KEYS:
        logger.debug("{}={}", key, format_env_value(os.getenv(key, "")))


def format_env_value(value: str, limit: int = 300) -> str:
    if not value:
        return "<empty>"
    if len(value) <= limit:
        return value
    return f"{value[:limit]}...(truncated, total={len(value)})"
