[English](./commands.en.md) | 简体中文 | [返回 README](../README.md)

# 命令

常用创建选项：

```bash
create-maa-project [name]
create-maa-project .
create-maa-project [name] --template pipeline
create-maa-project [name] --template agent
create-maa-project [name] --slug maa-helper --name "明日方舟助手"
create-maa-project [name] --controller Adb,Win32,MacOS
create-maa-project [name] --license MIT
create-maa-project [name] --git
create-maa-project [name] --no-git
```

可用的控制目标：`Adb`、`Win32`、`MacOS`、`PlayCover`、`Gamepad`、`Linux`（Linux 上的 wlroots 桌面应用）。默认为 `Adb`，取值不区分大小写。重命名前的 `WlRoots` 仍然接受，读取时归一化为 `Linux`。

控制目标写入生成的 `interface.json` 时使用同一套 MaaFW 控制器类型：`Adb`、`Win32`、`MacOS`、`PlayCover`、`Gamepad`、`Linux`。每个控制目标生成一个条目：`name` 是控制器标识（`Adb`、`Windows`、`macOS`、`PlayCover`、`Gamepad`、`Linux`），`label` 是界面显示名（如 `Android / Emulator`），`type` 为上述类型。

Git 初始化默认开启：目标不在已有 Git 仓库内时，创建（含 `--yes`/`--no-interactive` 和 MCP 未传 `git` 的非交互路径）会自动 `git init` 并做首次提交；`--no-git` 可显式关闭。Git 未安装或 `git init` 失败时创建仍然成功，具体原因写入 JSON report 的 `git` 字段。

交互式创建的默认值：项目目录 `maa-project`（项目 ID 由目录名推导，推导不出合法 ID 时才追问）、显示名取目录名、项目类型 `pipeline`、license `AGPL-3.0-or-later`、控制目标 `Adb`、仓库预设「全部」、不添加额外资源包；Git 初始化按上一条规则。`--yes --no-interactive` 使用同一套默认值。

增量能力：

```bash
create-maa-project --add dev-tools
create-maa-project --add vscode
create-maa-project --add github
create-maa-project --add android
create-maa-project --add agent
create-maa-project --add resource-pack extra --label "额外资源"
create-maa-project --add git-cliff
create-maa-project --add auto-format
create-maa-project --add optimize-images
create-maa-project --add community
create-maa-project --add dependabot
create-maa-project --add schema-sync
```

add-on 依赖会被自动补全，无需手动按顺序添加：

- `vscode`、`github`、`agent` 依赖 `dev-tools`；
- `agent` 还依赖 `vscode`（Agent 项目自带 `Maa Agent: Debug` 调试配置）；
- `git-cliff`、`auto-format`、`optimize-images`、`community`、`dependabot`、`schema-sync` 依赖 `github`（因而也依赖 `dev-tools`）；
- `android` 不依赖任何 add-on：它自带入口 workflow，没有 `github` 也能出 debug 包。

例如 `create-maa-project --add community` 实际会启用 `dev-tools`、`github`、`community`。
人类可读输出会打印 `Add-ons required by dependencies:`，JSON report 的 `addons` 字段给出
`requested` / `enabled` / `autoEnabled`。

`vscode` 是可选的：`--add dev-tools` 只写工具链，不再写 `.vscode/`；需要编辑器集成时显式加
`--add vscode`。交互式流程中「全部」预设会包含它，而「自定义」的仓库功能列表默认不勾选它。

### dev-tools 写入的文件

`--add dev-tools` 会写入 13 个文件：

