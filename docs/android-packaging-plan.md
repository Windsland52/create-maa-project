# 通用 Android 打包方案

> 状态：**已实施**（切片 1-5 全部落地；切片 6 是两个示例仓库的手动验收清单）。实施中的三处偏离已在
> §14 记录：版本钉版走 pending 而非交互问询、`android` 不进「全部」预设、doctor 检查另加了两项。
> 目标仓库：create-maa-project；蓝本：M9A 的 `tools/android-packaging.mjs` +
> `.github/workflows/android.yml` / `android-build.yml`；细节参考 MaaEnd（keystore 降级、APK 自检）。
> 配方格式的权威文档是 MaaFwApp 子模块内的 `pi-profile.sample.yaml` 与 `INTEGRATION.md`。
>
> 本稿的上游事实已逐条对本地 checkout（M9A / M9A 的 MaaFwApp 子模块 / MaaEnd）核验，核验结论见 §13；
> 标了「核验纠正」的段落是原稿写错、现已改写的地方。

## 0. 既定决策

| 决策     | 内容                                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 外壳     | `Android/MaaFwApp` git submodule（Aliothmoon/MaaFwApp），Gradle 出 APK                                                                                                                                                                     |
| 配方     | `Android/profile.yaml` 保留为**手维护的静态模板**，create-maa-project 只负责首次生成，不理解配方语义；字段语义以 MaaFwApp 文档为准                                                                                                         |
| 支持范围 | 仅两种形态：**纯 pipeline** 与 **Python agent**（bundle 路线）；编译型 ELF agent（nativeLibs 路线）明确不支持                                                                                                                              |
| 版本策略 | 与桌面同源固定 MaaFW 版本；agent 项目配对 `MaaAgentCoreAndroid` 内核（`X-maafwY` tag），保证 APK 内前后端一致                                                                                                                              |
| 版本落点 | 精确版本写在 **`pyproject.toml` 的 `dependencies`**（uv 的源头）；`requirements.txt` 是 `uv export` 的产物、也是 resolver 的输入；`requirements.in` 只是 uv 的中间产物，`--update python-deps` 会用 pyproject 重新生成它（见 §5 适配点 1） |
| 产物     | debug：arm64-v8a 单包；release：universal + arm64-v8a + x86_64 三包，命名 `<prefix>-android-<abi>-<tag>.apk`，**universal 不带 ABI 段**（应用内更新按资产名选包，带段会绕过 universal 回退）                                               |
| 失败降级 | 子模块拉取失败不阻断创建：登记一条 `pending`（`{kind, reason, command}`，走人类输出的 `Pending actions:` 与 JSON report，不改契约），而不是只往 README 写散文                                                                              |
| CI 拓扑  | `android.yml`（入口）→ `android-build.yml`（可复用 workflow_call）；`release.yml` 在 `v*` tag 上也调 `android-build.yml`，等桌面包与 APK 全就绪再建 Release                                                                                |

## 1. 范围

**做**：

- 新 addon `android`：profile 两变体、resolver 脚本、两个 workflow 模板、MaaFwApp submodule 接入、文档。
- scaffolding：addon 注册与问询、submodule 添加（复用 OCR submodule 机制）、`.gitignore`、requirements 钉版。
- 测试：resolver 单测（离线 fixture）、模板渲染测试。

**不做**（记录在案，避免范围蔓延）：

- Mirror酱 上传（`mirrorchyan` 已是 V1 保留 addon，届时接 `update.mirrorchyanRid` 即可）；
- 编译型 agent（Go/Rust/C++ ELF）、NDK 交叉编译链（MaaEnd 的 `build_android_agents.py` 整套不搬）;
- profile.yaml 的动态生成 / 从 `maa-project.json` 推导 include（保留静态模板是既定决策）；
- 本地出包辅助脚本与 `--check-env` 体检（文档给命令即可，有需求再补）。

## 2. 用户仓库最终布局

脚手架生成后（以 agent 项目为例；纯 pipeline 项目少了 `agent/`、`requirements.*` 与 profile 的 agent 段）：

```text
<project>/
├── Android/
│   ├── MaaFwApp/              # submodule；父仓库必须登记 gitlink（见 §8.1）
│   ├── profile.yaml           # 静态模板二选一拷入，之后用户手维护
│   └── README.md              # addon 生成：本地构建 / secrets / 升外壳说明
├── tools/
│   └── android-packaging.mjs  # resolver：解析版本与命名参数
├── .github/workflows/
│   ├── android.yml            # 入口：push / PR 出 debug，手动可选 release
│   └── android-build.yml      # 可复用：被 android.yml 与 release.yml 调用
├── agent/ …
├── interface.json
├── maa-project.json
├── pyproject.toml             # agent 项目：dependencies 里 maafw==X（版本源头）
└── requirements.txt           # agent 项目：uv export 产物，resolver 的输入
```

构建产物（不进 git，`.gitignore` 覆盖）：`Android/agent-dist/`（bundle 运行时）。`local.properties`、`.maafw/`、`jniLibs/` 都在子模块树内，由子模块自己的 gitignore 管。

## 3. addon 注册

`src/addons.ts`：

- `CREATE_ADDONS` / `INCREMENTAL_ADDONS` / `ADDON_ORDER` 增加 `'android'`（排在 `github` 之后）；
- `ADDON_DEPENDENCIES.android = []` —— 不硬依赖 `github`：没有 `github` addon 的项目仍有 `android.yml` 入口可用；release 挂钩是软集成（见 §7，同 `gitCliffJob` 的条件注入模式）；
- **`ADDON_CONFIG_KEYS.android = 'android'`（必须，原稿漏了）**：`initialAddons()` 只给 `ADDON_CONFIG_KEYS` 里有映射的 addon 写状态，没有这一项 `maa-project.json` 里不留任何痕迹，于是 `--update` / `--sync` / release 挂钩都认不出 android 已启用。

配套改动：

- `src/scaffold.ts` 加 `addAndroid()`（增量入口），`src/incremental-addons.ts` 加分支——那里的分发是硬编码表，不是从 `ADDON_ORDER` 推导的；
- MCP 侧无需改：`src/mcp.ts` 的 addon 枚举就是 `ADDON_ORDER`，加了自动生效；
- 被测试钉住的 addon 列表要同步：`tests/addons.test.ts`（含 `Supported incremental add-ons: …` 那条**精确文案**）、`tests/prompt.test.ts`、`tests/mcp.test.ts`。

问询（`src/prompt.ts`）沿用 addon 列表自动生成的机制，一项：`Android APK packaging`。选中 `agent` + `android` 时提示 requirements 将钉 `maafw==X`。

## 4. profile.yaml 两变体

模板放 `templates/addons/android/Android/`，scaffolding 按"是否含 agent"二选一拷贝为 `Android/profile.yaml`，替换 `{{slug}}` / `{{displayName}}`。

