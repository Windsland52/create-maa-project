# Changelog

create-maa-project 的重要更改记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [3.5.2] - 2026-09-16

### 修复

- `--update maafw` 以及 `--update runtime:mfa` / `runtime:mxu` 不再要求版本 pin 写成上游 tag 的 `v` 前缀。此前把 `maafw.version` 写成 `5.13.0` 会原样拼进 `.../releases/tags/5.13.0`，拿到一个不解释任何原因的 404 并终止更新，而上游的标签其实是 `v5.13.0`；现在先按原样查，查不到再试另一种拼法，两种都不存在时才按你写下的那个报错。日期型 tag（如 python-build-standalone 的 `20260610`）仍在第一次查询就命中，不会多发请求。`docs/commands.md` 与 `docs/commands.en.md` 已写明前缀可省略
- 生成的 release 工作流能在 macOS 上打包了。`Package` 步骤此前用 bash 4 的大小写展开给产物命名，而 macOS runner 的 `shell: bash` 指的是系统自带的 bash 3.2，不认识这个语法，于是两个 macOS 目标都在写出产物之前以 `bad substitution` 失败——Linux 与 Windows 正常，所以发布包里只缺 macOS。改用 `tr` 展开后六个目标一致
- 发布说明不再因为取不到 GitHub 元数据而卡住整次发布。仓库关掉 Pull Requests 时拉取 PR 列表会返回 404，git-cliff 对此直接 panic（退出 101），而 notes job 是发布 job 的依赖，于是包全部构建成功却一直发不出 Release；现在在线取不到元数据时会自动改用 `--offline` 重跑同一区间，照样写出发布说明（少 PR 号、`@用户名` 与新贡献者段落），并在运行页面留一条 warning。两次都失败时依旧是失败，不会被吞掉。同时删掉了生成的 `cliff.toml` 里无效的 `[git.github] commits = true`：git-cliff 从没有这个配置项，它一直被静默忽略，真正打开远端数据的是工作流里的 `GITHUB_REPO`

已有项目想拿到上面后两条（生成物修复）：只装了 github add-on 的项目执行 `create-maa-project --add github`，它会重写 `.github/workflows/release.yml`；装了 git-cliff add-on 的项目执行 `create-maa-project --add git-cliff`，它会一并重写 `.github/cliff.toml` 与 release 工作流。不刷新也能继续用，只是上面两个发布相关的问题要到刷新之后才修好

[3.5.2]: https://github.com/Windsland52/create-maa-project/compare/v3.5.1...v3.5.2

## [3.5.1] - 2026-09-15

### 新增

- `--doctor` 会指出 `interface.json` 里 `type` 不是 MaaFW 控制器类型的条目（例如 3.5.0 之前生成的项目里的 `"type": "WlRoots"`）—— 这类条目本来就会被项目自身的 `check:schema` 与编辑器拒绝，而此前 doctor 不做任何提示。提示执行 `--sync metadata` 就地修好；项目自行扩展、`type` 合法的控制器不受影响

### 变更

- 控制器 kind 改用 MaaFW 自己的叫法 `Linux`。此前 CLI 自造了 `WlRoots`，它是六个 kind 里唯一与上游枚举不一致的一个，也是 `maa-project.json` 与 `interface.json` 口径对不上的唯一来源。`--controller`、`maa-project.json` 的 `controller.kinds` 与 MCP 的 `controllers` 参数都仍接受 `WlRoots` 并归一化为 `Linux`，新项目两边都写 `Linux`，已有项目执行 `--sync metadata` 即完成迁移。反向不成立：3.5.1 生成的项目其 `controller.kinds` 为 `Linux`，更早版本的 CLI 会拒绝该值

### 修复

