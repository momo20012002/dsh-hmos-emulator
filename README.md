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

纯 JS 源码,无需构建。改完 `lib/*.js` 后,因 bundle 走 profile 的 link 依赖,需在 profile 目录重新 `pnpm install`(重建 link)并硬刷新浏览器;仅宿主侧改动需重启 `dsh web`。

> ⚠️ **`lib/client.js` 必须是 DSH 客户端插件的官方产物形态**:整文件以
> `window.__ModuleLoader__.load({ id: 'dsh-hmos-emulator', factory: (require) => { … return module.exports; } })`
> 包裹、内部用 `require('react')`,结尾 `exports.apply = apply; return module.exports;`。
> 不要改回裸 ESM(`import`/`export`),否则会被 client-modules loader 整链拒绝(报
> `loaded without registering … via __ModuleLoader__.load`)。参照已装插件的 `lib/client.js`。

目录结构:

```
dsh-hmos-emulator/
├─ package.json        # main=宿主,exports[./client]=浏览器 bundle,dsh.client.platform=web
├─ cordis.patch.yml    # 宿主行 mount(loader 自动合并)
├─ lib/host.js         # 宿主:工具链探测 + devecocli/hdc 执行 + fs 浏览 + HTTP JSON API
├─ lib/client.js       # better-sidebar 标签注册 + React 面板
└─ README.md
```

## License

MIT
