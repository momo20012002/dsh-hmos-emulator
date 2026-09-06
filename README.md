# dsh-hmos-emulator

DSH better-sidebar 标签页插件 —— 一键**启动鸿蒙模拟器**、把选定的 **HarmonyOS 应用工程构建并部署到模拟器**。应用工程通过面板内置的**文件浏览器**(路径输入 + 逐级浏览 + 一键扫描工程)选择。

- 宿主端(`lib/host.js`,Node):调 `devecocli`/`hdc` 执行真实动作,经同源 HTTP JSON API(`/dsh-hmos-emulator/api/*`)暴露给浏览器。
- 客户端(`lib/client.js`,Web):向 `ctx.betterSidebar.registerTab(...)` 注册「鸿蒙模拟器」标签;better-sidebar 未启用时安全跳过,不影响其他插件。
- 零第三方运行时依赖:`node:` 内建 + `react`(peer)。

## 功能

| 按钮/控件 | 底层动作 |
|---|---|
| 应用工程 `浏览…` / 路径输入 | 宿主 `node:fs` 逐级列目录;`▣`=含 `build-profile.json5` 的工程根;可双击下钻 |
| `扫描工程` | 从当前目录起 ≤3 层递归查找鸿蒙工程根(自动跳过 `node_modules/oh_modules/.hvigor/.git` 等) |
| `列出模拟器/刷新` | `devecocli emulator list`(原始输出如实回显,含授权等错误) |
| `▶ 启动` | `devecocli emulator start <实例名>`(240s 超时;冷启动约 1–2 分钟) |
| `■ 停止` | `devecocli emulator stop <名称或串号>` |
| 部署设备下拉 | `hdc list targets` 解析在线设备(模拟器串号形如 `127.0.0.1:5555`) |
| `🚀 构建并部署到所选设备` | 在工程目录执行 `devecocli run --device <设备>`(构建+安装+启动,20 分钟超时) |
| 输出区 | 每次动作的原始输出(尾部 80 KB),成功/失败着色 |

## 工具链探测(无需配置即可用)

宿主端按顺序自动定位,找不到时面板会显示缺什么:

- **devecocli**(node CLI 入口):① 环境变量 `DSH_HMOS_DEVECO_CLI` → ② PATH 上 `devecocli` 垫片反推 npm 全局目录 → ③ `npm root -g`。
- **hdc**:① `DEVECO_SDK_HOME`(如 `<DevEco Studio 安装根>\sdk`)+ `default\openharmony\toolchains\hdc.exe` → ② PATH 上的 `hdc`。
- 也可在 `cordis.patch.yml` 的行配置里显式给 `config.devecoCliJs` / `config.sdkHome`。

## 安装(把插件挂到 web profile)

> 下列命令均在 **DSH web profile 目录**执行(Windows:`%USERPROFILE%\.dsh\profiles\web`),需要 `dsh` CLI;也可以直接手动改文件(见“手动安装”)。

### 方式 A:dsh CLI(推荐,自动追加依赖、bundle 列表并合并本插件的 `cordis.patch.yml`)

```powershell
cd %USERPROFILE%\.dsh\profiles\web
dsh plugin --profile web add <dsh-hmos-emulator 仓库路径>
pnpm install
# 重启 dsh web(或浏览器硬刷新 Ctrl+Shift+R)
```

### 方式 B:手动

1. `%USERPROFILE%\.dsh\profiles\web\package.json`
   - `dependencies` 增加:`"dsh-hmos-emulator": "link:<dsh-hmos-emulator 绝对路径>"`
   - `dsh.profile.bundles` 数组追加:`"dsh-hmos-emulator"`
2. 确认宿主行已挂载:本插件自带的 `cordis.patch.yml` 会被 profile 启动时合并;若你的 DSH 版本不合并包内 patch,则在 profile 的 `cordis.patch.yml` 里追加:

```yaml
- insert:
    - id: hmos-emulator
      name: dsh-hmos-emulator
```

3. `pnpm install` → 重启 `dsh web` / 浏览器硬刷新。

### 使用

刷新页面后打开 better-sidebar 的 `+` 菜单 → 「鸿蒙模拟器」(标签栏也可直接点)。首次进入会自动探测工具链并列出模拟器/设备。

## 常见问题