- `--sync` 不再删除 `interface.json` 里手写的内容。此前每条 sync 命令都会把 `controller` 与 `resource` 整段替换成 CLI 生成的版本，导致：控制器上的 `attach_resource_path`、`icon`、`option`、按类型的子块与调过的 `display_short_side` 被重置；`label` 被改回默认值；配置表达不出的控制器（例如第二个 Adb 客户端）被删除；`maa-project.json` 未记录仓库地址时手写的 `github` 被删除（现在 `--doctor` 由报错改为 `[INFO]`，并提示用 `--sync github-url` 记录）；非 Agent 项目手写的 `agent` 块被删除。现在只修由配置派生的部分：控制器的标识（含早期写出的 `Android`、`WlRoots`，就地改名而不再多出一条）与 `type`
- `--sync` 与 `--add` 不再重写归项目所有的文件。`maatools.config.mts` 与 `.vscode/` 下标记为 `once` 的 `settings.json`、`extensions.json`、`launch.json` 此前会被整体重生成，自定义的键、扩展推荐、嵌套配置与调试配置都会丢。现在只合并 CLI 自己生成的部分：`--add vscode` 保留其余键并按 `name` 合并调试配置，`--add agent` 只把 `vscode.agents.uv` 补进已有的 MaaTools 配置（已配好则完全不写），`--sync` 只在 `maatools.config.mts` 缺失时重建它
- `--add resource-pack` 不再按配置重生成 `interface.json` 的 `resource` 数组，改为追加新资源包，`hash`、`description`、`icon` 等字段以及手工添加的资源包都会保留
- `--doctor` 的修复提示不再指向做不到的命令。此前 `maatools.config.mts` 的三类问题、以及 `interface.json` 的 `import` 路径问题都提示执行 `--sync metadata`，而该命令并不会改写它们（`import` 列表从来不由 CLI 写入）；现在按问题给出可执行的修复路径

[3.5.1]: https://github.com/Windsland52/create-maa-project/compare/v3.5.0...v3.5.1

## [3.5.0] - 2026-09-13

### 新增

- 带 GitHub add-on 的项目新增 `package-smoke` workflow：在 push / PR 时按与 release 相同的六个目标各自构建并校验发布包（含包内 Python 运行时与 Agent 启动命令），打包问题不必等到打 tag 才暴露；MXU 没有 linux-arm64 产物，该目标只校验其余包
- `--doctor` 会提示删除遗留的 `agent/bootstrap.py`（该文件已不再生成，也不再被使用），不影响项目的其余诊断结论

### 变更

- Agent 发布包改为每个平台自带 Python 运行时：Windows 用 python.org 嵌入式发行版，macOS 与 Linux 用 python-build-standalone，依赖在打包阶段就装进包内解释器，因此 Linux 不再产出 wheelhouse，发布包也不再在启动时安装依赖
- 生成项目固定的工具链依赖改为由 `src/template-deps.json` 单点维护：本仓库每日从 npm registry 同步同 major 的最新版（跨 major 仍由人工决定），dev-tools 的 `package.json` 改为从该清单渲染。本次随之更新 `@nekosu/maa-tools` 1.0.24 → 1.1.2、`@nekosu/prettier-plugin-maafw-sort` 1.0.5 → 1.0.6、`prettier` 3.9.5 → 3.9.6、`prettier-plugin-multiline-arrays` 4.1.10 → 4.1.11

### 修复

- 生成的 `interface.json` 现在写入 MaaFW 自己的控制器类型与 ID：`name` 用控制器标识（`Adb`、`Windows`、`macOS`、`PlayCover`、`Gamepad`、`WlRoots`），`type` 用 MaaFW 枚举（其中 `WlRoots` 写为 `Linux`），`label` 仍是界面显示名
- MXU 发布包不再重复声明 Agent 启动命令：`child_exec` / `child_args` 统一由 release staging 写入，包内不会出现两份不一致的定义
- Windows 上的自动更新交接与 Agent Skill 同步不再把子进程参数拼成一行命令：Node 22.12+ 的 `DEP0190` 弃用警告不再出现在 stderr，交接给新版本时原有参数（包括带空格的路径）逐项传递

### 不兼容变更

