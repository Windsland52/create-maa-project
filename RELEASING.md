# 发布指南

本文档描述 create-maa-project 的版本管理与发布流程。所有版本操作请遵循本文档，避免 CI 发布失败或产出错误版本号。

## 版本模型

- 版本号为语义化版本（SemVer），以 `v*` 形式打 tag（例：`v3.3.0`）。
- **版本号由 git tag 派生，不手动修改**：`scripts/sync-release-version.mjs` 在 CI 中把 tag 写入
  `package.json`、`pyproject.toml` 和 `py-wrapper/create_maa_project/__init__.py`。
- 因此仓库中检入的版本号（当前为 `0.1.0`）是占位值。**本地构建的产物上报 `0.1.0` 属正常**，
  不能据此判断发布是否正确——真实版本只在 CI 中由 tag 注入。
- tag 必须是 `v` 前缀的合法 SemVer，否则脚本直接抛错终止发布。
- 预发布 tag（如 `v3.3.0-beta.1`）的 GitHub Release 会被标记为 prerelease
  （`contains(github.ref_name, '-')`），但见下方「已知隐患」。

## 发布前检查

1. 确认工作区干净、所有变更已合入 `main` 且 CI 绿。
2. 在 `CHANGELOG.md` 中为**本次 tag 版本**写好条目（见下）。缺少该段会导致 `check` 任务失败，
   发布不会继续——这是有意设计，防止 Release notes 为空。
3. 本地跑一遍：

    ```powershell
    pnpm install --frozen-lockfile
    pnpm audit --audit-level high
    pnpm check
    ```

4. 用它验证 CHANGELOG 段落可被提取（与 CI 同一脚本）：

    ```powershell
    pnpm changelog:notes 3.3.0
    ```

5. 建议实测两个产物（npm bundle 与 SEA 单文件），确认创建流程正常。注意必须设置
   `CREATE_MAA_PROJECT_AUTO_UPDATE=0` 并加 `--skip-download`，否则会联网或把命令交接给线上版本：

    ```powershell
    pnpm build
    pnpm build:sea
    node dist/index.js <tmp>\demo --skip-download --no-git
    dist\sea\create-maa-project-win-x86_64.exe <tmp>\demo2 --skip-download --no-git
    ```

## CHANGELOG

`CHANGELOG.md` 由**人工精炼维护**：合并同类项、以用户视角描述效果，内部重构与 CI 细节通常不逐条罗列。
git-cliff 只作为「防漏检查表」（从 git 历史列出全部提交），**不会覆盖正式文件**。

```powershell
pnpm changelog:draft              # 生成草稿 CHANGELOG.draft.md（已 gitignore）
pnpm changelog:draft:unreleased   # 只预览未发布提交
```

`CHANGELOG.draft.md` 是一次性产物，已在 `.gitignore` 中忽略；正式的 `CHANGELOG.md` 是唯一事实来源，
`scripts/changelog-notes.mjs` 只读取它。

破坏性变更需要在提交信息里用 `!` 标记（如 `feat(addons)!: ...`）并附 `BREAKING CHANGE:` footer：
`.github/cliff.toml` 会渲染 `[**breaking**]` 标记，并把 footer 正文作为引用块附在该条目下方。footer
面向用户撰写，说明升级后要做什么。

## 发布流程

```bash
# 1. 写好 CHANGELOG.md 后提交
git add CHANGELOG.md ...
git commit -m "docs(changelog): add the 3.3.0 entry"

# 2. 打 tag 并推送（版本号来自 tag，无需手工改 package.json）
git tag -a v3.3.0 -m "v3.3.0"
git push origin main v3.3.0
```

tag 推送后触发 `.github/workflows/release.yml`，任务链如下（`needs` 决定顺序）：

| 任务               | 依赖                                | 行为                                                                                          |
| ------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `check`            | —                                   | 注入版本、`pnpm audit`、`pnpm check`、**校验 CHANGELOG 段落**、打包 npm 包并 smoke、生成 SBOM |
| `sea`              | `check`                             | 六个平台构建 SEA 单文件并各自 smoke：win/linux/macos × x86_64/aarch64                         |
| `release-manifest` | `sea`                               | 汇总发布清单 `create-maa-project-manifest.json`                                               |
| `release_notes`    | `release-manifest`                  | 用 `scripts/changelog-notes.mjs` 从 `CHANGELOG.md` 提取该版本段落为 Release body              |
| `github-release`   | `release-manifest`, `release_notes` | 创建 GitHub Release（附 6 个二进制、manifest、SBOM）                                          |
| `npm`              | `github-release`                    | 发布 npm 包（已存在同版本则跳过），带 provenance                                              |
| `pypi`             | `npm`                               | 构建并发布 Python wheel，安装后 smoke                                                         |

**必要的 secret**：`NPM_TOKEN`（npm 发布）。PyPI 走 Trusted Publishing，用 `id-token`，无需 token。

重复执行安全：npm 与 PyPI 都会跳过已发布的同版本（`skip-existing`），因此 tag 推送失败后重跑不会
产生重复发布。

## 回滚

- **npm 不能覆盖已发布版本**：`npm unpublish` 有 72 小时窗口与严格限制，优先发布修正版本
  （`v3.3.1`）而不是撤销。
- GitHub Release 可以删除并重建；SEA 二进制与 manifest 随 Release 一起替换。
- PyPI 同样不支持覆盖，只能发新版本。
- **不要移动或重建已推送的 tag**：已发布的版本号必须保持指向同一份内容。

## 已知隐患

- **`npm publish` 未带 `--tag`**，而 npm 对预发布版本号默认打 `latest`。因此打
  `v3.3.0-beta.1` 这类预发布 tag，会让 `npm install create-maa-project` 直接拿到 beta，
  而 GitHub Release 却标记为 prerelease，两处语义不一致。**在此修复前，预发布 tag 不适合用来试水**；
  如需 beta 通道，应先在 `release.yml` 的 npm 任务中按 `github.ref_name` 是否含 `-` 选择 `--tag next`。
- `check` 任务中的 CHANGELOG 校验只在 tag 触发时运行（`if: startsWith(github.ref, 'refs/tags/')`），
  普通 `main` 推送不会校验，因此缺失条目要在打 tag 后才会暴露。

## 相关文件

- `CHANGELOG.md`：正式变更记录，Release notes 来源。
- `.github/cliff.toml`：git-cliff 草稿配置（含 breaking footer 渲染）。
- `scripts/changelog-notes.mjs`：提取指定版本文档段落，缺失即非零退出。
- `scripts/sync-release-version.mjs`：把 tag 写入各版本文件。
- `scripts/smoke-cli-artifact.mjs`：CI 对 npm 包 / SEA / wheel 的产物冒烟检查。
- `scripts/create-release-manifest.mjs`、`scripts/create-sbom.mjs`：发布清单与 SBOM。