| 文件                                          | 用途                                                       | 刷新方式 |
| --------------------------------------------- | ---------------------------------------------------------- | -------- |
| `.node-version`                               | 固定 Node 22                                               | managed  |
| `.prettierrc.mjs`                             | Prettier 配置（含 MaaFW 排序与多行数组插件）               | managed  |
| `.prettierignore`                             | 忽略生成的 schema baseline 等                              | once     |
| `package.json`                                | devDependencies、`engines.node >= 22.13`、`packageManager` | once     |
| `pnpm-workspace.yaml`                         | pnpm workspace 配置                                        | once     |
| `tools/validate-schema.mjs`                   | `check:schema` 使用的校验脚本                              | managed  |
| `tools/schema/interface.schema.json`          | 上游 MaaFW baseline（interface）                           | managed  |
| `tools/schema/interface_config.schema.json`   | 上游 MaaFW baseline（interface config）                    | managed  |
| `tools/schema/interface_import.schema.json`   | 上游 MaaFW baseline（interface import）                    | managed  |
| `tools/schema/pipeline.schema.json`           | 上游 MaaFW baseline（pipeline）                            | managed  |
| `tools/schema/schema-manifest.json`           | schema 版本清单                                            | managed  |
| `tools/schema/custom.action.schema.json`      | 自定义动作 schema，供项目自行编辑                          | once     |
| `tools/schema/custom.recognition.schema.json` | 自定义识别 schema，供项目自行编辑                          | once     |

`managed` 文件会被 `--update`（如 `--update schema`）刷新；`once` 文件只在首次创建时写入，
之后归项目所有，不会被后续命令覆盖。

### vscode 写入的文件

`--add vscode` 会写入 `.vscode/` 下的 3 个文件（Agent 项目再多 1 个 `launch.json`）。这些文件引用
dev-tools 的产物（Prettier formatter、`tools/schema/*`、`pnpm install`），因此该 add-on 依赖 dev-tools：

| 文件                      | 用途                                                      | 刷新方式 |
| ------------------------- | --------------------------------------------------------- | -------- |
| `.vscode/settings.json`   | formatOnSave、LF、jsonc 关联、schema 映射与默认 formatter | once     |
| `.vscode/extensions.json` | 推荐扩展（Prettier、MaaFW 等；Agent 追加 Pylance）        | once     |
| `.vscode/tasks.json`      | 打开项目时自动同步依赖                                    | managed  |
| `.vscode/launch.json`     | 仅 Agent 项目：`Maa Agent: Debug` 调试配置                | once     |

未启用该 add-on 时项目没有 `.vscode/`，`--doctor` 会把 `vscode-settings` 检查标记为 skipped 而不是失败。

这三个 `once` 文件由 add-on 合并写入：`settings.json` 与 `extensions.json` 保留项目已有的键（`--add vscode` 再跑一次不会丢掉你自己加的 `editor.rulers` 或扩展推荐），`launch.json` 按 `name` 合并 `configurations`；只有 `managed` 的 `tasks.json` 会被整体刷新。`maatools.config.mts` 同样是 `once`：`--add agent` 只把 `vscode.agents.uv` 调试会话补进已有文件，`--sync` 只在它缺失时重建，其余情况都不会重写。`--doctor` 会检查它的必填字段（`maaVersion`、`interfacePath`、`check`），需要重建时提示删除该文件后跑 `--sync metadata`。

`package.json` 中的脚本按启用的 add-on 组合：`check` 始终包含 `format:check`、`check:schema`、
`check:maa`；`github` 追加 `release:dry-run`、`sync:runtime`，`schema-sync` 追加 `sync:schema`，
`optimize-images` 追加 `optimize:images`，Agent 项目追加 `format:py`、`lint:py`、`typecheck:py`、
`check:py`。

### android 写入的文件

`--add android` 把项目接上 MaaFwApp 外壳（Kotlin/Gradle），由 CI 出 APK：

| 文件                                  | 用途                                                             | 刷新方式 |
| ------------------------------------- | ---------------------------------------------------------------- | -------- |
| `Android/profile.yaml`                | 打包配方，按项目形态二选一（纯 pipeline / 带 agent），之后手维护 | once     |
| `Android/README.md`                   | 本地出包、签名 Secrets、升外壳与常见问题                         | once     |
| `tools/android-packaging.mjs`         | 解析 MaaFW 版本、内核 tag、资产前缀与 Chaquopy 参数              | managed  |
| `.github/workflows/android.yml`       | 入口：push / PR 出 debug，手动可选 release                       | managed  |
| `.github/workflows/android-build.yml` | 可复用流水线：debug / universal / 双 ABI 单包                    | managed  |

`managed` 文件重跑 `--add android` 即刷新（`--update` 没有 android 目标）。除文件之外还有几件事：