- **Agent 发布包自带 Python 运行时，`agent/bootstrap.py` 不复存在。** 生成项目不再写入 `agent/bootstrap.py`，发布包也不再包含 `requirements.txt` 与 Linux wheelhouse；包内解释器（Windows 为 `python/python.exe`，macOS / Linux 为 `python/bin/python3`）已预装依赖，由它直接启动 `agent/main.py`。升级已有项目：先执行 `create-maa-project --sync` 刷新 release 工具与模板，再对每个目标平台执行 `create-maa-project --update python-runtime` 与 `create-maa-project --update python-deps`，最后再打 tag。遗留的 `agent/bootstrap.py` 不会再被使用，可以删除（`--doctor` 会给出提示）。

[3.5.0]: https://github.com/Windsland52/create-maa-project/compare/v3.4.0...v3.5.0

## [3.4.0] - 2026-09-10

### 变更

- **支持的 Node.js 下限从 24 降到 22.13**：本 CLI 与生成的项目都改为要求 `>=22.13`，`.node-version` 与生成的 GitHub Actions 均固定 Node 22。此前要求 24 并无技术依据——CLI 自身未使用任何 Node 24 独有 API，真正的约束来自生成项目所固定的 `pnpm@11.5.1`（其要求为 `>=22.13`）。已在 Node 22 上实测：完整测试套件、项目创建、`pnpm install`、`check:schema`、`check:maa` 全部通过
- Node 下限现在由 `src/node-support.ts` 单点定义，`.node-version`、生成的 workflow 与 `engines.node` 全部由它派生；`--doctor` 的版本检查同样改用该常量，不再硬编码

### 修复

- npm 与 PyPI 改用 Trusted Publishing（OIDC）发布，不再依赖会到期的长期 token；npm 发布步骤在 npm 版本不足以支持 Trusted Publishing 时会立即给出明确报错，而不是报出那个会掩盖鉴权失败的 `E404`

> **从 npm / PyPI 安装的用户请读这里**：`v3.3.0` 只发布了 GitHub Release（含 6 个平台二进制），它的 npm 与 PyPI 发布因发布凭据失效而失败。因此本版本是 3.3 系列在 npm / PyPI 上的**首个版本**，其用户可见变更与下方的 [3.3.0] 完全相同（包括两处不兼容变更），升级前请一并阅读。

[3.4.0]: https://github.com/Windsland52/create-maa-project/compare/v3.3.0...v3.4.0

## [3.3.0] - 2026-09-10

### 新增

- 交互式创建支持依赖联动：仓库功能列表按依赖树缩进排列，勾选某项会自动勾上它依赖的功能，取消被依赖项也会一并取消依赖它的功能，复选框始终等于最终启用的集合
- add-on 依赖现在完全可见：`--help` 与 MCP 工具描述写明依赖规则，人类输出新增 `Add-ons required by dependencies:` 一行，JSON report 新增 `addons` 字段（`requested` / `enabled` / `autoEnabled`）
- 新增 `vscode` add-on：`.vscode/` 编辑器集成从 dev-tools 中独立出来（见下方不兼容变更）
- 交互式「仓库配置」预设的「全部 / 最小 / 自定义」各自显示一行概括说明，「全部」不再需要用户猜测装了什么

### 变更

- 创建项目时的 OCR 模型供应方式改为默认使用 `MaaCommonAssets` 子模块（见下方不兼容变更）
- 项目类型提问移到许可证之前；交互式确认类提问（初始化 Git、添加额外资源包）改为单键 `y`/`n`，回车接受默认值
- add-on 依赖改为声明式依赖图推导，`--add` 的补全行为与顺序不再依赖手写规则

### 修复

- Ctrl+C 现在安静退出（退出码 `130`，不打印 `Error:`）：此前选择类提问会因 readline 关闭而抛出 `ERR_USE_AFTER_CLOSE`，自由文本提问会漏出 `Aborted with Ctrl+C`
- 修复窄终端下的重绘残影：提示行按显示宽度折行，清屏按物理行数回退（CJK 按两列计算，并避免行首出现 `、` 之类的标点）
- 修复在自定义仓库功能中勾选子项却被静默忽略的问题（当时会出现复选框显示与实际启用不一致）
- 在确认类提问上键入的字符不再回显到屏幕，也不会被下一个提问当作答案（此前会导致资源包目录名变成 `y`）
- `--help` 的依赖说明改写为 `is required by`，原文 `dev-tools: vscode, github, agent` 会被读成相反的规则
- 文档补齐：dev-tools 与 vscode 各自写入的文件清单及刷新方式（`managed` / `once`）、OCR 两种供应方式的差异

