import { API, rpc } from './rpc.js'
import { Btn, Card, Dropdown, Icon, Popover, Segmented, card, field, label, row, s } from './components.js'
import { Ctx } from './ctx.js'
import { mountStatus, subscribeMount, switchMount } from './mount.js'
import { IC } from './icons.js'
import { LINT_TITLES, ansiRuns, cleanCliLine, exitCodeOf, fmtDur, lintStatusLine, shortPath } from './format.js'
import { notices, ACTION_PREFIX } from './notice.js'
import { preferenceStore } from './host-store.js'
import { deviceLabel, isRenderableComponent, keepScannedProject, mountSwitchTitle, pickDevice, pickModule, statusTone } from './view-model.js'
export const { createElement: h, useEffect, useRef, useState } = require('react')

/**
 * The release channel the user picked, or empty while they have never picked one — the panel then
 * follows whatever the installed build is. Like the mount preference this persists through the shell's
 * client store, so a reload, a `dsh web` restart or a browser restart keeps it.
 */
const channelStore = preferenceStore<string>('dsh-hmos-emulator:deveco-channel', '')

/** The emulator panel itself: one tab component plus the small helpers only it uses. */
// ── Design tokens (follow DSH theme variables; usable in light and dark) ──
export const logLine = (kind) => ({
  fontSize: 11, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  color: kind === 'err' ? s.danger : kind === 'ok' ? s.ok : kind === 'info' ? s.muted : s.fg,
})
export const warnBox = { background: 'rgba(229,72,77,.12)', border: `1px solid ${s.danger}`, color: s.danger, borderRadius: 8, padding: 8, fontSize: 12, marginBottom: 10, lineHeight: 1.5 }

// Keep the last screenshot in module scope so it survives a panel remount.
export let lastShot = null

/** The shell's dialog, as this panel uses it. */
interface HostDialog {
  readonly Modal: (props: any) => unknown
}

/**
 * Resolve the shell's dialog, lazily and never fatally.
 *
 * The panel loads on hosts that publish none of the shared primitives — the same rule the notice
 * banner follows — and the dialog is only needed once a switch is asked for. A confirmation belongs to
 * the shell's layer rather than this panel's chrome, so it takes the shell's own dialog; the buttons
 * inside it are this panel's own, which is one export less to depend on.
 * @returns the dialog, or null when this host does not publish one.
 */
function hostDialog(): HostDialog | null {
  try {
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives') as Partial<HostDialog> | undefined
    return isRenderableComponent(primitives?.Modal) ? primitives as HostDialog : null
  } catch {
    return null
  }
}

/**
 * The build of the workbench this page publishes, or '' when it reports none.
 *
 * Asked for two readers: the confirmation names it beside the destination, and the diagnostic line
 * records which build answered. One read, so the two can never disagree.
 * @param ctx - the client context.
 * @returns the version string the service reports, without decoration.
 */
function betterBuild(ctx: Ctx): string {
  const better = ctx && typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined
  return better !== undefined && typeof better.version === 'string' ? better.version : ''
}

/**
 * What the position choice does, in the words a user reads.
 *
 * One line, and only the part a user cannot work out: the panel opens where it was told to, and the
 * right column's own new-tab control is the way back when that open does not land. The steps through
 * that control live in the README, because the popover is a couple of hundred pixels wide and this sits
 * under a row the reader already understands.
 * @param mount - the switch's resolved status.
 * @returns the hint shown under the capsule row.
 */
export function mountDetail(mount: { effective: string }): string {
  if (mount.effective === 'none') return '当前没有可用的挂载位置,面板暂不显示。'
  return '切换后,若未自动打开,请在右侧栏的「新标签页」中重新打开。'
}

/**
 * What confirming a host switch does, shown as the body of the dialog the switch asks in.
 *
 * The title names the destination and the row under the capsule says how to get the panel back, so this
 * carries what the user is deciding about: the tab in front of them closes, and the panel comes up where
 * they asked for it. No host vocabulary and no detection report — which package answered is the capsule's
 * tooltip and the diagnostic log's business, not a question asked of the reader.
 * @returns the consequence sentence.
 */
export function mountSwitchNote(): string {
  return '当前栏的标签页将关闭,面板将在新位置打开。'
}