关键事实（来自 `BuildProfile.kt` 与 `INTEGRATION.md`，模板注释里要写清）：

- **路径解析分三类（核验纠正）**：只有文件系统字段——`assets`、`agent.sourceDir`、`app.icon`——相对**配方文件所在目录**解析；`include` / `exclude` / `logs.include` 是相对 **PI 根（即 `assets`）** 的 glob；`pi.profile` 本身相对 Gradle 根项目解析（CI 里传绝对路径，见 §6.2）；模板注释要分开写，别笼统说"路径相对本文件"；
- `include` 省略 = 内置默认白名单：`interface.json`、`tasks/**`、`resource/**`、`resource_*/**`、`data/**`、`locales/**`、`CONTACT`、`LICENSE`；`.git` / `node_modules` / `.venv` / `__pycache__` 构建期必删；**写了 include 就是整体替换**（不合并），且 `include: []` 是**空白名单**而不是"用默认值"；`exclude` 压在 include 之上；
- `app.icon` 是构建期从文件系统读（相对配方目录，png/webp），与资源白名单无关；PI 各级声明的任务图标才要求落在 include 白名单里；
- `app.id` 只收小写包段，拼成 `com.aliothmoon.maafw.<id>`（slug 需小写化）；省略 `app` 整段则是 `com.aliothmoon.maafw`；
- `agent.abi` 省略 = 按 `agent.sourceDir` 里实际建出的运行时打包（内部等价于 `abi: ["*"]`，`*` 只吃一个路径段，所以就是"建出哪几份打哪几份"）——ABI 控制完全交给 `build_agent_bundle.py --abi` 与 `local.properties` 的 `build.debugAbi` / `build.releaseAbi`；M9A 的生产配方就是这么做的，直接照抄它的注释；
- controller 不用处理：壳取 PI `controller` 里**所有** `type: Adb` 项、按声明序保留（首项是缺省），非 Adb 项丢弃；一个都没有时告警并用内置默认（核验纠正：不是"只取一项"）。

### 4.1 `profile.pipeline.yaml`（纯 pipeline）

```yaml
# Android 打包配方（MaaFwApp 格式）。字段权威说明见 Android/MaaFwApp/pi-profile.sample.yaml。
# 路径解析：assets / agent.sourceDir / app.icon 相对本文件；include / exclude 相对 PI 根（assets）。
# 资源在构建期打进 APK：换任务 / 资源要重新出包。

assets: ..

# include 省略 = 内置默认白名单（interface.json、tasks/**、resource/**、resource_*/**、
# data/**、locales/**、CONTACT、LICENSE），已覆盖本项目脚手架生成的全部内容；
# 以后新增自定义目录（如 docs 之类要进包的）再手动补 include。
# 注意：写了 include 就是整体替换，需要把默认列表抄全；include: [] 是空白名单，不是"用默认值"。
#
# exclude 压在 include 之上，用来挖掉大而用不上的资源，例如：
# exclude:
#   - resource/model/detect/ProtocolSpace/**

app:
    id: {{slug}}
    label: {{displayName}}
    # icon 只收 png / webp，路径相对本文件；不写则用 MaaFwApp 自带图标。
    # 仓库根放了 logo.png 时可取消注释（记得把 logo.png 也加进 android.yml 的 paths 触发列表）：
    # icon: ../logo.png

# 应用内更新走 Mirror酱「可执行包」流时取消注释（rid 与 PI 资源 rid 不是同一条）：
# update:
#   mirrorchyanRid: {{slug}}_exec
```

### 4.2 `profile.agent.yaml`（Python agent）

```yaml
# Android 打包配方（MaaFwApp 格式）。字段权威说明见 Android/MaaFwApp/pi-profile.sample.yaml。
# 路径解析：assets / agent.sourceDir / app.icon 相对本文件；include / exclude 相对 PI 根（assets）。
# 资源在构建期打进 APK：换任务 / 资源 / agent 代码要重新出包。

assets: ..

# 写了 include 就是整体替换：默认白名单抄全，再加 agent/**（agent 载荷跟资源走）
include:
    - interface.json
    - tasks/**
    - resource/**
    - resource_*/**
    - data/**
    - locales/**
    - CONTACT
    - LICENSE
    - agent/**

# exclude:
#   - resource/announcement/*.md

# agent 运行时由 CI 的 build_agent_bundle.py 产出到 Android/agent-dist/<abi>/bundle/。
# 本地手动构建（在 Android/MaaFwApp 下执行）：
#   python scripts/build_agent_bundle.py \
#     --out ../agent-dist --abi arm64-v8a \
#     --requirements ../../requirements.txt \
#     --core-tag <MaaAgentCoreAndroid tag，见 tools/android-packaging.mjs 输出> \
#     --exclude pillow --require pillow==11.0.0 \
#     --extra-index-url https://chaquo.com/pypi-13.1/
agent:
    sourceDir: agent-dist
    # 这里不写死 abi：省略时外壳按 ["*"] 打包，也就是"agent-dist 里实际建出来的那几份运行时"。
    # 建哪些 ABI 由上面那条 build_agent_bundle 的 --abi 决定，必须与 APK 的
    # build.debugAbi / build.releaseAbi 对齐，否则 APK 会宣称支持一个不带运行时的架构。
    runtimes:
        - location: bundle
          executable: bin/python3
          args: [-u, agent/main.py]
          env:
              PYTHONHOME: "{bundle}/prefix"
              PYTHONPATH: "{bundle}/site-packages/pure.zip:{bundle}/site-packages"
              LD_LIBRARY_PATH: "{bundle}/prefix/lib:{bundle}/site-packages/chaquopy/lib:{nativeLibs}"
              MAAFW_BINARY_PATH: "{nativeLibs}"

app:
    id: {{slug}}
    label: {{displayName}}
    # icon: ../logo.png

# update:
#   mirrorchyanRid: {{slug}}_exec
```

> 上面 `runtimes.env` 四行与 M9A 生产配方逐字一致；其中 `chaquopy/lib` 那条不是经验之谈：
> `build_agent_bundle.py` 自己在装到 Chaquopy 原生包时会打印告警，要求把它加进 `LD_LIBRARY_PATH`。

## 5. resolver：`tools/android-packaging.mjs`

以 M9A 版为基线整体搬迁，保持纯 Node、零依赖、`$GITHUB_OUTPUT` 输出、`ANDROID_PACKAGING_RELEASES_FIXTURE` 离线 fixture、`AGENT_CORE_TAG` 应急通道不变。**输出从 4 个扩到 7 个**：

