# Changelog

create-maa-project 的重要更改记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 维护方式：条目由人工精炼（合并同类项、以用户视角描述），可用 `pnpm run changelog:draft` 生成 git-cliff 草稿作为参考；完整逐提交历史见 `git log`。

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