- 外壳 `Android/MaaFwApp` 是 Git submodule（`Aliothmoon/MaaFwApp`，记 `branch = main`）：创建/添加时
  浅克隆一次并把它写进 `.gitmodules`，随后 `git add .gitmodules` 与 gitlink（CI 用
  `submodules: recursive` 检出，缺任一项就只能拿到空目录）。克隆失败**不阻断**创建，登记
  `android-submodule` pending，命令是 `git submodule add -b main …`。
- `.gitignore` 追加 `Android/agent-dist/`（agent 运行时是构建产物，不入库）。
- `pyproject.toml` 的 `[tool.ruff]` 追加 `extend-exclude = ["Android/MaaFwApp"]`（**Agent 项目**）：
  `release.yml` 以 `submodules` 检出子模块，不排除的话 `ruff check .` 会扫进外壳自带的
  `scripts/*.py` 并命中 `UP009`，`pnpm check:py` 在 6 个 `package` job 里一起失败、Release 因此不创建。
  项目自己已有 `extend-exclude` 时把路径并进那个数组（单行/多行都行），不会再写第二个同名 key——重复
  key 会让 `pyproject.toml` 变成非法 TOML，连带 `--update python-deps` 的 `tomllib` 解析一起失败。
- **Agent 项目**需要 `requirements.txt` 里的精确 `maafw==X`：Android 的 Python 绑定只随内核
  （`MaaAgentCoreAndroid` 的 `X-maafwY` tag）发布，CI 按它配对内核与 APK 内的原生库。拿不到精确版本时
  登记 `android-version` pending；`maa-project.json` 的 `maafw.version` 填了精确版本时，`--add android`
  会把 `pyproject.toml` 的 `maafw` 一并钉住；为空时由 `--update python-deps` 按 `maafw.channel` 解析并
  钉住。两条路径都靠 `--update python-deps` 把钉版导出到 `requirements.txt`。上游发了补丁版而内核还没
  跟上时，CI 会降级到不高于固定版本的最高配对并打 `::warning::`（APK 内仍是同版本，只是比 requirements
  固定得旧）；固定版本比内核所有配对都旧才报错。
  预发布版本同样能配对：内核 tag 与 release tag 用发布原文（`3.13.15-maafw5.15.0-beta.1`、
  `v5.15.0-beta.1`），`requirements.txt` 里是 uv 导出的归一形式（`5.15.0b1`），resolver 与 `--doctor`
  都先按 PEP 440 归一再比较，`maa-project.json` 的 `maafw.version` 写哪种拼写都能匹配。
- 带 `.so` 的原生 Python 包由 resolver 按 Chaquopy 索引**逐包探测**后给出降级参数：桌面 pin 在索引上
  没有当前 CPython 的构建就钉到索引最高可用版，索引上没有该包（纯 Python）不钉，索引有构建但没有
  当前 CPython 时 CI 直接报错，而不是让 pip 在构建中途失败。
- 启用 `github` 时，`release.yml` 会多一个 `android` job：与桌面 `package` **并行**，Release job
  的 `needs` 带上它，资产加上 `release-assets/*.apk`，且只在 tag 上触发；没启用 `android` 时
  `release.yml` 逐字节不变。tag 发版缺 `KEYSTORE_BASE64` 会失败；手动 dispatch 仍可出未签名包。
- 交互式「全部」预设**不含** `android`（它要拉一个外壳仓库），请在「自定义」里勾选，或用
  `--add android`。
- 产物命名：`<前缀>-android-<tag>.apk`（universal，刻意不带 ABI 段）与
  `<前缀>-android-<abi>-<tag>.apk`（单 ABI）。前缀取 `project.displayName`，非 ASCII 或带空白时退回
  `project.slug`（应用内更新按资产名选包，前缀必须 ASCII）。
- 配方里的 `app.id` 由外壳校验：只收小写包段（字母 / 数字 / 下划线，每段以字母开头），拼成
  `com.aliothmoon.maafw.<id>`。项目 ID 的连字符会换成下划线（`maa-helper` → `maa_helper`），数字开头
  加前缀 `p`；手改配方写回连字符时 `--doctor` 会先报出来，而不是等 Gradle 构建失败。