| 输出              | 来源                                                                                                                     | 变化                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `maafw_tag`       | 来源链：`requirements.txt` 的 `maafw==X` > `maa-project.json` `maafw.version`（须精确） > channel 最新                   | 适配：M9A 只在 **agent 项目**钉版缺失时报错，纯 pipeline 走完整回退链（原稿表格漏了中间一步）                                                |
| `core_tag`        | `X-maafwY` 配对内核（同一配对取最新）                                                                                    | 不变                                                                                                                                         |
| `artifact_prefix` | `project.displayName` → `project.slug`，逐个过 `SAFE_PREFIX_PATTERN`                                                     | 适配：保留 M9A 的闸门逻辑，**不要**引入桌面侧那套规范化（见适配点 5）                                                                        |
| `has_agent`       | `interface.json` `agent[]` 非空                                                                                          | 不变                                                                                                                                         |
| `has_ocr`         | 语义 = "OCR 模型没入库，CI 必须重新铺"；判据 = `maa-project.json` 有 `ocr` 段（今天等价于 `ocr.source === 'submodule'`） | **新增**；名字与注释按真实语义写（见适配点 4）                                                                                               |
| `chaquopy_index`  | 手维护表 `{ "3.13": "https://chaquo.com/pypi-13.1/" }`，键 = 内核 CPython **次版本**                                     | **新增**：查不到时报错列出已知键；表放在 resolver 里，注释指向 MaaFwApp 的两处硬编码位置                                                     |
| `chaquopy_pins`   | 读 `requirements.txt`，命中原生包降级表才输出                                                                            | **新增**：输出形如 `--exclude pillow --require pillow==11.0.0`，**只对 requirements 里实际出现的包**输出，避免给没用到 pillow 的项目强加依赖 |

适配点详情：

1. **maafw 版本来源与钉版落点（核验纠正：原稿钉错了文件）**。
    - resolver 读 `requirements.txt`（与 M9A 一致，多行正则 `^maafw==X` 也兼容 uv export / pip freeze 的带 hash 续行）；
    - 但 `requirements.in` **不是**可以手工钉版的地方：`--update python-deps` 会用内联脚本从 `pyproject.toml` 的 `[project].dependencies` 重新生成它，再 `uv lock` + `uv export … --output-file requirements.txt`。往 `.in` 模板里渲染钉版，下一次 update 就会被冲掉；
    - 所以钉版的**源头**是 `templates/agent/pyproject.toml` 的 `dependencies`：agent + android 组合下渲染成 `"maafw=={{maafwVersion}}"`；
    - 为了让"用户没跑过 `--update python-deps`"的首次 CI 也能出包，同时把 `templates/agent/requirements.txt` 的占位渲染成 `maafw==X`（它和 pyproject 的钉版由 doctor 盯着不漂移，见 §8.6）；备选是只靠下面的回退链，代价是首次出包依赖回退；
    - 回退：`requirements.txt` 无钉版时取 `maa-project.json maafw.version`（须精确），两者不一致沿用 M9A 的 `::warning::`（以 requirements 为准）；
    - 两者都拿不到精确版本（只有 channel）时——agent 项目报错并给指引；scaffolding 侧不硬拦，只登记 `pending`（见 §8.4）。
2. **必须显式传 `--core-tag`**：`build_agent_bundle.py` 的默认内核 tag 是字面量常量 `3.13.15-maafw5.13.0`，会随上游漂移（它已经落后于本项目 requirements 里的 maafw 版本），绝不能靠默认值。
3. **Chaquopy 索引是"追加"而不是"替换"（核验纠正）**：`build_agent_bundle.py` 里 `EXTRA_INDEX = https://chaquo.com/pypi-upstream/` **永远**在索引列表的第一位，`--extra-index-url` 只是往上追加（脚本 help 原文 "always included"）。所以：
    - `--extra-index-url https://chaquo.com/pypi-13.1/` 仍然必须显式传（版本化索引要在列表里），但理由是"追加"，不是"覆盖默认值"；
    - 因为 PyPI upstream 永远在列表里，**真正保证装到 ABI 可用版本的是 `chaquopy_pins`**（把原生包钉到 Chaquopy 索引上的版本），不是索引本身。除 pillow 外，numpy 这类带 `.so` 的包应逐步进表；至少在解析失败时的报错里提示"该包需要钉到 Chaquopy 索引上的版本"；
    - `pypi-13.1` 的 `13.1` 是 Chaquopy 自己的发布线，不是 CPython 版本，**没有** CPython→URL 的公开公式；`chaquopy_index` 就是一张手维护表，键写内核 CPython 次版本（`3.13`），值指向该发布线。
4. **`has_ocr` 的语义（核验纠正）**：base 模板无条件生成 `resource/base/model/ocr/*`，所以每个项目"都有 OCR"；差别只在模型是否入库——`ocr.source === 'submodule'` 时这些文件进 `.gitignore`，CI 必须重新铺；走 download 时模型是入库的，这一步只是可选。判据用"`maa-project.json` 有 `ocr` 段"今天恰好等价于"走 submodule"（只有那个分支才写 `config.ocr`），但名字与注释要按真实语义写，别写成"项目未必有 OCR"。
5. **`artifact_prefix` 与桌面命名（核验纠正，接受分叉）**：M9A 的 `artifactPrefix` 没有"空格转 `-`、折叠、去首尾 `-`"的规范化，也没有"规范化后再查 `SAFE_PREFIX`"的第二道判断——就是 displayName → slug 的循环 + 一次 `SAFE_PREFIX_PATTERN`（`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`），两者都不合格才报错。而桌面侧 `releaseArtifactName` 保留 Unicode 字母（`\p{L}\p{N}`）并把空白换成 `-`。两者对 ASCII 名字一致，对中文/带空格 displayName **必然分叉**（桌面出 `我的项目-…zip`，APK 前缀退回 slug）。结论：
    - 保留 ASCII 闸门（应用内更新按资产名选包，前缀必须安全），把"非 ASCII displayName 时 APK 用 slug"写成明确行为 + fixture 覆盖；
    - 桌面那个函数是私有实现，resolver 模板无法共享，必然是两份代码：加一条对齐测试（同一批 fixture 下，ASCII 名字两边结果相同）。
6. **`process.exit()` 禁用**的注释与 `.then` 收尾模式原样保留（Windows libuv 竞争问题）。

## 6. CI 模板

### 6.1 `templates/addons/android/.github/workflows/android.yml`（入口，静态无占位符）

入口不带 Node 版本占位符，可以完全静态（真正的版本单一来源约束落在 6.2）。

