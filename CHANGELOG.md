# Changelog

本文件记录 dsh-hmos-emulator 的有意义变更,遵循 [Keep a Changelog](https://keepachangelog.com/) 与 [Semantic Versioning](https://semver.org/)。

## [0.1.0] - 2026-09-07

### Added

- better-sidebar 侧边栏标签「鸿蒙模拟器」。
- 模拟器实例:一键「扫描可用」、下拉/单选、▶ 启动 / ■ 停止(启动/停止后自动刷新实例与设备状态)。
- 应用项目:「查找目录」(默认当前会话工作目录)+「浏览」(系统目录选择)+「扫描」(填充项目下拉,默认选中第一个)。
- 部署目标:只读自动选中的设备(优先运行中的模拟器串号),一键「构建并部署」`devecocli run`。
- 调试输出框(清空/自动滚动/状态着色)。

### Changed

- 产品化卡片布局(统一圆角/间距/按钮体系),图标改用 iconfont 矢量内联 SVG(currentColor)。
- 文案统一使用「项目/查找目录/浏览」等更易理解的词汇。

### Fixed

- 宿主/客户端 **崩溃隔离**:`apply` 全 `try/catch`、非阻塞等服务,异常不影响 DSH 启动与使用。
- 修复 `hdc list targets` 的 `[Empty]` 污染设备列表、下拉高亮 `accentSoft` 缺失、`rpc` 参数/readBody 类型、TDZ、残留状态引用等问题。

### Engineering

- 标准 DSH 插件结构:`src/`(TS)+ `scripts/build.mjs`(esbuild 打包)×→ `lib/`(宿主 ESM + 客户端 `__ModuleLoader__` 产物)。
- 类型化(本地 `Ctx` 类型)、`tsconfig`、`vitest` 冒烟、GitHub Actions(`install --frozen/build/typecheck/test`,Node 20/22)、`pnpm-lock.yaml`+`pnpm-workspace.yaml`。
- 提交遵循 Conventional Commits。