### 不兼容变更

- **`--add dev-tools` 不再写入 `.vscode/`。** 编辑器集成改为独立 add-on，需要时显式加 `--add vscode`（它会自动带上 dev-tools）。交互式「全部」预设与 `--template agent` 仍然包含它，但交互式「自定义」默认不再勾选，因此以前在自定义里直接回车会得到 `.vscode/`，现在不会。已存在的项目不受影响，其 `.vscode/` 目录保持不变。
- **新项目默认改用 `MaaCommonAssets` 子模块供应 OCR 模型。** `resource/base/model/ocr/` 现在被 `.gitignore` 忽略，其内容由子模块 gitlink 钉住，因此全新克隆需要先初始化子模块（`create-maa-project --update ocr-models` 会处理）。设置 `CREATE_MAA_PROJECT_OCR_SOURCE=download` 可保留旧布局（下载模型、写入 `manifest.json` 记录 sha256 并纳入版本控制）。默认走哪种模式还取决于创建时本机 Git 是否可用，因此对布局有要求时应显式指定。已存在的项目在运行 `--update ocr-models` 或 `--sync config` 之前不受影响。

[3.3.0]: https://github.com/Windsland52/create-maa-project/compare/v3.2.0...v3.3.0

## [3.2.0] - 2026-09-03

### 新增

- 创建项目默认初始化 Git 仓库并完成首次提交（目标已在 Git 仓库内时自动跳过）
- 生成的 VS Code `tasks.json` 在打开项目时自动同步依赖（pipeline 执行 `pnpm install`，Agent 项目额外执行 `uv sync`）
- CLI 自动更新与运行时热交付：检测到更高稳定版时把当前命令安全交接给新版本执行，并按版本同步一次 Agent Skill
- 内置 `create-maa-project` Agent Skill，供 Claude Code、Cursor、Copilot 等 agent 直接接入

### 修复

- 让 SEA 单文件构建支持 CJS bundle（避免顶层 await 导致启动失败）
- 自定义参数中的字面量 `"null"` 不再被当作已提供的值
- 依赖审计锁定的传递依赖更新

## [3.1.2] - 2026-08-07

### 修复

- 移除归档解压的字节上限，恢复对大体积资产的正常处理
- 依赖审计锁定的传递依赖更新

## [3.1.1] - 2026-07-28

### 新增

- MCP 工具契约加强，并暴露服务器根目录上下文

### 修复

- MCP 备份检查改为只读，不再改动项目文件
- MCP 请求取消可以正确向下传播

## [3.1.0] - 2026-07-27

### 修复

- `doctor` 提供的 Node 修复命令现在可以直接执行，Agent 项目的修复命令也真正生效
- 已启用的受管模板可以正确刷新
- release 流程补齐 interface 图标打包、固定 git-cliff 校验和、smoke 测试覆盖 Windows 命令垫片
- PyPI 二进制下载加上大小上限与校验
- 模板不再引用缺失的默认图标，README 指引与启用的能力保持一致

## [3.0.1] - 2026-07-22

### 修复

- MCP 服务器上报正确的包版本

## [3.0.0] - 2026-07-22

### 变更

- 移除项目锁状态文件
- 改进生成项目的依赖更新流程

## [2.0.0] - 2026-07-14

### 新增

- 支持发布通道（`stable` / `beta` / `alpha`）与精确版本锁定

[3.2.0]: https://github.com/Windsland52/create-maa-project/compare/v3.1.2...v3.2.0
[3.1.2]: https://github.com/Windsland52/create-maa-project/compare/v3.1.1...v3.1.2
[3.1.1]: https://github.com/Windsland52/create-maa-project/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/Windsland52/create-maa-project/compare/v3.0.1...v3.1.0
[3.0.1]: https://github.com/Windsland52/create-maa-project/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/Windsland52/create-maa-project/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/Windsland52/create-maa-project/compare/v1.2.3...v2.0.0