```yaml
name: Build Android APK

# push / PR / 手动触发出 debug 包；正式发布由 release.yml 在 v* tag 上调
# android-build.yml 出三包并收口进 Release。

on:
    push:
        branches: [main, master]
        paths:
            - "Android/**"
            - "agent/**"
            - "tasks/**"
            - "resource/**"
            - "resource_*/**"
            - "data/**"
            - "locales/**"
            - "interface.json"
            - "maa-project.json"
            - "pyproject.toml"
            - "requirements.txt"
            - "uv.lock"
            - "logo.png"
            - "logo.ico"
            - "CONTACT"
            - "LICENSE"
            - "tools/android-packaging.mjs"
            - ".github/workflows/android.yml"
            - ".github/workflows/android-build.yml"
    pull_request:
        paths: [与上面同一份列表]
    workflow_dispatch:
        inputs:
            assemble:
                description: "debug 或 release（release 仅出签名工件，不发布）"
                type: choice
                options: [debug, release]
                default: debug
            maafw_tag:
                description: "MaaFramework release tag；留空按 maa-project.json / requirements.txt 解析（与桌面同源），填 latest 取 GitHub 最新（会破坏 APK 内前后端同版本，一般不用）"
                required: false
                default: ""

concurrency:
    group: android-${{ github.ref }}
    cancel-in-progress: true

permissions:
    contents: read

jobs:
    build-android:
        uses: ./.github/workflows/android-build.yml
        with:
            assemble: ${{ github.event_name == 'workflow_dispatch' && github.event.inputs.assemble || 'debug' }}
            maafw_tag: ${{ github.event.inputs.maafw_tag }}
        secrets: inherit
```

触发列表按"进包内容 + 版本来源"取全集（核验纠正）：原稿漏了 `logo.png` / `logo.ico`（§8.5 让用户把 `logo.png` 放仓库根，而 `Android/**` 覆盖不到它）、`CONTACT` / `LICENSE`（都在默认 include 白名单里，改了包内容会变）、`resource_*/**`、`pyproject.toml` / `uv.lock`。M9A 的清单里这几个都有。模板里 `pull_request.paths` 要把同一份列表抄全（YAML 锚点可以用，但别写成文档里的"同上"占位）。

### 6.2 `android-build.yml`（可复用）

以 M9A 版为基线，结构 `library-resources` + `build`（debug / universal）+ `abi-split`（release 单 ABI）三个 job。相对 M9A 的差异（每条都有理由，写进模板注释）：

1. **runner 统一 `ubuntu-latest`**：MaaFwApp 的 `library-resources` 在 M9A 里本来就是 ubuntu，build/abi-split 用 macos 只是为了 `runner.os` 天然分开缓存（M9A 注释原话），通用模板统一 ubuntu，缓存 key 自带 scope。
2. **JDK 17**：`INTEGRATION.md` 的基线（`JavaVersion.VERSION_17`），MaaEnd 的 apk job 也是 ubuntu + 17 且真在跑；M9A 三个 job 都用 25。留注释说明先例；**JDK 17 能否扛住 compileSdk 37 那套 AGP 要在实施时验证**（`library-resources` 是最便宜的探针），挂了就三个 job 一起抬到 21/25，不要只抬一个。
3. **SDK / NDK / CMake 要钉版本**：`INTEGRATION.md` 只给 JDK 一个数，其余得从 M9A 抄——NDK `29.0.13113456`、CMake `3.22.1`（外壳自己的 `app/build.gradle.kts` 也是 3.22.1），外壳的 compileSdk 37 / targetSdk 36 / minSdk 28 由它自己的 gradle 决定，runner 上按 `sdkmanager` 装齐。
4. **workflow 必须渲染 `{{nodeMajor}}`**：OCR 同步步骤跑的是 `pnpm dlx create-maa-project@latest --update ocr-models`，需要 Node（+ pnpm）。仓库规则是生成物里的 Node 版本一律来自 `SUPPORTED_NODE_MAJOR`，不允许写字面量；同时把新模板加进 `tests/node-support.test.ts` 的守卫清单。（原稿"两个 workflow 都静态无占位符"作废：入口可以静态，这个不行。）
5. **keystore 缺失降级（借 MaaEnd）**：release 时未配置 `KEYSTORE_BASE64` 打 `::warning::` 继续出**未签名**包，并让 `KEYSTORE_PATH` 这时为空（MaaFwApp 只在 `KEYSTORE_PATH` 非空时才配签名）。M9A 是解出空 jks 后仍然配置签名，一路拖到构建深处才失败。签名 Secret 只在 release 且已配置时交给构建 env。
6. **OCR 同步条件化**：`Sync OCR models` 步骤与 node/pnpm 安装步骤加 `if: steps.maafw.outputs.has_ocr == 'true'`（M9A 无条件跑；语义见 §5 适配点 4）。
7. **Chaquopy 参数来自 resolver**：`build_agent_bundle.py` 调用改为
   `--core-tag ${{ steps.maafw.outputs.core_tag }} ${{ steps.maafw.outputs.chaquopy_pins }} --extra-index-url ${{ steps.maafw.outputs.chaquopy_index }}`，去掉硬编码的 pillow==11.0.0 / pypi-13.1。
8. **APK 自检的库清单（核验纠正）**：无条件校验外壳自己声明"缺了 native 侧起不来"的那三个：`libMaaFramework.so`、`libMaaUtils.so`、`libMaaAndroidNativeControlUnit.so`；`libMaaAgentServer.so` 只在 `has_agent == 'true'` 时校验（MaaEnd 校验它是因为它自带 agent；纯 pipeline 的包可能没有它，无条件断言会把好包判死）。第 8 条之外保留 MaaEnd 的做法：出包后按目标 ABI 逐个 `unzip -l` 检查 `lib/<abi>/<lib>`。
9. **`local.properties` 的值**：`pi.profile` 传**绝对路径**（M9A 用 `${GITHUB_WORKSPACE}/Android/profile.yaml`），因为它是相对 Gradle 根项目解析的；`build.*Abi` 按 assemble 写；`sdk.dir=${ANDROID_HOME}`。
10. **重命名校验**：保留"预期恰好一个 APK"计数断言与 `prefix-android-<abi>-<tag>.apk` 命名（tag 中 `/` 转 `-`；universal 无 ABI 段）。
11. **保留** M9A 的：`library-resources` job（`gradlew verifyReleaseResources` 提前炸 MaaFwApp#34 类问题）、不缓存 MaaFramework zip 的注释及理由、`.maafw` 按 core_tag+scope 的缓存、R8 mapping 上传（universal release，只上传工件、不进 Release 资产）。

骨架（完整步骤顺序）：

```text
library-resources:  JDK17 + Android SDK → gradlew verifyReleaseResources
build:              checkout(submodules) → JDK17 → SDK → NDK/CMake(钉版本) → Python3.13
                    → resolver(node tools/android-packaging.mjs)
                    → [has_ocr] pnpm+node → pnpm dlx create-maa-project@latest --update ocr-models
                    → [has_agent] cache .maafw → setup_maa_framework.py(--abi per ABIS)
                    → build_agent_bundle.py(--abi per ASSEMBLE, --core-tag/--extra-index-url 来自 resolver)
                    → local.properties(sdk.dir / pi.profile=绝对路径 / build.*Abi)
                    → [release] decode keystore(可降级为未签名)
                    → gradlew assembleDebug|assembleRelease
                    → rename + unzip 自检 → upload artifact(+mapping)
abi-split(release): 同 build，但单 ABI、build.releaseAbi=<abi>、必签名
```

