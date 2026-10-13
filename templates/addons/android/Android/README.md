# Android 打包（MaaFwApp 外壳）

本目录把项目打成 APK：配方 `profile.yaml` + 外壳 `MaaFwApp/`（Git submodule，Aliothmoon/MaaFwApp）。

**权威文档在外壳里**，字段语义以它们为准，本文件只讲"这个项目怎么用"：

- `Android/MaaFwApp/INTEGRATION.md`：接入步骤、JDK 基线、签名与 ABI 说明；
- `Android/MaaFwApp/pi-profile.sample.yaml`：配方全部字段与默认值。

由 create-maa-project 维护的文件（`--update` / `--add android` 会覆盖，改逻辑请上游到 create-maa-project）：

| 文件                                  | 说明                                                |
| ------------------------------------- | --------------------------------------------------- |
| `tools/android-packaging.mjs`         | 解析 MaaFW 版本、内核 tag、资产前缀与 Chaquopy 参数 |
| `.github/workflows/android.yml`       | 入口：push / PR 出 debug，手动可选 release          |
| `.github/workflows/android-build.yml` | 可复用流水线：debug / universal / 单 ABI 三包       |

项目自己拥有的文件（生成一次，之后随便改）：`Android/profile.yaml`、本文件。

## 触发与产物

- push / PR 到 `main` / `master`：只出 debug 包（arm64-v8a），工件名 `debug-apk`。
- 手动 dispatch 选 `release`：出签名工件但不建 Release。
- 打 `v*` tag：`release.yml` 调 `android-build.yml` 出三包，与桌面包一起收口进 Release：

| 产物                            | 文件名                           |
| ------------------------------- | -------------------------------- |
| universal（arm64-v8a + x86_64） | `<前缀>-android-<tag>.apk`       |
| 单 ABI                          | `<前缀>-android-<abi>-<tag>.apk` |

前缀取 `maa-project.json` 的 `project.displayName`；非 ASCII 或带空白时退回 `project.slug`（应用内更新按资产名选包，前缀必须是 ASCII）。universal 包**故意不带 ABI 段**：带段会让应用内更新绕过 universal 回退。

## 本地出包

需要：JDK 17、Android SDK（含 NDK `29.0.13113456` 与 CMake `3.22.1`）、Python 3.13（只有 agent 项目需要）。

```bash
# 0. 外壳（首次）
git submodule update --init --depth 1 Android/MaaFwApp

# 1. 解析版本与参数（输出 core_tag / maafw_tag / artifact_prefix / chaquopy_*）
node tools/android-packaging.mjs

# 2. 铺 MaaFramework 原生库与（agent 项目）Python 运行时：在 Android/MaaFwApp 下执行
cd Android/MaaFwApp
python scripts/setup_maa_framework.py --abi arm64-v8a --tag <maafw_tag>

# 3. agent 项目才有：建运行时到 Android/agent-dist/<abi>/bundle
#    --exclude / --require 用上面 resolver 输出的 chaquopy_pins（它按 Chaquopy 索引逐包探测，
#    本地不要写死包与版本；没有原生包时该输出是空串，整段删掉即可）
python scripts/build_agent_bundle.py \
  --out ../agent-dist --abi arm64-v8a \
  --requirements ../../requirements.txt \
  --core-tag <core_tag> \
  <chaquopy_pins> \
  --extra-index-url https://chaquo.com/pypi-13.1/

# 4. 告诉 Gradle 配方在哪；pi.profile 相对 Gradle 根项目解析，所以给绝对路径
cat > local.properties <<EOF
sdk.dir=$ANDROID_HOME
pi.profile=$(pwd)/../profile.yaml
build.debugAbi=arm64-v8a
EOF

# 5. 出包（installDebug 直接装到已连接设备）
chmod +x ./gradlew
./gradlew assembleDebug
```

- **换资源 / 换任务 / 改 agent 代码都要重新出包**：它们是在构建期打进 APK 的，不是运行时读仓库。
- agent 项目要求 `requirements.txt` 里有精确的 `maafw==X`：Android 的 Python 绑定只随内核
  （`Aliothmoon/MaaAgentCoreAndroid` 的 `X-maafwY` tag）发布，CI 按它配对并与 APK 内的原生库同版本。
  本地跑一次 `create-maa-project --update python-deps` 即可（或把版本写进 `maa-project.json` 的
  `maafw.version` 后再跑一次 `create-maa-project --add android`）。