- `--doctor` 的 `android-packaging` 检查覆盖这五个文件、配方 `assets` 与 `app.id`、外壳的登记/
  检出/gitlink 状态、`.gitignore` 段落，以及 agent 项目的 maafw 钉版一致性。

规格与字段权威说明在外壳仓库里：`Android/MaaFwApp/INTEGRATION.md` 与 `pi-profile.sample.yaml`。

元数据同步：

```bash
create-maa-project --sync config
create-maa-project --sync metadata
create-maa-project --sync display-name --name "新显示名"
create-maa-project --sync version --version 0.2.0
create-maa-project --sync license --license MIT
create-maa-project --sync github-url https://github.com/MaaXYZ/MaaExample
create-maa-project --sync network --network official
```

旧版 `maa-project.json` 不会在其他维护命令中被静默改写。遇到 schema v1 时，请显式运行
`create-maa-project --sync config`；迁移会进入项目备份，可用 `--restore` 回退。

`--sync` 只刷新由 `maa-project.json` 派生的部分，`interface.json` 里手工写的内容一律保留：

- 控制器条目按配置里的控制目标就地修好标识与 `type`；`label`、`attach_resource_path`、`icon`、`option`、`display_long_side` 以及 `linux`／`adb` 这类按类型的子块都原样留下，`display_short_side` 和 `label` 的手工调整也不会被打回去。配置表达不出的控制器（例如第二个 Adb 客户端）保留不动；CLI 早期写过的控制器 ID（`Android`、`WlRoots`）在原地改名，不会另外多出一条；如果某个控制目标由项目自己的条目承担（例如把默认的 Adb 条目换成了自己的云客户端），只修 `type`，标识和显示名不动。
- 资源包同理：配置已知的包就地刷新并保持配置顺序，配置里关掉的包会被移除，配置不认识的包保留。
- `github` 只在 `maa-project.json` 里记了仓库地址时才会写入；没有记录时手工写的那条保留，`--doctor` 给出 `[INFO]` 提示可用 `--sync github-url` 记录，不再当作错误。
- `agent` 块只在项目是 Python Agent 时重新生成，否则保留。
- `.vscode/` 下标记为 `once` 的文件完全不写；`maatools.config.mts` 只在**文件缺失时**重建，已存在就一个字节都不动（`--doctor` 对缺失的文件提示跑 `--sync metadata`，所以这条修复路径必须存在）。

因此 `--sync metadata` 依然是把控制器漂移修回上游枚举的修复命令，但它不会替你丢弃没用配置表达过的东西。

更新：

```bash
create-maa-project --update schema
create-maa-project --update maafw
create-maa-project --update runtime:mfa
create-maa-project --update runtime:mxu
create-maa-project --update ocr-models
create-maa-project --update node-deps
create-maa-project --update python-deps
create-maa-project --update python-runtime
```

`--update all` 故意不支持。显式执行具体更新可以让 pending action 和日志更清楚。

Agent 项目的 Python 依赖是一条两级链路，改依赖时两步都要走。`uv add <包名>` 写入
`pyproject.toml` 的 `[project].dependencies`、更新 `uv.lock` 并装进本地 `.venv`，本地 `uv run`
到此就能跑；但 `requirements.in` / `requirements.txt` 不会跟着变，需要再跑
`create-maa-project --update python-deps`，它会从 `pyproject.toml` 重新生成 `requirements.in`，再经
`uv lock` + `uv export` 刷新 `requirements.txt`。发布包按 `requirements.txt` 预装依赖
（`tools/sync-runtime.mjs` 发现该文件缺失会直接报错），所以只 `uv add` 的结果是本地一切正常、打出的
包里没有新依赖。每次改完依赖，把 `pyproject.toml`、`uv.lock`、`requirements.in`、`requirements.txt`
一起提交。