## 7. release.yml 挂钩（github addon）

`templates/addons/github/.github/workflows/release.yml` 与 `src/templates.ts`：

1. **必须把 APK 加进 Release 资产（核验纠正，原稿漏了）**：模板的上传段现在只有 `release-assets/*.zip` 与 `release-assets/*.tar.gz`，android job 的产物会被 download 下来却挂不上去。启用 android 时要在 `files:` 里加上 `release-assets/*.apk`（M9A 的 release.yml 正是 `*.zip` + `*.tar.gz` + `*.apk`，且 `needs` 里带 android 的 job）。用显式后缀 glob，不要让 R8 mapping 之类的工件跟着进 Release 资产。
2. **占位符锚点只有一个**：模板里是 `{{gitCliffJob}}  release:` 这一行（`gitCliffJob` 渲染成 `  <job>\n`）。新增的 `{{androidPackageJob}}` 挂在同一个锚点，`releaseNeeds` 由现在的二选一三元表达式改成"按已启用 addon 集合计算"（`package` / `[package, android]` / `[package, git_cliff]` / `[package, android, git_cliff]`）。`tests/scaffold.test.ts` 里有若干对 release.yml 内容的断言（`needs:`、`not.toContain(...)`），一并更新。
3. **注入的 android job 要加 tag 门**：`if: startsWith(github.ref, 'refs/tags/')`。只写 `always() && !failure() && !cancelled()` 的话，`workflow_dispatch` 时 `package` job 被 `if: github.event_name != 'workflow_dispatch'` 跳过，而 android job 仍会跑一整轮 release 打包，产物无处可去。

```yaml
android:
    if: startsWith(github.ref, 'refs/tags/')
    needs: package
    uses: ./.github/workflows/android-build.yml
    with:
        assemble: release
    secrets: inherit
```

4. `android` addon 未启用时 `{{androidPackageJob}}` 为空串、`releaseNeeds` 退回 `package`（或 `[package, git_cliff]`），**release.yml 与现状逐字节一致**。
5. `android` 启用但 `github` 未启用：无 release.yml，`android.yml` 入口独立可用（手动 dispatch release 只出工件）。

## 8. scaffolding 集成

1. **submodule（核验纠正：现成机制不是 `git submodule add`）**。OCR 那套机制实际做的是：
    - 合并/追加 `.gitmodules` 段落（幂等，重名自动 `-1` 后缀，记录 `branch = main` 供升级用）；
    - `git clone --depth 1 <url> <path>`（`git submodule update --init` 失败时也回退到 clone，因为没有 commit 时 gitlink 还没进 index）；
    - **gitlink 的登记靠新项目收尾的 `git add --all` + 首次提交**（`maybeInitializeGit`，默认开启，`--no-git` 关）。这条路径只在"新建项目且没有 pending"时走，`--add android`（增量）不走 → 增量路径必须自己 `git add Android/MaaFwApp`（或明确在 pending 指引里让用户提交），否则 CI 的 `checkout --submodules recursive` 会拿到**空目录**，"submodule 锁 commit"也不成立；
    - 失败降级：拉取失败不阻断创建，登记 `pending`（`kind: 'android-submodule'`，`command` 给出可复制的 `git submodule add -b main <url> Android/MaaFwApp`）——与 OCR 的 pending 同构，人类输出与 JSON report 都能看到；`Android/README.md` 里再放一份同款命令作为兜底说明；
    - **回滚范围要定**：OCR 用 `createPathCheckpoint` 包住 `resource/base/model/ocr` 整段；android 的对应物是 `Android/`，而它下面躺着刚 clone 出来的整个外壳仓库。实现时要么把 checkpoint 限定在 `Android/` 下除 `MaaFwApp/` 之外的内容，要么明确接受"回滚顺带删掉 clone"（然后由 pending 指引重来），不要默认沿用整目录 checkpoint。
2. **`.gitignore`**：不能只在 base 模板里按条件追加——`.gitignore` 是 `once` 文件，而 `--add android` 发生在创建之后。复用 OCR 的"标记段落"同步（`syncOcrGitignoreForSource` 那套：有注释头 + 单行、可加可删），为 `Android/agent-dist/` 加一段。`projectGitignore()` 现在只吃一个布尔参数，要么再加一个开关，要么改成按 addon 集合生成。
3. **profile 拷贝**：`profile.pipeline.yaml` / `profile.agent.yaml` 按是否有 agent 二选一，替换 `{{slug}}`（小写化）、`{{displayName}}`。
4. **requirements 钉版**：落在 `pyproject.toml` 的 `dependencies`（见 §5 适配点 1），并同步 `requirements.txt` 占位；`maa-project.json` 的目标版本是唯一事实源，由 doctor 盯不漂移。只有 channel、拿不到精确版本时**不硬拦**（硬拦会毁掉 `--yes --no-interactive` 与 `--report` 路径），登记 `pending`（`kind: 'android-version'`，`command` 给出钉版该改哪一行）；交互式问询里可以提示优先选精确版本；CI 侧 resolver 的报错文案兜底。
5. **icon**：默认**不写** `app.icon`（用 MaaFwApp 自带图标，零额外输入）；`Android/README.md` 说明放 `logo.png` 到仓库根后取消注释 `icon: ../logo.png`，并提醒 `logo.png` 已在 `android.yml` 的 paths 列表里。不做 ico→png 转换。
6. **doctor**（`src/doctor.ts`，可选收尾项）：检查 submodule 已初始化且父仓库登记了 gitlink、`maa-project.json maafw.version` 与 `pyproject.toml` / `requirements.txt` 的钉版不漂移、`Android/profile.yaml` 存在且 `assets` 指向仓库根、`Android/agent-dist/` 在 `.gitignore` 里。
7. **新文件的 `managed` / `once` 分级**（这是被 `tests/templates.test.ts` 钉住的契约，也是 `docs/commands.md` 的两列，必须显式定）：

    | 文件                                  | 分级      | 理由                         |
    | ------------------------------------- | --------- | ---------------------------- |
    | `Android/profile.yaml`                | `once`    | 生成后归用户，配方是手维护的 |
    | `Android/README.md`                   | `once`    | 说明文档，用户会改           |
    | `tools/android-packaging.mjs`         | `managed` | 随 CLI 修 bug / 补映射表     |
    | `.github/workflows/android.yml`       | `managed` | 同上                         |
    | `.github/workflows/android-build.yml` | `managed` | 同上                         |

## 9. 文档交付