- **`devecocli emulator list/start` 报授权/协议未接受**:在 DSH 所在机器的终端手动执行一次 `devecocli emulator license accept`,接受后再回来点按钮。
- **`spawn EPERM` / Emulator.exe 相关**:Deveco 模拟器工具未注册或 DevEco Studio 未装模拟器镜像;请用 DevEco Studio 的 Device Manager 确认实例存在,或先在终端跑 `devecocli emulator list` 看真实报错(面板会原样回显)。
- **部署失败但输出没有具体错误**:devecocli 的 `run` 需要已签名的调试证书;多 `entry` 模块工程需要 `--module`(当前按钮固定走 `devecocli run --device <设备>`,如需高级参数可在面板日志给出的工程目录手动执行)。
- **找不到 hdc**:设置环境变量 `DEVECO_SDK_HOME` 后重启 `dsh web`。

## 开发/改动

改 `src/` 源码后,在插件目录执行 `pnpm install && pnpm build`(或 `node scripts/build.mjs`)重新生成 `lib/`。构建脚本用 esbuild 把客户端产物自动包成 `window.__ModuleLoader__.load` 形态——**不要手改为裸 ESM**(否则会被 client-modules loader 整链拒绝,报 `loaded without registering … via __ModuleLoader__.load`)。

源码用 **TypeScript** 编写并带类型:宿主与客户端各用一个**本地轻量 `Ctx` 类型**(仅声明用到的 `get`/`effect`),避免为独立仓库引入整个 DSH 类型图(`@deepseek-ai/cordis`、`@types/react` 等),因此在任意环境 `pnpm install` 后 `pnpm typecheck`(tsc)即可通过,无需 `@ts-nocheck`。

## 开发规范(类型约定)

- **上下文**:宿主/客户端 `apply(ctx)` 用本地 `Ctx` 接口(只 `get`/`effect`),**不** `import` `@deepseek-ai/cordis` 类型图。
- **组件 props**:`Panel`/`Icon`/`Btn`/`Dropdown`/`Card` 用**内联对象类型**标注参数;内部可用 `any` 收窄(如 `h` 来自 `require('react')`,不做深入推导)。
- **关键函数显式标注**:`rpc(method: string, body?: any)`、`runCli(argv, opts): Promise<{code,timedOut,output}>`、`readBody(req): Promise<string>`、`createApi(): Record<string,(payload?)=>Promise<any>>`。
- **用类型而非 `@ts-nocheck`**:`pnpm typecheck`(tsc) 应为零错误;新增代码请保持类型标注。
- peer(`dsh-better-sidebar`)由 DSH profile 提供,插件自身不安装——见 `pnpm-workspace.yaml`(`autoInstallPeers: false`)。

因 bundle 走 profile 的 link 依赖,改完需在 profile 目录 `pnpm install`(重建 link)并硬刷新浏览器;仅宿主侧改动需重启 `dsh web`。类型检查 `pnpm typecheck`(tsc),测试 `pnpm test`(vitest)。

目录结构:

```
dsh-hmos-emulator/
├─ src/
│  ├─ index.ts          # 宿主 half(name / apply):devecocli/hdc 执行 + fs 扫描 + HTTP JSON API
│  └─ client/index.ts   # 浏览器 half(apply / inject):better-sidebar 标签 + React 面板
├─ scripts/build.mjs    # esbuild 打包:src → lib(宿主 ESM + 客户端 __ModuleLoader__ 产物)
├─ lib/
│  ├─ index.js          # 宿主产物(ESM)
│  ├─ client.js         # 客户端产物(__ModuleLoader__ 封装)
│  └─ types/index.d.ts  # 类型声明
├─ test/plugin.spec.mjs # vitest 冒烟:宿主导出、客户端 __ModuleLoader__ 注册
├─ tsconfig.json        # 类型检查配置
├─ package.json         # 入口/exports/dsh 元数据/scripts/devDeps
├─ cordis.patch.yml     # 宿主行 mount(loader 自动合并)
├─ README.md
├─ LICENSE
└─ .gitignore
```

## 稳定性(崩溃隔离)

本插件做了**崩溃隔离**,保证即使自身出问题也**不影响 DeepSeek Harness 正常启动与运行**:

- 宿主/客户端 `apply()` 全部包在 `try/catch` 里:任何异常只打印日志、绝不抛出,避免中断 DSH 的 composition / client loader 加载链。
- 不使用硬依赖注入(`inject`)阻塞加载:宿主等待 `webServer`、客户端等待 `betterSidebar` 均用**非阻塞轮询**(服务就绪后才注册,缺失时静默等待/停止),绝不阻塞或拖垮启动。
- HTTP 路由处理器已捕获所有异常并以统一错误信封返回,单次请求失败不影响其它功能。

## License

MIT