- `app.id: {{appId}}` 会拼成包名 `com.aliothmoon.maafw.{{appId}}`：外壳只收小写包段（字母 / 数字 /
  下划线，每段以字母开头），所以项目 ID `{{slug}}` 在这里做了转换（连字符 → 下划线，数字开头加前缀
  `p`）。改 `id` 等于换一个应用身份，装机与更新都会跟着变。
- 想在桌面图标之外用自定义图标：把 `logo.png` 放到仓库根，然后在 `profile.yaml` 里取消注释
  `icon: ../logo.png`（只收 png / webp，路径相对配方文件）。`logo.png` 已在 `android.yml` 的
  `paths` 触发列表里。

## 签名 Secrets

Release 出包需要四个仓库 Secret（Settings → Secrets and variables → Actions）。没配 `KEYSTORE_BASE64`
时：非 tag 的运行（手动 dispatch / fork）打 `::warning::` 并出**未签名**包（工件照样上传，只是不能上线）；
**`v*` tag 上直接失败**——未签名 APK 装不上、也进不了应用内更新。

```bash
keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 2048 -validity 10000 \
  -alias <KEY_ALIAS> -storepass <KEYSTORE_PASSWORD> -keypass <KEY_PASSWORD> \
  -dname "CN=<你的名字>, OU=<组织>, O=<组织>, L=<城市>, S=<省>, C=CN"

# 生成 KEYSTORE_BASE64
base64 -w 0 release.jks    # macOS: base64 -i release.jks
```

| Secret              | 值                 |
| ------------------- | ------------------ |
| `KEYSTORE_BASE64`   | 上面那条命令的输出 |
| `KEYSTORE_PASSWORD` | keystore 口令      |
| `KEY_ALIAS`         | 别名               |
| `KEY_PASSWORD`      | 别名口令           |

`release.jks` 不要提交（`.gitignore` 已覆盖 `*.jks` 之外的路径请自行确认）。

## 升级外壳

外壳是 submodule，锁的是 commit，上游怎么改都不会自动影响你；升级就是换 commit：

```bash
git submodule update --remote --depth 1 Android/MaaFwApp
git add Android/MaaFwApp && git commit -m "chore(android): bump MaaFwApp"
```

上游破坏性变更（配方字段、Gradle 任务名）只会在出包时暴露；`library-resources` job 会先跑
`gradlew verifyReleaseResources` 把库模块的资源问题提前炸出来。

## 常见问题

| 现象                                      | 原因与处理                                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI 报内核配对缺失                         | `MaaAgentCoreAndroid` 还没发不高于当前 maafw 的配对：确认 `requirements.txt` 版本没写错，或临时用 `AGENT_CORE_TAG` 指定别的内核 tag（应急通道，出包前撤掉）。精确配对尚未发布时 resolver 会降级到最高可用配对并打 warning |
| `pnpm check:py` 报外壳的 `scripts/*.py`   | 外壳是 vendored 的第三方代码，而 `release.yml` 会检出子模块：父项目必须把它排除出 ruff——`pyproject.toml` 的 `[tool.ruff]` 里要有 `extend-exclude = ["Android/MaaFwApp"]`。新项目自带这行，旧项目重跑 `--add android` 补上 |
| `checkout` 后 `Android/MaaFwApp` 是空目录 | 父仓库没登记 gitlink：`git submodule add -b main https://github.com/Aliothmoon/MaaFwApp.git Android/MaaFwApp` 后提交                                                                                                      |
| 应用内更新选不到包                        | 资产名前缀必须是 ASCII、universal 包不带 ABI 段；中文 displayName 时前缀会退回 slug                                                                                                                                       |
| `pillow` 之类的原生包装不上               | Chaquopy 索引上的版本落后桌面：resolver 会按索引探测并输出 `--exclude` / `--require`；索引有构建但没有当前 CPython 时直接报错                                                                                             |
| `libMaaFramework.so` 找不到               | 第 2 步没跑或 `--abi` 与 `build.*Abi` 不一致：APK 会宣称支持一个没铺库的架构                                                                                                                                              |