- `templates/addons/android/Android/README.md`：本地构建（JDK17 + Android SDK + Python3、`setup_maa_framework.py`、`build_agent_bundle.py`、`gradlew installDebug`）、四个签名 Secrets 的生成与配置、升外壳三行命令、"换资源要重新出包"的提醒、常见问题表（照 MaaFwApp `INTEGRATION.md` 摘编，标注权威文档位置）。
- `docs/commands.md` 与 `docs/commands.en.md`：addon 介绍、新文件集与 `managed`/`once` 两列、产物命名约定、Mirror酱 未来衔接说明。（核验纠正：原稿写的 `docs/manual` 不存在，`docs/` 下只有 `commands` / `json-report` / `mcp` 三组中英对照。）
- `skills/create-maa-project/SKILL.md`：addon 列表与参考段落要加 `android`（skill 里那份列表是手工维护的）。
- 两个 README 如需提及打包能力，同样补一节。

## 10. 测试计划

- **resolver 单测**（vitest，fixture 驱动，`ANDROID_PACKAGING_RELEASES_FIXTURE` 指 JSON）：
    - 纯 pipeline：channel-latest（stable 跳过 prerelease）、`maafw.version` 精确、两者都无 → 回退链完整；
    - agent：requirements 钉版、`maa-project.json` 回退、两者均无 → 报错文案；
    - 内核配对：正常、无配对（报错列出现有配对）、`AGENT_CORE_TAG` 应急 + 漂移 warning；
    - `chaquopy_index`：3.13 命中、未知 CPython 报错；
    - `chaquopy_pins`：requirements 含 / 不含 pillow 两种；
    - `artifact_prefix`：ASCII displayName 直通、带空格 / **中文 displayName 退回 slug**（明确行为）、两者都不合格报错；
    - `has_ocr`、`has_agent` 组合。
- **命名对齐测试**：同一批 fixture 下，resolver 的 `artifact_prefix` 与桌面 `releaseArtifactName` 在 ASCII 名字上结果一致（非 ASCII 的分叉是预期，单独断言）。
- **模板渲染测试**：两变体 profile 的选择与占位符替换；release.yml 挂钩的有 / 无两态渲染结果稳定（含 `*.apk` 资产段与 `needs` 组合）；`android.yml` / `android-build.yml` 渲染后 YAML 可解析；`android-build.yml` 出现 `{{nodeMajor}}` 渲染值。
- **契约测试**：`tests/templates.test.ts` 的 android 文件集 + `managed`/`once` 两列；`tests/addons.test.ts` / `tests/prompt.test.ts` / `tests/mcp.test.ts` 的 addon 列表与 `Supported incremental add-ons:` 文案；`tests/node-support.test.ts` 守卫清单加新 workflow。
- **增量路径测试**：`--add android` 在已有项目上走通、submodule 失败时降级为 pending、`.gitignore` 段落可加可删。
- **端到端**（手动验收清单，不进 CI）：分别 scaffold 纯 pipeline 与 agent 两个示例仓库 → push 触发 debug 包 → 装 APK 冒烟 → 手动 dispatch release 验证三包命名与未签名降级 → 示例仓库打 tag 验证 Release 收口（含 APK 出现在 Release 资产里）。

## 11. 实施切分

| #   | 内容                                                                                                                                                                            | 依赖 | 风险                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------- |
| 1   | `android-packaging.mjs` 搬迁 + 适配点 1-6 + 全量单测（addon 目录就位，不接线）                                                                                                  | 无   | 低，纯增量                            |
| 2   | addon 注册（含 `ADDON_CONFIG_KEYS`）、`addAndroid()`、profile 两变体、gitignore 段落同步、submodule 接入（含 gitlink 登记与 pending 降级）、requirements 钉版渲染、契约测试更新 | 1    | 中（submodule 降级与回滚范围要测）    |
| 3   | `android.yml` / `android-build.yml` 模板（含 `{{nodeMajor}}`、钉版 NDK/CMake、JDK 17 探针）+ 渲染测试                                                                           | 1    | 低                                    |
| 4   | release.yml 挂钩（`{{androidPackageJob}}` / `releaseNeeds` / `*.apk` 资产段 / tag 门）+ keystore 降级 + unzip 自检 + R8 mapping 不进资产                                        | 3    | 中（注意 android 未启用时渲染零差异） |
| 5   | 文档（addon README、`docs/commands.md` 中英、SKILL、两个 README）+ doctor                                                                                                       | 2    | 低                                    |
| 6   | 端到端验收（两个示例仓库全链路）                                                                                                                                                | 1-5  | —                                     |

## 12. 风险与开放问题

| 项                                | 说明                                                                                       | 对策                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| MaaFwApp 是个人上游               | tag / 破坏性变更节奏不可控                                                                 | submodule 锁 commit（依赖 §8.1 的 gitlink 登记）；升级走文档三行命令；`library-resources` job 提前暴露库级问题 |
| MaaAgentCoreAndroid 配对滞后      | 新 maafw 发布后内核未必已配对                                                              | resolver 报错文案已带指引（M9A 原样保留）+ `AGENT_CORE_TAG` 应急通道                                           |
| 内核默认 tag 与索引默认值都会漂移 | `build_agent_bundle.py` 的 `CORE_TAG` 是字面量（已落后于本项目 requirements）              | 两个参数都由 resolver 显式传入；不依赖脚本默认值                                                               |
| Chaquopy 索引映射表               | `13.1` 是 Chaquopy 发布线而非 CPython 版本，无公开公式；`pypi-upstream` 又永远在索引列表里 | 显式手维护表 + 未知版本报错列已知键；**正确性靠 `chaquopy_pins`**，内核升 CPython 时人工补表                   |
| 原生包降级表                      | Chaquopy 索引上的版本往往落后桌面（pillow 12.3.0 → 索引最高 11.0.0）                       | 表放 resolver 内随版本演进；只对 present 包生效；逐步纳入 numpy 等带 `.so` 的包                                |
| 命名一致性                        | 桌面保留 Unicode，APK 前缀必须 ASCII                                                       | 接受分叉：非 ASCII displayName 用 slug，写成明确行为 + fixture；加一条 ASCII 对齐测试                          |
| requirements 形态多样             | 手写 / pip freeze / uv export（带 hash 续行）                                              | 正则已兼容多行；钉版源头在 `pyproject.toml`，缺失时回退 `maa-project.json` 并 warning                          |
| JDK / runner 选择                 | MaaFwApp 文档基线是 JDK 17，M9A 三个 job 实际用 25；compileSdk 37                          | 模板统一 ubuntu + JDK 17，用 `library-resources` 当探针；挂了就三个 job 一起抬到 21/25                         |
| submodule 未登记 gitlink          | `--add android` 增量路径不会自动 `git add`                                                 | 增量路径显式登记或走 pending 指引；doctor 检查                                                                 |
| 回滚范围                          | `Android/` 下有 clone 出来的外壳仓库                                                       | checkpoint 排除 `MaaFwApp/`，或明确接受整目录回滚并给 pending 指引                                             |
| Node 版本单一来源                 | OCR 同步步骤需要 Node，模板不许写死版本                                                    | `android-build.yml` 渲染 `{{nodeMajor}}`，并加进 `tests/node-support.test.ts` 守卫                             |