export function Panel(props: { scope?: { sessionId?: string; cwd?: string }; ctx: Ctx }) {
  const { scope, ctx } = props
  // Persist the last selection (project / scan dir / instance / module) to avoid re-picking.
  const LS_PREFIX = 'dsh-hmos-emulator:'
  const lsGet = (k) => { try { return localStorage.getItem(LS_PREFIX + k) || '' } catch { return '' } }
  const lsSet = (k, v) => { try { localStorage.setItem(LS_PREFIX + k, v) } catch { /* ignore */ } }
  // The last toolchain / instance / device answers are cached too, so the panel paints them
  // immediately and only refreshes them in the background — each probe costs a devecocli spawn.
  const lsGetJson = (k) => { try { const raw = lsGet(k); return raw ? JSON.parse(raw) : undefined } catch { return undefined } }
  const lsSetJson = (k, v) => { try { localStorage.setItem(LS_PREFIX + k, JSON.stringify(v)) } catch { /* ignore */ } }
  // localStorage is shared by every session of this origin, but a scan root and a project
  // belong to one workspace: keyed per session, so opening another session does not restore
  // the previous workspace's selection instead of its own.
  const lsSessionKey = (k) => ((scope && scope.sessionId) ? `${k}:${scope.sessionId}` : k)
  // An entry module name only means something inside the project it came from.
  const lsModuleKey = (p) => (p ? `module:${p}` : 'module')
  const [tc, setTc] = useState(() => lsGetJson('toolchain') || null)
  const [tcMsg, setTcMsg] = useState('')
  const [project, setProject] = useState(() => lsGet(lsSessionKey('project')))
  // Default the scan root to the session working directory. scope.cwd is optional and arrives
  // with the session list summary, so it is also applied later by the effect below.
  const [scanRoot, setScanRoot] = useState(() => lsGet(lsSessionKey('scanRoot')) || (scope && scope.cwd) || '')
  const scopeCwd = (scope && scope.cwd) || ''
  // Once the user types or picks a directory, the workspace default must not overwrite it.
  const scanRootEdited = useRef(false)
  const [projectOptions, setProjectOptions] = useState([])
  const [modules, setModules] = useState([])
  const [moduleSel, setModuleSel] = useState(() => lsGet(lsModuleKey(project)))
  const [emuRaw, setEmuRaw] = useState(() => { const cached = lsGetJson('emuRaw'); return typeof cached === 'string' ? cached : '' })
  const [emuTarget, setEmuTarget] = useState('')
  const [instances, setInstances] = useState(() => lsGetJson('instances') || [])
  const [instanceSel, setInstanceSel] = useState(() => lsGet('instance'))
  const [shot, setShotState] = useState(lastShot)
  const [copied, setCopied] = useState(false)
  const [lintReady, setLintReady] = useState(false)
  // Fix buttons stay locked until the matching check has shown what is in scope.
  const [fixReady, setFixReady] = useState({ changed: false, all: false })
  const [lintSec, setLintSec] = useState(0)
  // Which sidebar carries this panel. mount.ts owns the registration; the switch below only asks
  // for a move and shows what happened, including a refusal that leaves the request unchanged.
  const [mount, setMount] = useState(() => mountStatus())
  const [showMount, setShowMount] = useState(false)
  // The half the user picked, waiting for the shell's dialog: moving the panel takes its tab away from
  // this host, so the switch is a two-step action, not a one-click toggle. Empty while nothing waits.
  const [pendingMount, setPendingMount] = useState('')
  // Which channel the 更新 button installs from. '' follows the installed build; an explicit choice
  // is a set-once preference, so it sits behind the gear next to the mount switch.
  const [channelChoice, setChannelChoice] = useState(() => channelStore.getSnapshot())
  /** This panel's root node: what the version check's banner centers over. */
  const panelRef = useRef(null)
  /** This panel instance's token for the shared notice store; see `notices.own`. */
  const owner = useRef({}).current
  const cliChannel = channelChoice === 'stable' || channelChoice === 'latest'
    ? channelChoice
    : ((tc && tc.devecoCliChannel) || 'latest')
  const pickCliChannel = (next) => { setChannelChoice(next); channelStore.set(next) }
  useEffect(() => subscribeMount(() => setMount(mountStatus())), [])
  // One diagnostic line: which host services this page publishes right now, and whether the switch has a
  // dialog to ask in. A greyed half and a confirmation that looks unlike the expected one are both
  // derived from exactly these facts, so such a report arrives with its cause.
  useEffect(() => {
    const svc = mount.services
    const build = betterBuild(ctx)
    pushLog('info', `挂载探测:slots=${svc.slots ? '有' : '无'} sidebarRightTabs=${svc.tabs ? '有' : '无'} betterSidebar=${svc.better ? `有${build === '' ? '' : `@${build}`}` : '无'} 确认对话框=${hostDialog() === null ? '无' : '有'}`)
  }, [])
  const pickMount = (mode) => {
    const result = switchMount(ctx, mode)
    // A switch that is turned down says so in the banner — the one surface this panel reports in — and
    // that banner fades on its own, because a refusal needs no action.
    if (!result.ok) notices.say({ text: result.reason, tone: 'warning' })
    setMount(mountStatus())
  }
  /**
   * Carry out the switch the confirmation was asked about: the dialog's 切换 and the banner's action
   * both end here.
   */
  const confirmMount = () => {
    const next = pendingMount
    setPendingMount('')
    setShowMount(false)
    if (next !== '') pickMount(next)
  }
  /**
   * Ask before moving the panel, or answer why the pick cannot be honoured.
   *
   * The question goes to the shell's dialog when this host publishes one, and to its banner when it does
   * not — the banner is where this panel already reports, and a standing question there is dismissed by
   * the same click outside that closes a popover, so the cancel needs no button of its own. A host this
   * deployment cannot provide is answered by the banner too, and that one fades by itself.
   * @param next - the host the user picked.
   */
  const askMount = (next) => {
    if (next === mount.effective) return
    if (!(next === 'native' ? mount.nativeReady : mount.betterReady)) {
      // Refused now rather than after the click: the reason belongs to the moment the user asked, and a
      // host that cannot take the panel is never recorded as the choice. The switch produces that reason
      // itself, in one place.
      pickMount(next)
      return
    }
    if (hostDialog() !== null) { setPendingMount(next); return }
    notices.say({
      text: mountSwitchTitle(next, betterBuild(ctx)),
      action: { prefix: ACTION_PREFIX, label: '切换' },
      persist: true,
    }, () => { setShowMount(false); pickMount(next) })
  }
  // Screenshot viewport: zoom and pan share one atomic state (cursor-anchored zoom updates both).
  const [shotView, setShotView] = useState({ zoom: 1, x: 0, y: 0 })
  const shotBoxRef = useRef(null)
  // Update the module cache together with the state so a remount can restore it.
  const setShot = (v) => { lastShot = v; setShotState(v) }
  const [showRaw, setShowRaw] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const [manualSerial, setManualSerial] = useState('')
  const [manualType, setManualType] = useState('')
  const [manualOs, setManualOs] = useState('')
  const selInst = instances.find((it) => it.name === instanceSel)
  const selTone = statusTone(selInst?.status)
  const selToneColor = selTone.tone === 'ok' ? s.ok : s.danger
  const toggleManual = () => {
    const next = !showManual
    setShowManual(next)
    if (next && selInst) {
      setEmuTarget((v) => v || selInst.name || '')
      setManualSerial((v) => v || selInst.serial || '')
      setManualType((v) => v || selInst.deviceType || '')
      setManualOs((v) => v || selInst.osVersion || '')
    }
  }
  const [devices, setDevices] = useState(() => lsGetJson('devices') || [])
  const [device, setDevice] = useState('')
  // Deploy target: an explicit pick (auto/manual/device dropdown) wins, else the instance serial.
  const targetDevice = device || (selInst && selInst.serial) || ''
  const [busy, setBusy] = useState('')
  // Label of the check running right now ('' when none), used by the live progress line.
  const lintMode = busy.startsWith('lint-') ? busy.slice(5) : ''
  const lintTitle = LINT_TITLES[lintMode] || ''
  const [logs, setLogs] = useState([])
  const logBox = useRef(null)

  const pushLog = (kind, text) => {
    // Stored raw: the renderer turns the CLI's colour escapes into styled runs, so a tool that
    // colours its progress shows those colours instead of a stray `[36m`.
    const line = `${new Date().toLocaleTimeString()} ${String(text)}`
    setLogs((prev) => [...prev.slice(-200), { kind, text: line }])
  }
  const clearLogs = () => setLogs([])

  useEffect(() => {
    const box = logBox.current
    if (box) box.scrollTop = box.scrollHeight
  }, [logs])

  /**
   * The three start-up reads each apply their own result the moment it lands, so the panel paints
   * as answers arrive. Awaiting all three together keeps it blank until the slowest returns, and
   * every devecocli spawn costs ~0.6 s (mostly Node startup, more when three run at once).
   * `force` re-probes the toolchain (the cache in the host is what makes this cheap).
   */
  const refresh = async (force = false) => {
    if (busy === 'refresh') return
    setBusy('refresh')
    const toolchain = rpc('toolchain', force ? { refresh: true } : undefined)
      .then((value) => {
        setTc(value)
        setTcMsg('')
        lsSetJson('toolchain', value)
        pushLog('info', '已刷新:工具链就绪' + (value.devecoCliJs ? '' : '(devecocli 未找到)'))
      })
      .catch((error) => {
        setTcMsg(error.message)
        pushLog('err', `工具链查询失败:${error.message}`)
      })
    const emuRead = rpc('emu.list')
      .then((emu) => {
        setEmuRaw(emu.raw || '(空)')
        lsSetJson('emuRaw', emu.raw || '(空)')
        const list = emu.instances || []
        lsSetJson('instances', list)
        setInstances(list)
        // The selection is resolved from the list just fetched, not from `instances`, which
        // still holds this render's value: looking the instance up there misses its serial and
        // silently falls back to the first device whenever more than one is online.
        setInstanceSel((prev) => prev || list[0]?.name || '')
        return list
      })
      .catch((error) => { setEmuRaw(`获取失败:${error.message}`); return [] })
    const deviceRead = rpc('devices')
      .then((dev) => {
        const list = dev.devices || []
        lsSetJson('devices', list)
        setDevices(list)
        return list
      })
      .catch(() => [])
    try {
      const [list, devList] = await Promise.all([emuRead, deviceRead])
      const selName = instanceSel || list[0]?.name || ''
      if (devList.length) setDevice(pickDevice(devList, list.find((it) => it.name === selName)?.serial))
      await toolchain
    } finally {
      setBusy('')
    }
  }

  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    refresh()
  }, [])
  // A check prints nothing until it is done (codelinter buffers its whole run), so
  // the panel runs its own clock to show the work is still going on.
  useEffect(() => {
    if (!busy.startsWith('lint-')) return undefined
    const t0 = Date.now()
    setLintSec(0)
    const id = setInterval(() => setLintSec(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [busy])
  // Restore the persisted selection when the panel opens again.
  useEffect(() => {
    lsSet(lsSessionKey('project'), project)
    lsSet(lsSessionKey('scanRoot'), scanRoot)
    lsSet('instance', instanceSel)
    lsSet(lsModuleKey(project), moduleSel)
  }, [project, scanRoot, instanceSel, moduleSel])
  // Fill the scan root from the session working directory as soon as it is known: it is an
  // optional field of the tab's scope, so on a fresh panel it can still be undefined while the
  // panel is already rendered.
  useEffect(() => {
    if (!scopeCwd || scanRootEdited.current) return
    setScanRoot((prev) => prev || scopeCwd)
  }, [scopeCwd])
  // Opening the panel with the directory already known should not leave the project row on its
  // "扫描后选择项目" placeholder until someone clicks "扫描" — the panel does that first scan
  // itself. The signal is the empty option list, not an empty selection: a restored project has
  // no option to render yet, so gating on the selection alone left the row on the placeholder
  // and never scanned. Once per directory.
  const autoScanRoot = useRef('')
  useEffect(() => {
    const root = scanRoot.trim()
    if (!root || autoScanRoot.current === root || projectOptions.length > 0) return
    autoScanRoot.current = root
    runScan(true)
  }, [scanRoot, projectOptions.length])
  // A check authorizes fixing only that same project, so switching project locks both again —
  // and the cached check result stops being deliverable, since it describes the old project.
  useEffect(() => {
    setFixReady({ changed: false, all: false })
    setLintReady(false)
  }, [project])
  // Load the selected project's entry modules whenever the selection changes, including the
  // restored one on mount: without this the module row kept the previous project's names and
  // the deploy could carry a module this project does not have.
  useEffect(() => {
    if (project) loadProjectInfo(project)
  }, [project])
  // Screenshot preview: wheel zoom anchored at the cursor. A non-passive listener is
  // required, otherwise the panel would scroll while zooming.
  useEffect(() => {
    const el = shotBoxRef.current
    if (!el || !shot) return
    const onWheel = (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      // cursor position relative to the box center
      const mx = e.clientX - rect.left - rect.width / 2
      const my = e.clientY - rect.top - rect.height / 2
      setShotView((v) => {
        const zoom = Math.min(4, Math.max(0.25, Math.round(v.zoom * (e.deltaY < 0 ? 1.1 : 0.9) * 100) / 100))
        const k = zoom / v.zoom
        // keep the image point under the cursor fixed: offset' = m*(1-k) + k*offset
        return { zoom, x: mx * (1 - k) + k * v.x, y: my * (1 - k) + k * v.y }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [shot])

  // ── Project selection ───────────────────────────────────────────────
  // Use the host-native directory picker. The button sits on the scan-root row, so the picked
  // directory goes there; the project row then follows the same rule as the scan button: the
  // directory itself when it is a project root, otherwise the first project found inside it.
  // (The dropdown can only render a value it has an option for, so the option is set with it.)
  const pickNative = async () => {
    setBusy('browse')
    try {
      const ui = ctx.get('uiWorkspace')
      if (ui && typeof ui.pickDirectory === 'function') {
        const p = await ui.pickDirectory()
        if (!p) return
        scanRootEdited.current = true
        setScanRoot(p)
        pushLog('ok', `已设置查找目录:${p}`)
        const info = await loadProjectInfo(p)
        if (info && info.isProject) {
          setProject(p)
          setProjectOptions((prev) => (prev.includes(p) ? prev : [p, ...prev]))
          pushLog('ok', `该目录是鸿蒙工程,已选中项目:${p}`)
        } else {
          await scanInto(p)
        }
      } else {
        pushLog('err', '系统目录选择不可用,请用「扫描」或直接粘贴路径')
      }
    } catch (error) {
      pushLog('err', `系统选择失败:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy('')
    }
  }
  // Scan a root for projects and fill the project dropdown. Shared by the scan and browse
  // buttons, so picking a directory that merely contains projects refreshes the project row.
  const scanInto = async (root, keepSelection = false) => {
    const value = await rpc('scan', { root })
    const found = value.projects || []
    setProjectOptions(found)
    if (found.length) {
      const keep = keepScannedProject(found, project, keepSelection)
      setProject(keep)
      pushLog('info', `扫描「${value.root}」发现 ${found.length} 个项目,已选中 ${keep}`)
    } else {
      setModules([]); setModuleSel('')
      pushLog('info', `“${value.root}”下(≤3 层)未发现鸿蒙项目`)
    }
    return found
  }
  const runScan = async (keepSelection = false) => {
    const root = scanRoot.trim()
    if (!root) { pushLog('err', '请先填写扫描目录'); return }
    setBusy('scan')
    try {
      await scanInto(root, keepSelection)
    } catch (error) {
      pushLog('err', `扫描失败:${error.message}`)
    } finally {
      setBusy('')
    }
  }
  // Read a directory's project info (entry modules feed --module when deploying).
  // Returns null only when the host rejects the path — whether the directory really is a
  // project root is `info.isProject`, because readModules() answers [] for any other folder.
  const loadProjectInfo = async (proj) => {
    if (!proj) return null
    try {
      const info = await rpc('project.info', { projectPath: proj })
      const mods = info.modules || []
      setModules(mods)
      const remembered = lsGet(lsModuleKey(proj))
      setModuleSel(() => pickModule(mods, remembered))
      return info
    } catch { return null /* a module read failure must not block the flow */ }
  }
  // Project code check (DevEco Code Linter). Scope: changed / all. Fix: fix / fix-all.
  const runLint = async (mode) => {
    const p = project.trim()
    if (!p) { pushLog('err', '请先在“应用项目”选择项目'); return }
    const title = LINT_TITLES[mode]
    const t0 = Date.now()
    setBusy(`lint-${mode}`)
    pushLog('info', `[代码检查] ${title}开始:${p}`)
    if (mode.startsWith('fix')) pushLog('info', '[代码检查] 修复结束后会自动复检一次,总耗时约为单次检查的两倍')
    try {
      const v = await rpc('check.lint', { projectPath: p, mode })
      const line = lintStatusLine(v)
      pushLog(v.empty ? 'info' : v.ok ? 'ok' : 'err', `[代码检查] ${title}完成 — ${line} · 用时 ${fmtDur(Date.now() - t0)}`)
      if (v.text && v.empty !== true) pushLog('raw', v.text)
      setLintReady(v.empty !== true)
      // A check unlocks the fix button with the same scope; a run with nothing in scope does not.
      if (mode === 'changed') setFixReady((r) => ({ ...r, changed: v.empty !== true }))
      if (mode === 'all') setFixReady((r) => ({ ...r, all: true }))
    } catch (error) {
      pushLog('err', `[代码检查] ${title}失败:${error.message}(用时 ${fmtDur(Date.now() - t0)})`)
    } finally {
      setBusy('')
    }
  }
  // Send the cached check result to the AI on demand (nothing is sent automatically).
  const sendLint = async () => {
    if (!lintReady) { pushLog('err', '尚未生成检查结果,请先执行代码检查'); return }
    setBusy('lint-send')
    try {
      // The session id tells the host which conversation may consume the notice, so a result
      // produced here can never surface in another session's prompt.
      await rpc('lint.notify', { sessionId: (scope && scope.sessionId) || '' })
      pushLog('ok', '检查结果已就绪:发送一条消息后 AI 即可读取')
    } catch (error) {
      pushLog('err', `检查结果提交失败:${error.message}`)
    } finally {
      setBusy('')
    }
  }

  // ── Emulator / deploy actions ───────────────────────────────────────
  // Selecting an instance refetches its state so the deploy target follows its serial; the
  // cached instances may still hold a null serial when the emulator was started afterwards.
  const pickInstance = async (name) => {
    setInstanceSel(name)
    try {
      const v = await rpc('emu.list')
      const list = v.instances || []
      setInstances(list)
      const serial = list.find((it) => it.name === name)?.serial
      if (serial) setDevice(serial)
      else pushLog('info', `${name} 未运行(先点“启动”),部署目标保持 ${device || '无'}`)
    } catch (error) {
      pushLog('err', `同步模拟器状态失败:${error.message}`)
    }
  }
  // Device dropdown: pick a deploy device and sync the instance dropdown when it is known.
  const pickDeviceTarget = (serial) => {
    setDevice(serial)
    const name = instances.find((it) => it.serial === serial)?.name
    if (name) setInstanceSel(name)
  }
  const scanEmus = async () => {
    if (busy === 'scan') return
    setBusy('scan')
    try {
      const [v, dev] = await Promise.all([rpc('emu.list'), rpc('devices')])
      const list = v.instances || []
      setInstances(list)
      setEmuRaw(v.raw || '')
      const first = list[0]
      const selName = instanceSel || (first ? first.name : '')
      if (first) setInstanceSel((prev) => prev || first.name)
      else pushLog('info', '未扫描到可用模拟器实例(可在 DevEco Device Manager 创建;若报授权请先在终端执行 devecocli emulator license accept)')
      // Scanning also refreshes online devices and selects the serial of the chosen instance.
      const devList = dev.devices || []
      setDevices(devList)
      const selSerial = list.find((it) => it.name === selName)?.serial
      if (devList.length) setDevice(pickDevice(devList, selSerial))
    } catch (error) {
      pushLog('err', `扫描失败:${error.message}`)
    } finally {
      setBusy('')
    }
  }
  // Refresh instances and devices after start/stop so the badge and target stay current.
  const refreshInstAndDev = async () => {
    try {
      const [e, d] = await Promise.all([rpc('emu.list'), rpc('devices')])
      setInstances(e.instances || [])
      setEmuRaw(e.raw || '')
      setDevices(d.devices || [])
    } catch { /* silent */ }
  }
  const emuStart = async () => {
    const target = instanceSel || emuTarget.trim()
    if (!target) { pushLog('err', '请先点“扫描可用”并选择实例,或手动输入实例名'); return }
    setBusy('start')
    // Cold boot takes 1-2 minutes: log progress every 15s so it does not look stuck.
    const tick = setInterval(() => pushLog('info', '仍在等待设备上线…'), 15000)
    try {
      const value = await rpc('emu.start', { name: target })
      pushLog(value.code === 0 ? 'ok' : 'err', `启动模拟器[${target}] 退出码=${value.code ?? '-'}\n${value.output}`)
      if (value.code === 0) {
        // The host already waited for the device: switch to it when ready.
        if (value.ready && value.serial) {
          pushLog('ok', `设备已就绪:${value.serial}`)
          setDevice(value.serial)
        } else {
          pushLog('info', '启动命令已返回,但设备尚未上线(可稍后点“检测就绪”)')
        }
        await refreshInstAndDev()
      }
    } catch (error) {
      pushLog('err', `启动失败:${error.message}`)
    } finally {
      clearInterval(tick)
      setBusy('')
    }
  }
  const emuStop = async () => {
    const target = instanceSel || emuTarget.trim()
    if (!target) { pushLog('err', '请先选择实例或输入名称/串号'); return }
    setBusy('stop')
    try {
      const value = await rpc('emu.stop', { target })
      pushLog(value.code === 0 ? 'ok' : 'err', `停止模拟器[${target}] 退出码=${value.code ?? '-'}\n${value.output}`)
      if (value.code === 0) await refreshInstAndDev()
    } catch (error) {
      pushLog('err', `停止失败:${error.message}`)
    } finally {
      setBusy('')
    }
  }
  const deploy = async () => {
    if (!project.trim()) { pushLog('err', '请先在“应用项目”选择项目'); return }
    if (!targetDevice) { pushLog('err', '请先在“部署目标”选择在线设备'); return }
    setBusy('deploy')
    pushLog('info', `开始构建并部署 → ${project} @ ${targetDevice}(构建可能需要数分钟)`)
    try {
      const res = await fetch(`${API}/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectPath: project, device: targetDevice, module: modules.length > 1 ? moduleSel : undefined }),
      })
      if (res.status !== 200) {
        let msg = `HTTP ${res.status}`
        try { const j = await res.json(); if (j && j.error && j.error.message) msg = j.error.message } catch { /* not JSON */ }
        pushLog('err', `部署失败:${msg}`)
        return
      }
      if (!res.body) { pushLog('err', '宿主未返回可读内容'); return }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let exitCode = null
      const flushLine = (line) => {
        if (!line) return
        const code = exitCodeOf(line)
        if (code !== null) { exitCode = code; return }
        const clean = cleanCliLine(line)
        if (clean.trim()) pushLog('raw', clean)
      }
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const l of lines) flushLine(l.replace(/\r$/, ''))
      }
      if (buf.trim()) flushLine(buf.replace(/\r/g, ''))
      // -2 is the host's marker for "cancelled and the device released", not a build failure.
      pushLog(exitCode === 0 ? 'ok' : 'err', exitCode === 0 ? '部署完成' : exitCode === -2 ? '部署已取消(设备已释放)' : `部署结束(退出码 ${exitCode ?? '未知'})`)
    } catch (error) {
      pushLog('err', `部署失败:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy('')
    }
  }
  // Manually check whether the instance serial came online (no polling).
  const checkReady = async () => {
    const serial = (selInst && selInst.serial) || manualSerial.trim()
    if (!serial) { pushLog('err', '请先选择模拟器实例或填写串号'); return }
    setBusy('ready')
    try {
      const r = await rpc('device.ready', { serial })
      if (r.online) { pushLog('ok', `设备 ${serial} 已就绪`); setDevices(r.devices || []); setDevice(r.serial) }
      else pushLog('info', `设备 ${serial} 尚未上线,请稍后再试`)
    } catch (error) {
      pushLog('err', `就绪检测失败:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy('')
    }
  }
  // Screenshot: the host runs devecocli ui screenshot and stores the PNG under
  // <workspace>/screenshots.
  const takeShot = async () => {
    if (!targetDevice) { pushLog('err', '请先选择在线设备(部署目标)'); return }
    setBusy('shot')
    try {
      const root = (scope && scope.cwd) || ''
      const v = await rpc('screenshot', { device: targetDevice, root, preview: true })
      if (v && v.path) {
        pushLog('ok', `截图已保存 → ${v.path}`)
        setShot({ path: v.path, dataUrl: v.dataUrl || null })
        setShotView({ zoom: 1, x: 0, y: 0 })
      } else pushLog('info', '截图完成,但宿主未返回保存路径')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      pushLog('err', `截图失败:${msg}${/unknown method|非 JSON/.test(msg) ? '(宿主端尚未加载新 API,请重启 dsh web 后重试)' : ''}`)
    } finally {
      setBusy('')
    }
  }
  // One global install at a time: this panel's one-click install and the banner's action rewrite the
  // same global tree, so neither may start while the other runs.
  const installing = busy === 'cli' || busy === 'cli-up'
  const installCli = async () => {
    if (installing) return
    setBusy('cli')
    try {
      const v = await rpc('deveco.install')
      pushLog(v.code === 0 ? 'ok' : 'err', `${v.note}\n${v.output}`)
      if (v.code === 0) {
        const t = await rpc('toolchain', { refresh: true })
        setTc(t)
        pushLog('ok', '已重新检测工具链')
      }
    } catch (error) {
      pushLog('err', `安装失败:${error.message}`)
    } finally {
      setBusy('')
    }
  }

  // Screenshot image: drag to pan (stop propagation so the panel drag-scroll does not fire).
  const onShotImgDragStart = (e) => {
    if (!shot) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const base = shotView
    const move = (ev) => setShotView((v) => ({ zoom: v.zoom, x: base.x + (ev.clientX - startX), y: base.y + (ev.clientY - startY) }))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  // Panel content can be drag-scrolled vertically from empty space (buttons/inputs unaffected).
  const onPanelDragStart = (e) => {
    if (e.target !== e.currentTarget) return
    const el = e.currentTarget
    const startY = e.clientY
    const startTop = el.scrollTop
    const move = (ev) => { el.scrollTop = startTop - (ev.clientY - startY) }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  // Copy to clipboard: the button briefly shows a copied state as feedback.
  const copyText = (text) => {
    const done = () => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }
    try {
      navigator.clipboard.writeText(text)
        .then(done)
        .catch(() => pushLog('err', '复制失败(浏览器未授权剪贴板)'))
    } catch {
      pushLog('err', '复制失败(浏览器不支持剪贴板 API)')
    }
  }

  // Update devecocli: the check names the build its channel points at, and the banner's own action runs
  // this install. The channel travels with the notice rather than being read here: a standing banner can
  // outlive a change of this setting, and it must install what its own sentence said.
  const updateCli = async (named?: string) => {
    if (installing) return
    setBusy('cli-up')
    try {
      const v = await rpc('deveco.update', { channel: named || cliChannel })
      pushLog(v.code === 0 ? 'ok' : 'err', `${v.note}\n${v.output}`)
      if (v.code === 0) {
        const t = await rpc('toolchain', { refresh: true })
        setTc(t)
        pushLog('ok', '已重新检测工具链')
      }
    } catch (error) {
      pushLog('err', `更新失败:${error.message}`)
    } finally {
      setBusy('')
    }
  }

  /**
   * The check reports through the shell's banner, which is not part of this panel: ask the host what
   * the chosen channel points at and hand the answer to the notice source.
   */
  const askUpdateCli = async () => {
    if (busy !== '') return
    setBusy('cli-plan')
    try {
      notices.show(await rpc('deveco.plan', { channel: cliChannel }))
    } catch (error) {
      notices.fail(error)
      pushLog('err', `无法确认更新目标:${error.message}`)
    } finally {
      setBusy('')
    }
  }

  // The banner's action installs, and the banner can outlive the render that raised it, so the run is
  // refreshed after every render. This panel instance owns the store while it is mounted: a host switch
  // can hold two panels for a moment, and the retiring one's cleanup must not clear what the arriving
  // one published.
  useEffect(() => { notices.own(owner) })
  useEffect(() => { notices.setInstallRunner(updateCli) })
  useEffect(() => () => { notices.release(owner) }, [])
  // The banner follows this column rather than the middle of the window, and only the panel knows
  // which node that is. It is fixed near the window top either way; this only moves it sideways.
  //
  // Nothing clears the anchor here: `release` does, and it is guarded by ownership. A switch holds two
  // panels for a moment, and an unguarded clear from the retiring one would centre the arriving one's
  // banner on the window instead of its column.
  useEffect(() => { notices.setAnchor(panelRef.current) }, [])

  // ── Render ──────────────────────────────────────────────────────────
  const nodes = []
  // The shell's dialog, read once per render: only a mount confirmation needs it.
  const dialog = hostDialog()
  // Header
  nodes.push(h('div', { key: 'headWrap', style: { position: 'relative' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
    h('span', { style: { width: 20, height: 20, display: 'inline-flex', color: s.accent } }, h(Icon, { src: IC.emulator, size: 20 })),
    h('div', { style: { flex: 1, fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' } }, '鸿蒙模拟器'),
    // One tight cluster: the two header actions read as a pair, not as two corners.
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 2, flex: '0 0 auto' } },
      h(Btn, {
        icon: IC.refresh, ghost: true, disabled: busy === 'refresh', title: '刷新',
        style: { padding: '6px 8px' }, onClick: () => refresh(true),
      }, '刷新'),
      h(Btn, {
        icon: IC.settings,
        ghost: true,
        // The tooltip names what the button opens, which is the popover's own title.
        title: '设置',
        style: { padding: '6px 6px', ...(showMount ? { color: s.accent } : undefined) },
        onClick: () => { setShowMount((open) => !open) },
      }))),
    // Anchored under the header row, over the panel's own scroll area; its scrim closes it.
    showMount ? h(Popover, {
      key: 'mountPopover',
      onClose: () => { setShowMount(false) },
    },
      // Title, top-left: this popover is where the panel's set-once preferences live. The three sizes
      // here are the shell's own settings scale — a row label is 14, its control 13, its description 12
      // (see ui-permission-presets) — so the popover reads as one level of the shell rather than a flat
      // block of small print.
      h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10 } }, '设置'),
      // One row: what the choice binds, then the capsule naming both hosts inside itself. It wraps when
      // the column cannot hold both, so the capsule moves under the label instead of leaving the panel.
      h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 6 } },
        h('span', { style: { flex: 1, fontSize: 14, whiteSpace: 'nowrap' } }, '挂载方式'),
        h(Segmented, {
          value: mount.effective,
          options: [
            // Each half names a host, and each tooltip names the package behind it: the built-in
            // right column (`@deepseek-ai/dsh-client-ui-sidebar-right`, scope dropped) and the
            // third-party workbench (`dsh-better-sidebar`), whose own registration id is shorter.
            { value: 'native', label: '内置右侧栏', title: 'dsh-client-ui-sidebar-right', disabled: !mount.nativeReady },
            { value: 'better', label: 'better-sidebar', title: 'dsh-better-sidebar', disabled: !mount.betterReady },
          ],
          // Picking a half asks first: the shell's dialog carries the consequences when this host has
          // one, and its banner asks the same question when it does not — see `askMount`.
          onChange: (next) => { askMount(next) },
        })),
      // The confirmation, in the shell's own layer: portaled to the body, centered, with the shell's own
      // scrim and Escape handling. A card nested in this popover would be a box inside a box, and the row
      // below already says how the panel comes back, so the body carries only what is being accepted.
      pendingMount === '' || dialog === null ? null : h(dialog.Modal, {
        key: 'mountConfirm',
        open: true,
        title: mountSwitchTitle(pendingMount, betterBuild(ctx)),
        closeLabel: '关闭',
        onClose: () => setPendingMount(''),
        footer: h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          h(Btn, { ghost: true, style: { padding: '4px 10px' }, onClick: () => setPendingMount('') }, '取消'),
          h(Btn, { primary: true, style: { padding: '4px 12px' }, onClick: confirmMount }, '切换')),
      }, h('div', { style: { fontSize: 12, lineHeight: 1.7 } }, mountSwitchNote())),
      h('div', { style: { fontSize: 12, color: s.faint, marginTop: 2, lineHeight: 1.6 } }, mountDetail(mount)),
      // A second setting, separated so the two do not read as one block: which channel the panel's
      // 更新 button takes devecocli from. Shown only while the CLI is there to upgrade.
      tc && tc.devecoCliJs ? h('div', { key: 'cliChannel', style: { borderTop: `1px solid ${s.border}`, marginTop: 8, paddingTop: 8 } },
        // The row explains itself: the label names the channel setting, each option's tooltip names the
        // channel it selects, and the version check's own tooltip names the channel it will read. A
        // caption saying which features consult it would only repeat that, in the reader's way.
        h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
          h('span', { style: { flex: 1, fontSize: 14, whiteSpace: 'nowrap' } }, 'devecocli 更新通道'),
          h(Segmented, {
            value: cliChannel,
            options: [
              { value: 'stable', label: 'stable', title: 'stable:厂商稳定通道' },
              { value: 'latest', label: 'latest', title: 'latest:最新发布通道' },
            ],
            onChange: (next) => pickCliChannel(next),
          }))) : null,
      mount.reason ? h('div', { style: { fontSize: 12, color: s.faint, marginTop: 4, lineHeight: 1.6 } }, mount.reason) : null,
    ) : null))

  // devecocli version row: the installed version, and the check that reports which build the chosen
  // channel points at. What the check finds is reported by the shell's own banner (`shell.overlay`),
  // not by anything this panel draws: it needs no placement, no scrim and no closing, and it carries
  // the install as the sentence's own continuation.
  if (tc && tc.devecoCliJs) {
    nodes.push(h('div', { key: 'cliVer', style: { position: 'relative', margin: '-4px 0 8px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: s.faint } },
        h('span', null, `devecocli ${tc.devecoCliVersion || '版本未知'}`),
        h(Btn, {
          ghost: true, disabled: busy !== '', onClick: askUpdateCli, style: { padding: '2px 8px' },
          title: `检查 @deveco/deveco-cli@${cliChannel} 的最新版本`,
        }, busy === 'cli-plan' ? '检查中…' : '版本检查'))))
  }

  // Toolchain banners so a missing CLI surfaces before the user clicks anything
  if (tc) {
    if (!tc.devecoCliJs) nodes.push(h('div', { key: 'warnCli', style: warnBox },
      h('div', null, '未检测到 devecocli:启动/部署功能不可用。'),
      h('div', { style: { fontSize: 11, marginTop: 2, marginBottom: 6, opacity: .85 } }, '建议安装 @deveco/deveco-cli(仅覆盖 CLI;hdc/模拟器仍需安装 DevEco Studio SDK 并设置 DEVECO_SDK_HOME)。'),
      h(Btn, { secondary: true, disabled: installing, onClick: installCli }, busy === 'cli' ? '安装中…' : '一键安装 devecocli')))
    if (!tc.hdcExe) nodes.push(h('div', { key: 'warnHdc', style: warnBox }, '未检测到 hdc:请设置环境变量 DEVECO_SDK_HOME(指向 DevEco Studio SDK 目录)后重启 dsh web。'))
  }

  // Emulator instances
  nodes.push(h(Card, { key: 'emuCard', title: '模拟器实例' },
    h('div', { style: row },
      h('span', { style: label }, '模拟器'),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 } },
        h(Dropdown, {
          value: instanceSel, placeholder: instances.length ? '选择模拟器实例…' : '(先点“扫描可用”)',
          options: instances.map((it) => ({ value: it.name, label: it.name, status: it.status })),
          onChange: pickInstance,
        }),
        h(Btn, { icon: IC.scan, secondary: true, disabled: busy !== '', onClick: scanEmus }, busy === 'scan' ? '扫描中' : '扫描可用')),
      h(Btn, { icon: IC.play, primary: true, disabled: busy !== '' || (!instanceSel && !emuTarget.trim()), onClick: emuStart }, busy === 'start' ? '启动中' : '启动'),
      h(Btn, { icon: IC.stop, dangerSolid: true, disabled: busy !== '', onClick: emuStop }, '停止')),
    h('div', { style: row },
      h('span', { style: label }, '状态'),
      // A value, so it reads at the size values read at — it used to sit at hint size beside a 12px
      // button, which made the state of the emulator the smallest thing on its own row.
      selInst ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: selToneColor } },
        h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: selToneColor } }),
        selTone.label) : h('span', { style: { fontSize: 12, color: s.faint } }, '未实例'),
      h('div', { style: { flex: 1 } }),
      h(Btn, { secondary: true, disabled: busy !== '', onClick: checkReady, title: '检测模拟器串号是否已上线' }, '检测就绪'),
      h(Btn, { ghost: true, disabled: busy !== '', onClick: toggleManual }, showManual ? '收起手动输入' : '手动输入'),
      h(Btn, { ghost: true, disabled: busy !== '', onClick: () => setShowRaw((v) => !v) }, showRaw ? '收起原始输出' : '原始输出')),
    showManual ? h('div', { key: 'manual', style: { marginTop: 4 } },
      h('div', { style: { ...row, marginBottom: 6 } },
        h('span', { style: { width: 56, fontSize: 12, color: s.muted } }, '实例名'),
        h('input', { style: field, value: emuTarget, placeholder: '如 Pura 90', onChange: (e) => setEmuTarget(e.target.value), spellCheck: false })),
      h('div', { style: { ...row, marginBottom: 6 } },
        h('span', { style: { width: 56, fontSize: 12, color: s.muted } }, '串号'),
        h('input', { style: field, value: manualSerial, placeholder: '如 127.0.0.1:5555', onChange: (e) => setManualSerial(e.target.value), spellCheck: false })),
      h('div', { style: { ...row, marginBottom: 6 } },
        h('span', { style: { width: 56, fontSize: 12, color: s.muted } }, '设备类型'),
        h('input', { style: field, value: manualType, placeholder: '如 phone', onChange: (e) => setManualType(e.target.value), spellCheck: false })),
      h('div', { style: { ...row, marginBottom: 6 } },
        h('span', { style: { width: 56, fontSize: 12, color: s.muted } }, '系统版本'),
        h('input', { style: field, value: manualOs, placeholder: '如 HarmonyOS 6.1.1(24)', onChange: (e) => setManualOs(e.target.value), spellCheck: false })),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 } },
        h(Btn, { secondary: true, disabled: !manualSerial.trim(), onClick: () => setDevice(manualSerial.trim()) }, '用该串号作为部署设备'),
        h('div', { style: { fontSize: 11, color: s.faint } }, '实例名参与启动/停止;串号可一键设为部署设备')))
      : null,
    showRaw && emuRaw ? h('pre', { style: { ...field, maxHeight: 110, overflow: 'auto', margin: '2px 0 0', fontSize: 10, whiteSpace: 'pre-wrap' } }, emuRaw) : null,
  ))

  // Application project
  nodes.push(h(Card, { key: 'projCard', title: '应用项目' },
    h('div', { style: row },
      h('span', { style: label }, '查找目录'),
      h('input', {
        style: field, value: scanRoot, placeholder: '默认为当前工作目录',
        onChange: (e) => { scanRootEdited.current = true; setScanRoot(e.target.value) }, spellCheck: false,
      }),
      h(Btn, { icon: IC.folder, secondary: true, disabled: busy !== '', onClick: pickNative }, '浏览')),
    h('div', { style: row },
      h('span', { style: label }, '项目'),
      h(Dropdown, {
        value: project, placeholder: projectOptions.length ? '选择扫描到的项目…' : '扫描后选择项目',
        options: projectOptions.map((p) => ({ value: p, label: p })),
        onChange: setProject,
      }),
      h(Btn, { icon: IC.scan, secondary: true, disabled: busy !== '', onClick: () => runScan() }, busy === 'scan' ? '扫描中' : '扫描')),
    modules.length > 1 ? h('div', { style: row, key: 'moduleRow' },
      h('span', { style: label }, '入口模块'),
      h(Dropdown, { value: moduleSel, placeholder: '选择入口模块', options: modules.map((m) => ({ value: m, label: m })), onChange: setModuleSel }),
    ) : null,
    // On-demand project checks (no model-tool schema cost). Details live in tooltips so
    // the panel itself stays free of explanatory clutter.
    h('div', { style: row, key: 'lintRow' },
      h('span', { style: label }, '代码检查'),
      h(Btn, {
        secondary: true, disabled: busy !== '' || !project.trim(),
        onClick: () => runLint('changed'), title: '只检查已跟踪文件的未提交改动(快;新建文件请用「全量检查」)',
      }, busy === 'lint-changed' ? '检查中…' : '检查改动'),
      h(Btn, {
        secondary: true, disabled: busy !== '' || !project.trim(),
        onClick: () => runLint('all'), title: '检查整个项目(较慢)',
      }, busy === 'lint-all' ? '检查中…' : '全量检查'),
      h(Btn, {
        secondary: true, disabled: busy !== '' || !lintReady,
        onClick: sendLint, title: '将最近一次检查结果提供给 AI(发送消息后生效)',
      }, busy === 'lint-send' ? '发送中…' : '发送到对话')),
    // Fixing writes to the source files, so each button unlocks only after the check with the
    // same scope has run: you see what is in range before anything is rewritten.
    h('div', { style: row, key: 'fixRow' },
      h('span', { style: label }, '代码修复'),
      h(Btn, {
        secondary: true, disabled: busy !== '' || !fixReady.changed, onClick: () => runLint('fix'),
        title: fixReady.changed ? '自动修复未提交改动中可修复的告警;无法自动修复的不会列出' : '先点「检查改动」查看范围后才能修复',
      }, busy === 'lint-fix' ? '修复中…' : '自动修复'),
      h(Btn, {
        secondary: true, disabled: busy !== '' || !fixReady.all, onClick: () => runLint('fix-all'),
        title: fixReady.all ? '自动修复整个项目中可修复的告警;无法自动修复的不会列出' : '先点「全量检查」查看范围后才能修复',
      }, busy === 'lint-fix-all' ? '修复中…' : '全量修复')),
    // Live status while a check runs: the linter only writes its report at the end, so the
    // ticking clock is what tells the user it is still working.
    lintTitle ? h('div', {
      key: 'lintProgress',
      style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: s.muted, margin: '-2px 0 8px' },
    },
      h('span', { style: { display: 'inline-flex' } }, h(Icon, { src: IC.clock, size: 12 })),
      `${lintTitle}进行中… 已用时 ${lintSec}s(检查工具在结束时才输出报告)`) : null,
    h('div', { style: { fontSize: 11, color: s.faint, margin: '-2px 0 8px' } }, '需包含 build-profile.json5 的项目根;点「扫描」列出子目录项目,或「浏览」直接选择'),
  ))

  // Deploy target: read-only for a single device, a dropdown when several are online.
  const devLabel = (serial) => deviceLabel(instances, serial)
  nodes.push(h(Card, { key: 'devCard', title: '部署目标' },
    h('div', { style: row },
      h('span', { style: label }, '设备'),
      devices.length > 1
        ? h(Dropdown, {
          value: targetDevice, placeholder: '选择在线设备…',
          options: devices.map((d) => ({ value: d, label: devLabel(d) })),
          onChange: pickDeviceTarget,
        })
        : h('div', { style: { ...field, display: 'flex', alignItems: 'center', color: targetDevice ? s.fg : s.faint, cursor: 'default' } },
          targetDevice ? devLabel(targetDevice) : '暂无在线设备')),
    // The screenshot action sits under the device row, matches the field height, and stays
    // outlined so it never competes with the primary deploy button.
    h('div', { style: { marginTop: 8 } },
      h(Btn, {
        secondary: true, icon: IC.camera, disabled: busy !== '' || !targetDevice, onClick: takeShot,
        style: { width: '100%' },
        title: '用 devecocli 截取设备屏幕,PNG 保存到 <工作区>/screenshots',
      }, busy === 'shot' ? '截图中…' : '截图当前设备屏幕')),
    (targetDevice
      ? h('div', { style: { fontSize: 11, color: s.faint, marginTop: 6 } }, '部署将发送到该设备(启动模拟器后自动更新)')
      : (devices.length
        ? h('div', { style: { fontSize: 11, color: s.faint, marginTop: 6 } }, `检测到 ${devices.length} 台在线设备,已默认选第一台`)
        : h('div', { style: { fontSize: 11, color: s.faint, marginTop: 6 } }, '暂无在线设备;请先在「模拟器实例」启动模拟器'))),
  ))

  // Primary deploy button (the screenshot action lives in the deploy-target card)
  nodes.push(h('div', { key: 'deployBtn', style: { marginTop: 2 } },
    h(Btn, {
      primary: true, disabled: busy !== '', onClick: deploy, icon: IC.deploy,
      style: { width: '100%', padding: '10px 12px', fontWeight: 600, fontSize: 13 },
    }, busy === 'deploy' ? '构建并部署中…' : '构建并部署到所选设备'),
    h('div', { style: { fontSize: 11, color: s.faint, margin: '6px 2px 0' } }, 'devecocli run:构建 → 安装 → 启动(首次约 1–3 分钟)'),
  ))

  // Debug output
  nodes.push(h('div', { key: 'logWrap', style: { ...card, marginTop: 4, padding: 8, marginBottom: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
      h('span', { style: { fontSize: 13, fontWeight: 600, color: s.fg } }, '调试输出'),
      h('div', { style: { flex: 1 } }),
      h(Btn, { ghost: true, onClick: clearLogs, style: { padding: '2px 8px' } }, '清空')),
    h('pre', {
      key: 'logbox', ref: logBox, style: {
        ...field, maxHeight: 220, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'ui-monospace, Consolas, "Courier New", monospace', fontSize: 11,
      },
    }, logs.length === 0
      ? '(构建/部署信息将显示在这里)'
      // Each entry renders as styled runs, so a CLI's own colour survives into the log.
      : logs.map((l, i) => h('div', { key: i, style: logLine(l.kind) },
        ansiRuns(l.text).map((run, at) => h('span', {
          key: at,
          style: { color: run.color, fontWeight: run.bold ? 600 : undefined },
        }, run.text))))),
  ))

  if (tcMsg) nodes.push(h('div', { key: 'tcerr', style: { color: s.danger, fontSize: 12, marginTop: 6 } }, tcMsg))

  // Latest screenshot: embedded at the panel bottom; wheel zoom, drag pan, double-click reset.
  if (shot) nodes.push(h(Card, {
    key: 'shotCard', title: '最近截图', style: { marginTop: 12 },
    action: h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      h('span', { style: { fontSize: 10, color: s.faint } }, `${Math.round(shotView.zoom * 100)}%`),
      h(Btn, { ghost: true, style: { padding: '0 6px', fontSize: 14, lineHeight: 1 }, onClick: () => setShot(null), title: '关闭' }, '×')),
  },
    h('div', {
      ref: shotBoxRef,
      style: {
        background: '#15171d', border: `1px solid ${s.border}`, borderRadius: 8,
        height: 300, overflow: 'hidden', position: 'relative',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      },
    },
      shot.dataUrl
        ? h('img', {
          src: shot.dataUrl, draggable: false,
          onMouseDown: onShotImgDragStart,
          onDoubleClick: () => setShotView({ zoom: 1, x: 0, y: 0 }),
          style: {
            maxWidth: '100%', maxHeight: '100%', borderRadius: 6, userSelect: 'none', cursor: 'grab',
            transform: `translate(${shotView.x}px, ${shotView.y}px) scale(${shotView.zoom})`,
            transformOrigin: 'center center',
          },
        })
        : h('div', { style: { fontSize: 11, color: s.faint, padding: '18px 0' } }, '(预览不可用,文件已保存)')),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 } },
      h('span', {
        title: shot.path,
        style: { flex: 1, minWidth: 0, fontSize: 10, color: s.faint, fontFamily: 'ui-monospace, Consolas, "Courier New", monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, shortPath(shot.path)),
      h(Btn, {
        secondary: true,
        style: { padding: '4px 10px', color: copied ? s.ok : s.fg, border: `1px solid ${copied ? s.ok : s.border}` },
        onClick: () => copyText(shot.path),
      }, copied ? '已复制 ✓' : '复制路径')),
    shot.dataUrl ? h('div', { style: { fontSize: 10, color: s.faint, marginTop: 6 } }, '滚轮缩放 · 按住拖动平移 · 双击重置') : null,
  ))

  // The panel scrolls by dragging from empty space, plus the wheel/scrollbar.
  // Frosted glass only on the panel content: the theme base color stays translucent
  // and blurs whatever sits behind it, so text stays readable without a black slab.
  return h('div', {
    ref: panelRef,
    onMouseDown: onPanelDragStart,
    style: {
      padding: 8, color: s.fg, height: '100%', overflowY: 'auto', boxSizing: 'border-box',
      background: 'var(--dsw-alias-bg-base, rgba(46, 52, 66, 0.55))',
      backdropFilter: 'blur(18px) saturate(1.15)',
      WebkitBackdropFilter: 'blur(18px) saturate(1.15)',
    },
  }, nodes)
}