对启用 `android` 的 Agent 项目，`--update python-deps` 还负责对齐 MaaFramework 版本：目标取
`maa-project.json` 的精确 `maafw.version`，为空则按 `maafw.channel` 解析最新发布（`beta` / `alpha`
含预发布），先把该版本钉进 `pyproject.toml` 的 `maafw==X` 再 `uv lock` / `uv export`，最后校验导出的
`requirements.txt` 仍是同一版本（按 PEP 440 归一后比较，不一致直接报错，不让 APK 与桌面资产各用一套）。
没有 `android` 的 Agent 项目不受影响：`maafw` 保持浮动，由 uv 与 Dependabot 的 `lockfile-only` 更新驱动。
发版 workflow（桌面 `release.yml` 与 Android 的 `android-build.yml`）在打包前会用 `uv export --frozen`
从 `uv.lock` 重新导出 `requirements.txt`，所以合并 Dependabot 的 uv PR 后不用手工重导；`--update
python-deps` 只负责把仓库里那份文件同步到最新（本地开发与提交用）。`--frozen` 会在 `pyproject.toml` 与
`uv.lock` 不一致时直接失败，而不是悄悄用旧 lock。

`--update python-runtime` 用 `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=<os>-<arch>` 指定平台（一次一个），
把内嵌解释器下载到 `.create-maa-project/runtime/python/<platform>`，并按 `requirements.txt` 重装依赖；
依赖变更后要先跑 `python-deps`，`python-runtime` 才能装到新版本。

`maa-project.json` 的 `maafw.channel` / `maafw.version` 决定 MaaFramework runtime 资产如何解析：
`version` 非空时按该版本取发布，`v` 前缀可省略——上游标签写作 `v5.13.1`，因此 `5.13.1` 会先按原样查、
再按 `v5.13.1` 查；两种拼法都不存在时报错仍指向你写下的那个。为空时按 `channel`（缺省 `stable`）取通道内
最新的发布，其中 `stable` 只接受正式版，`beta` 额外接受 rc 与 beta（rc 归入 beta），`alpha` 再额外接受 alpha。
`runtime.mfa.version` 与 `runtime.mxu.version` 同理。

### OCR 模型的两种供应方式

默认供应方式取决于创建时**本机 Git 是否可用**，以及项目目录是否本身就是 Git 工作树根；这与 `--git`/`--no-git` 无关（后者只管项目是否执行 `git init`）：

| 创建时 Git       | `.gitmodules` | `maa-project.json` 的 `ocr` | `resource/base/model/ocr/`              |
| ---------------- | ------------- | --------------------------- | --------------------------------------- |
| 可用             | 写入          | `{"source":"submodule",…}`  | 写入 `.gitignore`（模型为派生文件）     |
| 可用但在父仓库内 | 不写入        | **完全没有 `ocr` 键**       | 改为提交 `manifest.json`（记录 sha256） |
| 不可用           | 不写入        | **完全没有 `ocr` 键**       | 改为提交 `manifest.json`（记录 sha256） |

因此同一个创建命令在不同机器上产出的项目**结构可能不同**，而两者的退出码与文件计数相同。可用
`CREATE_MAA_PROJECT_OCR_SOURCE=submodule` 或 `=download` 显式指定，避免依赖本机环境。

在父仓库的子目录中创建项目时一律退回 download 模式（模型随子项目提交，不改写父仓库的
`.gitmodules`）；此时显式指定 `CREATE_MAA_PROJECT_OCR_SOURCE=submodule` 会直接报错，需要把项目建在
Git 工作树根目录或父仓库之外。

注意：Git 可用时即使传入 `--no-git`，生成的 `.gitmodules` 也会被写入（此时还没有 `.git` 目录）。
该文件是为之后的 `git init` 或手动初始化准备的子模块声明，不是错误；不想保留可以删除。

诊断和维护：

```bash
create-maa-project --doctor
create-maa-project --doctor --report
create-maa-project --list-backups
create-maa-project --show-backup <backup-id>
create-maa-project --restore <backup-id> --dry-run
create-maa-project --restore <backup-id>
create-maa-project --clean-cache
```

常用执行控制：

```bash
--yes
--no-interactive
--force
--clear-stale-lock
--allow-non-git-dir
--allow-pending-commit
--skip-download
--log-file <path>
--lang auto|en|zh-CN
--no-color
```