## 13. 已核实依据（免再查）

上游事实逐条对本地 checkout 核验后的结论（"核验纠正"即由此而来）：

**已核实为准确**：

- `build_agent_bundle.py`：`CORE_TAG = "3.13.15-maafw5.13.0"` 是字面量常量（`--core-tag` 有默认值）；`EXTRA_INDEX = https://chaquo.com/pypi-upstream/` 永远在索引列表首位、`--extra-index-url` 只追加；参数全集 `--out`（必填）/`--abi`（可重复，缺省 arm64-v8a）/`--requirements`/`--require`/`--exclude`/`--no-deps`/`--extra-index-url`/`--core`/`--core-repo`/`--core-tag`/`--work`；产物布局 `<out>/<abi>/bundle/{bin/python3, prefix/, site-packages/}`；装到 Chaquopy 原生包时自己打印"把 `{bundle}/site-packages/chaquopy/lib` 加进 `LD_LIBRARY_PATH`"；`site-packages/pure.zip` 由它生成。
- profile：内置默认白名单 8 项与顺序完全一致；`include` 整体替换（`include: []` = 空白名单）；`.git`/`node_modules`/`.venv`/`__pycache__` 必删；`app.icon` 构建期读盘、只收 png/webp、与白名单无关；`app.id` 小写包段 → `com.aliothmoon.maafw.<id>`；`agent.abi` 省略等价 `["*"]`；`build.debugAbi` / `build.releaseAbi` 只从 `local.properties` 读（无 env 兜底）；controller 取所有 Adb 项、首项缺省。
- M9A 基线：3 个 job（`library-resources` ubuntu + JDK 25；build / abi-split macos + JDK 25，macos 只为缓存分区）；`library-resources` 跑 `gradlew verifyReleaseResources` 并注明 MaaFwApp#34；debug 只出 arm64-v8a、release 出 universal（双 ABI）+ 两个单 ABI 包；"恰好一个 APK"断言与 `prefix-android-<abi>-<tag>.apk` 命名，universal 不带 ABI 段（注释明写 `GitHubUpdate.selectAsset` 会绕过 universal 回退）；keystore 不降级、深处失败；`build_agent_bundle.py` 调用同时传 `--core-tag` 与 `--extra-index-url`；OCR 同步无条件跑（`pnpm dlx create-maa-project@latest --update ocr-models`）；pillow 钉 11.0.0 且理由写在注释里；agent 步骤按 `has_agent` 门控。
- MaaEnd 基线：apk job 在 ubuntu + JDK 17；缺 `KEYSTORE_BASE64` 时打 warning 出未签名包并让 `KEYSTORE_PATH` 为空；出包后 `unzip -l` 逐 ABI 校验 `lib/<abi>/*.so`。
- M9A 的 resolver：4 个输出（`maafw_tag` / `core_tag` / `artifact_prefix` / `has_agent`）；纯 Node 零依赖；`ANDROID_PACKAGING_RELEASES_FIXTURE` 离线 fixture；`AGENT_CORE_TAG` 仅对 agent 生效且要求 tag 带 `-maafw` 段；禁止 `process.exit()` 的原注释（Windows libuv 句柄析构竞争）；内核配对正则与"现有配对"报错文案；`maa-project.json` 是必读文件。
- `update.mirrorchyanRid` 字段存在、会压过 PI 的 `mirrorchyan_rid`（"可执行包"这一叫法只见于 M9A / MaaEnd 的配方注释，MaaFwApp 样例里没有这个词）。

**核验纠正（原稿写错的地方，正文已改）**：

1. `build_agent_bundle.py` 的索引不是"可被覆盖的默认值"，`pypi-upstream` 永远在列表里；
2. `artifact_prefix` 在 M9A 里没有空格→`-` 规范化，也没有第二道 SAFE_PREFIX 判断，只有 displayName→slug + 一次正则闸门；
3. `requirements.in` 是 `--update python-deps` 从 `pyproject.toml` 重新生成的，不能作为钉版落点；resolver 读的是 `requirements.txt`；
4. `has_ocr` 的判据等价于"走 submodule"，但"项目未必有 OCR"的理由不成立；
5. OCR submodule 机制不执行 `git submodule add`，gitlink 登记依赖首次提交；
6. `library-resources` 在 M9A 里就是 ubuntu + JDK 25，不是"全 macos"；
7. `INTEGRATION.md` 只给 JDK 17，NDK / CMake / SDK 版本要去 workflow 与 gradle 里抄；
8. controller 是"所有 Adb 项按序保留、首项缺省"，不是"只取一项"；
9. 路径解析要分三类：文件系统字段相对配方文件，`include`/`exclude` 相对 PI 根，`pi.profile` 相对 Gradle 根项目；
10. release.yml 的上传段没有 `*.apk`，不补就永远发不出 APK；
11. `tests/node-support.test.ts` 的守卫清单是显式文件列表，新 workflow 要自己加进去。

## 14. 实施记录（与 §1-§12 的偏离）

| 偏离                                                  | 原因                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本钉版只走 pending，不做交互问询                    | `maa-project.json` 在创建时永远是 `maafw.version: ""`（CLI 没有版本 flag，也没有网络解析步骤），所以创建 agent + android 必然拿不到精确版本。登记 `android-version` pending（命令 `create-maa-project --update python-deps`），`--add android` 时若配置里已有精确版本就把 `pyproject.toml` 的 `maafw` 一并钉住，再靠 uv 导出到 `requirements.txt` |
| `android` 不进交互式「全部」预设                      | 「全部」是推荐预设，加上它会在这条路径上拉一个外壳仓库（~5 MB clone）。它出现在「自定义」列表里，也在 `--add android` / MCP 的 addon 枚举里；「全部」的语义仍是"仓库功能"（`agent`、`resource-pack` 也不在其中）                                                                                                                                  |
| `.gitignore` 段落是「追加」而不是重生成               | `.gitignore` 是 `once` 文件，`--add android` 发生在创建之后：加 `Android/agent-dist/` 只能追加（与 OCR 的 `syncOcrGitignoreForSource` 同构），段落缺失时由 doctor 报出来                                                                                                                                                                          |
| submodule 的 clone 顺序是"先 clone，后写 .gitmodules" | 计划里的顺序（先登记后 clone）在 clone 失败时会留下一条指向空目录的 `.gitmodules`，而 pending 给的恢复命令 `git submodule add` 恰好会因为"已存在"而失败。先 clone 保证失败后仓库状态干净、恢复命令可直接复制                                                                                                                                      |
| gitlink 不再依赖首次提交，改为显式 `git add`          | 首次提交只在"没有 pending"时才发生（`maybeInitializeGit` 的既有规则），而生成的项目几乎总有 pending（node-deps / ocr-model / python-deps），于是 gitlink 会一直不入索引、CI 检出空目录。现在创建与 `--add android` 两条路径都显式 `git add Android/MaaFwApp`                                                                                      |
| doctor 检查多了两项                                   | 除 §8.6 的四项外还检查：`android-build.yml` 的 Node 钉版是否仍是本仓库下限；`pyproject.toml` 与 `requirements.txt` 的 maafw 钉版是否一致（uv 未导出时会被发现）                                                                                                                                                                                   |
| OCR 同步步骤与 pnpm / Node 安装的顺序                 | 计划把两者都按 `has_ocr` 门控——而该输出要 resolver 跑完才有。模板里 resolver 排在最前（跑在 runner 预装的 Node 上），pnpm / Node / OCR 三步都排在它之后，否则门控读到空串、有 OCR 的项目会被静默跳过                                                                                                                                              |
| `app.id` 不是 slug 直填，而是转成包段                 | §4.1 只写了"slug 需小写化"，但外壳的 `APP_ID_PATTERN` 是 `[a-z][a-z0-9_]*(\.…)*` 的包段规则：连字符会**直接让 Gradle 构建失败**（`app.id must be lowercase package segments such as m9a or maa.end`）。现在 `-` → `_`、数字开头加前缀 `p`，doctor 也会检查手改后的 `app.id`                                                                       |
| 配方多了一段注释化的 `display:`                       | 外壳的 `display.foreground` 默认 `true`（前台虚拟屏），M9A 因为自己的资源按 1280×720 调过才关掉它。通用模板不替每个生成项目做这个取舍，只在配方注释里给出可复制的写法                                                                                                                                                                             |

### 14.1 复核后改掉的四处 resolver / workflow 行为

上面几行是随切片落地时的偏离；下面四条是**后来复核时改的**，§5、§7、§10、§12 里对应的旧描述以本节为准。
2026-10-12 用真实 GitHub + chaquo.com（不带任何 fixture）跑过 resolver 复核：`maafw==5.12.3` → 内核
`3.13.15-maafw5.12.3`、pins `--exclude pillow --require pillow==11.0.0`；`maafw==5.15.0`（内核当时最高
配到 5.14.2）→ 降级到 `3.13.15-maafw5.14.2` 并打 warning；`loguru`（索引没有）= 不钉。

| 变更                                | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chaquopy_pins` 改为按索引探测      | §5 的 `CHAQUOPY_PINS` 硬编码降级表（pillow → 11.0.0）取消：resolver 现在逐包抓 Chaquopy 索引的 simple 页面，按 wheel 文件名的 python 标签判断"桌面 pin 在索引上有没有当前 CPython 的构建"，没有就钉到索引最高可用版；索引上没有该包 = 纯 Python 走 upstream 不钉；索引有构建但没有当前 CPython 的**直接报错**（不再静默按 upstream 装）。内核自带包（`CORE_PROVIDES`，实测 `agent-core.json` 的 provides = maafw / numpy / strenum）不探测，因为 `build_agent_bundle.py` 会把它们整包丢弃。人工兜底表 `CHAQUOPY_PIN_OVERRIDES` 平时为空，只用于索引页面异常时强制版本。离线用 `ANDROID_PACKAGING_CHAQUOPY_FIXTURE`（`{包名: [wheel 文件名]}`）。发行名按 PEP 503 不区分大小写比对——索引里仍有 `Pillow-7.0.0-…` 这类大写文件名 |
| 内核配对缺失时降级而不是报错        | §5 的"内核还没出该配对就直接报错"改为：降级到**不高于固定版本**的最高配对并打 `::warning::`（含降级前后版本），因为绑定与 client 原生库都取自同一个内核 tag，APK 内仍前后端同版本，漂移的只是相对 `requirements.txt` 的版本差；内核发版后降级自动消失。固定版本比内核**所有**配对都旧时仍然报错并列出现有配对（那多半是版本写错，不做"升级"猜测）。版本比较也改为按「数字段 + 后缀」比，`5.13.0b6` / `5.15.0-beta.1` 这类预发布不再被 `Number()` 解析成 NaN                                                                                                                                                                                                                                                                   |
| APK 自检改为整行精确匹配            | `unzip -l \| grep "lib/$abi/$lib"` 是子串匹配（`.` 当通配符、`libMaaFramework.so` 也能命中拼接名），改成 `unzip -Z1` 列出条目名后 `grep -Fxq` 整行全等，并加了一行 `[OK]` 证据；universal 包查两个 ABI，单 ABI 包只查本机 ABI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| release 挂钩改为并行 + 签名材料分档 | §7 让 android job `needs: package`，等于让 APK 排在桌面包之后串行开工；现在它是 `package` 的兄弟 job（`release` job 的 `needs` 同时等两者），两条流水线并行、收口仍等齐。签名材料缺失也不再一律降级：手动 dispatch / fork 继续出未签名工件（打 `::warning::`），**`v*` tag 上直接失败**——未签名 APK 装不上、也进不了应用内更新，正式发版缺签名材料就该当场炸                                                                                                                                                                                                                                                                                                                                                                  |

### 14.2 三个已知取舍（2026-10-12 决定：不改代码，也不加兜底）

复核时提出的三条残留风险，逐条决定如下。它们都写在对应代码注释旁边，改动前先读这一节——三条都是
权衡后的选择，不是漏改：

| 取舍                                          | 决定与理由                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 探测不看平台标签（只看 python 标签）          | **不动。** debug 包只打 arm64、release 才双 ABI，而 resolver 不知道本次 `assemble`；按"两个 ABI 都有才算可用"筛会把 debug 明明能用的版本误杀，把 ABI 传进 resolver 又要改 workflow 契约。真缺某个 ABI 时 pip 的架构报错比静默钉错版本好排查（pillow 11.0.0 的 cp313 两个 ABI 都在，实测通过） |
| chaquo.com 非 404 直接失败、无静默回退        | **保持大声报错。** 发版路径吃第三方可用性是明确代价，换"探测没跑成"不会伪装成"这个包是纯 Python、不用钉"。将来要兜也只对超时 / 5xx 做有限次重试，仍然失败；**不要**变成"探测失败就当纯 Python"                                                                                                |
| `Android/README.md` 用 `<chaquopy_pins>` 占位 | **保持给人抄。** README 是 `once`，生成时还没有索引结果可填；本地出包本来就要先跑一次 resolver（README 第 1 步），拿它的 `chaquopy_pins` 替换占位符                                                                                                                                           |
