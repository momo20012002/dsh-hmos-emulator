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

/**
 * The emulator control group. One entry per action that needs no value typed in — the controls that
 * take arguments (battery, geolocation, sensor) belong to the model tool, where a form can fill them.
 * Rotate and volume keep the two directions the CLI itself narrows them to.
 */
const EMU_CONTROLS = [
  { value: 'rotate:left', label: '旋转:左' },
  { value: 'rotate:right', label: '旋转:右' },
  { value: 'power', label: '电源' },
  { value: 'volume:up', label: '音量:加' },
  { value: 'volume:down', label: '音量:减' },
]
/** The chosen control's own wording, so the log line names what was run rather than its argv. */
const emuControlLabel = (value: string) => EMU_CONTROLS.find((c) => c.value === value)?.label || value

/**
 * The four commands the deploy button can run. The wording is the one the host's log header uses, so the
 * menu option, the button, the panel's own log line and the host's line all say the same words for the
 * same action. Their titles say what the user gets, not which CLI call runs underneath.
 */
const DEPLOY_COMMANDS = [
  { value: 'run', label: '构建并部署', title: '编译工程,再安装并启动到所选设备' },
  { value: 'build', label: '构建', title: '只编译工程,不安装到设备' },
  { value: 'skipbuild', label: '部署', title: '不重新编译,把已有产物安装并启动' },
  { value: 'clean', label: '清理构建', title: '删除该工程的构建产物,不安装、不启动' },
]
/** The chosen command's own wording, for the chevron's hover text. */
const deployCommandLabel = (value: string) => DEPLOY_COMMANDS.find((c) => c.value === value)?.label || value

/**
 * The device's own two top-level user folders — the ones the Files app lists first, written out in full so
 * a menu row says exactly what it fills in. Both were measured on a real device: an existing path answers
 * 0, a missing one answers 1 with "no such file or directory".
 */
const DEVICE_PATH_PRESETS = [
  '/storage/media/100/local/files/Docs/Download',
  '/storage/media/100/local/files/Docs/Documents',
]

/** How many log characters one export may carry: the request body is capped, and CJK is three bytes each. */
const LOG_EXPORT_MAX = 200_000

/** How many paths each side offers back. Enough to cover the usual few, short of a history. */
const RECENT_PATH_MAX = 6

/**
 * The log narrowing choices, one source of truth: the dropdowns render them and the line each read prints
 * names the current pick in these same words, so the banner matches the control that produced it. The
 * severity labels are all nouns; 严重 is the settled name for the CLI's fatal level.
 */
const LOG_LEVELS = [
  // An explicit "no filter" row, the same shape the time list uses: without it a level, once picked, could not be
  // undone — and 调试 in particular matches nothing on a device that never emits D lines. Each label carries the
  // CLI's own code after a plain space: the letter is what every log row shows, and brackets around one letter
  // only add width in a control this narrow.
  { value: '', label: '全部级别' },
  { value: 'D', label: '调试 D' }, { value: 'I', label: '信息 I' },
  { value: 'W', label: '警告 W' }, { value: 'E', label: '错误 E' }, { value: 'F', label: '严重 F' },
]
const LOG_TIMES = [
  // The start of the window the CLI reads from: `--from` is an offset back from now. 当前时间 is the default
  // and the narrowest choice, so a read shows the latest lines and a follow brings no history with it.
  { value: '1s', label: '当前时间' },
  { value: '30s', label: '30 秒前' },
  { value: '5m', label: '5 分钟前' },
  { value: '30m', label: '30 分钟前' },
  { value: '60m', label: '1 小时前' },
]

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
  return '切换后,若未自动打开,请在侧边栏的「新标签页」中重新打开。'
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
  // Build options: stop after the build, or remove what the last build produced. Both are remembered,
  // because a choice about how to build is the same choice on the next visit.
  // What the big button will do. One value, so the button can always name the action it runs; the older
  // boolean is only read once, to keep a panel that had "只构建" switched on from losing that choice.
  const [deployAction, setDeployAction] = useState(() => {
    const saved = lsGet('deployAction')
    return saved === 'build' || saved === 'clean' ? saved : (lsGet('buildOnly') === '1' ? 'build' : 'run')
  })
  // Device log snapshot: what to ask for, remembered like the other panel choices.
  const [logLevel, setLogLevel] = useState(() => lsGet('logLevel'))
  const [logBundle, setLogBundle] = useState(() => lsGet('logBundle'))
  const [logKeyword, setLogKeyword] = useState(() => lsGet('logKeyword'))
  // An offset back from now ("5m"), which is what the CLI's --from takes — not a clock time.
  const [logFrom, setLogFrom] = useState(() => lsGet('logFrom') || LOG_TIMES[0].value)
  const [logLines, setLogLines] = useState(() => lsGet('logLines') || '50')
  // Following ends only when someone ends it, so the panel holds the request that owns it.
  const followCtl = useRef(null)
  // A panel that goes away must not leave the device streaming: unmount ends any live follow.
  useEffect(() => () => { followCtl.current?.abort() }, [])
  const [following, setFollowing] = useState(false)
  // Narrowing a log happens in the card's own conditions block, which is always on show, so there is
  // nothing to fold and no state to remember.
  const [emuRaw, setEmuRaw] = useState(() => { const cached = lsGetJson('emuRaw'); return typeof cached === 'string' ? cached : '' })
  const [emuTarget, setEmuTarget] = useState('')
  const [instances, setInstances] = useState(() => lsGetJson('instances') || [])
  const [instanceSel, setInstanceSel] = useState(() => lsGet('instance'))
  // Which emulator control the dropdown is on: remembered like the other panel choices, so a repeated
  // action (say, several volume steps) does not need re-picking after a reload.
  const [emuControl, setEmuControl] = useState(() => lsGet('emuControl') || EMU_CONTROLS[0].value)
  // The file transfer's two ends, remembered like the other panel choices: pushing the same file twice,
  // or pulling from the same directory again, is the common case. There is no direction state — the two
  // buttons are the direction, which is what lets each field keep one meaning for good.
  const [fileLocal, setFileLocal] = useState(() => lsGet('fileLocal'))
  const [fileRemote, setFileRemote] = useState(() => lsGet('fileRemote'))
  // Device paths that worked, newest first. devecocli cannot list the device, so this is what keeps a
  // sandbox path from having to be typed from memory every time.
  const [recentRemote, setRecentRemote] = useState(() => {
    const cached = lsGetJson('recentRemote')
    return Array.isArray(cached) ? cached.filter((p) => typeof p === 'string' && p !== '') : []
  })
  // The same for the local end: a workspace path is easier to pick back up than to retype, and the field
  // stays typeable for everything the list does not hold.
  const [recentLocal, setRecentLocal] = useState(() => {
    const cached = lsGetJson('recentLocal')
    return Array.isArray(cached) ? cached.filter((p) => typeof p === 'string' && p !== '') : []
  })
  // The operation card folds: its rows are reached far less often than the deploy, and folding keeps the
  // panel short. Collapsed until asked for, and the choice is remembered like the other panel switches.
  const [showDevOps, setShowDevOps] = useState(() => lsGet('showDevOps') === '1')
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
    // Only follow when the view is already at the bottom. A flush can add hundreds of lines, and a
    // follow peaks around 775 lines a second, so sticking unconditionally would make history unreadable.
    if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 40) box.scrollTop = box.scrollHeight
  }, [logs])

  /**
   * The three start-up reads each apply their own result the moment it lands, so the panel paints
   * as answers arrive. Awaiting all three together keeps it blank until the slowest returns, and
   * every devecocli spawn costs ~0.6 s (mostly Node startup, more when three run at once).
   * `force` re-probes the toolchain (the cache in the host is what makes this cheap).
   */
  const refresh = async (force = false) => {
    // Any running action owns the busy flag: a refresh started over one would clear it when it finished and
    // silently re-enable every control that gates on it (a second deploy could then be launched).
    if (busy) return
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
    lsSet('emuControl', emuControl)
    lsSet('fileLocal', fileLocal)
    lsSet('fileRemote', fileRemote)
    lsSetJson('recentRemote', recentRemote)
    lsSetJson('recentLocal', recentLocal)
    lsSet('showDevOps', showDevOps ? '1' : '0')
    // The entry module is stored where it is decided, not here: this effect runs on a project switch with
    // the previous project's module still in state, which would overwrite the incoming project's memory.
    lsSet('deployAction', deployAction)
    lsSet('logLevel', logLevel)
    lsSet('logBundle', logBundle)
    lsSet('logKeyword', logKeyword)
    lsSet('logFrom', logFrom)
    lsSet('logLines', logLines)
  }, [project, scanRoot, instanceSel, emuControl, fileLocal, fileRemote, recentRemote, recentLocal, showDevOps, deployAction, logLevel, logBundle, logKeyword, logFrom, logLines])
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
      const picked = pickModule(mods, remembered)
      // Remember what this project actually resolved to, including a fallback whose remembered name is gone.
      if (picked) lsSet(lsModuleKey(proj), picked)
      setModuleSel(() => picked)
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
      else pushLog('info', `${name} 未运行(先点“启动”),当前设备保持 ${device || '无'}`)
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
      else pushLog('info', '未扫描到可用模拟器实例(可在 DevEco Device Manager 创建,若报授权请先在终端执行 devecocli emulator license accept)')
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
  /**
   * One emulator control. Nothing has to be typed in for these three verbs, which is what makes them a
   * dropdown in the first place: the choice names the whole request, and the button runs it. The target
   * is the device the card names, so the control acts on exactly what the row above shows — which also
   * means it waits for the same thing the screenshot does, a device that is online.
   */
  const runEmuControl = async () => {
    const target = targetDevice || ''
    if (!target) { pushLog('err', '暂无在线设备,请先启动模拟器'); return }
    const [action, direction] = emuControl.split(':')
    const named = emuControlLabel(emuControl)
    setBusy('control')
    try {
      const value = await rpc('emu.control', { target, action, direction: direction || undefined })
      pushLog(value.code === 0 ? 'ok' : 'err', `${named} [${target}] 退出码=${value.code ?? '-'}${value.output ? `\n${value.output}` : ''}`)
    } catch (error) {
      pushLog('err', `${named}失败:${error.message}`)
    } finally {
      setBusy('')
    }
  }
  /**
   * Pick the local end of a transfer. The shell offers a directory chooser and nothing else — its own
   * listing cannot even enumerate files — so this fills a folder, which is exactly what a download
   * needs: the CLI keeps the source file's own name inside it. An upload appends the file name by hand.
   */
  const pickLocalPath = async () => {
    try {
      const ui = ctx.get('uiWorkspace')
      if (!ui || typeof ui.pickDirectory !== 'function') { pushLog('err', '系统目录选择不可用,请直接粘贴路径'); return }
      const picked = await ui.pickDirectory()
      if (!picked) return
      setFileLocal(picked)
      pushLog('info', `已选择本地目录:${picked}`)
    } catch (error) {
      pushLog('err', `选择目录失败:${error.message}`)
    }
  }
  /**
   * One file in or out. The direction arrives with the press, because the button that was pressed is
   * the direction — which is what keeps each field's meaning fixed. The local end may be relative,
   * which the host reads against the workspace, and an empty one on a fetch means the workspace itself:
   * measured against the CLI, which then keeps the source file's own name.
   */
  const runFileTransfer = async (direction: 'send' | 'recv') => {
    const device = targetDevice || ''
    if (!device) { pushLog('err', '暂无在线设备,请先启动模拟器'); return }
    const remote = fileRemote.trim()
    if (!remote) { pushLog('err', '请填写设备路径'); return }
    const asked = fileLocal.trim() || (direction === 'recv' ? scopeCwd : '')
    if (!asked) { pushLog('err', '请填写本地路径'); return }
    setBusy(direction === 'send' ? 'file-send' : 'file-recv')
    try {
      const v = await rpc('device.file', { direction, device, local: asked, remote, root: scopeCwd })
      // Only a path that worked is worth offering back: recording every attempt would fill the list with
      // whatever was tried first, typo included.
      setRecentRemote((prev) => [v.remote, ...prev.filter((p) => p !== v.remote)].slice(0, RECENT_PATH_MAX))
      setRecentLocal((prev) => [v.local, ...prev.filter((p) => p !== v.local)].slice(0, RECENT_PATH_MAX))
      pushLog('ok', direction === 'send'
        ? `已上传:${v.local} → ${v.remote}`
        : `已下载:${v.remote} → ${v.local}`)
    } catch (error) {
      pushLog('err', `${direction === 'send' ? '上传' : '下载'}失败:${error.message}`)
    } finally {
      setBusy('')
    }
  }
  /**
   * One route, three intents. The button deploys, the build-only switch stops after the build, and the
   * clean button removes what a previous build produced. Clean touches no device, so it asks for
   * neither an online device nor a module.
   */
  const runDeploy = async (mode: 'run' | 'skipbuild' | 'build' | 'clean') => {
    if (!project.trim()) { pushLog('err', '请先在“应用项目”选择项目'); return }
    // Clean touches no device and build only compiles, so only the two that reach a device need one.
    if ((mode === 'run' || mode === 'skipbuild') && !targetDevice) { pushLog('err', '请先在“设备操作”选择在线设备'); return }
    setBusy(mode === 'clean' ? 'clean' : 'deploy')
    pushLog('info', mode === 'clean'
      ? `开始清理构建 → ${project}`
      : mode === 'build'
        ? `开始构建 → ${project}${moduleSel ? `(模块 ${moduleSel})` : ''}(构建可能需要数分钟)`
        : `开始构建并部署 → ${project} @ ${targetDevice}(构建可能需要数分钟)`)
    try {
      const res = await fetch(`${API}/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath: project,
          device: targetDevice || undefined,
          module: modules.length > 1 ? moduleSel : undefined,
          buildOnly: mode === 'build',
          skipBuild: mode === 'skipbuild',
          mode,
        }),
      })
      if (res.status !== 200) {
        let msg = `HTTP ${res.status}`
        try { const j = await res.json(); if (j && j.error && j.error.message) msg = j.error.message } catch { /* not JSON */ }
        pushLog('err', `${mode === 'clean' ? '清理' : '构建'}失败:${msg}`)
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
      // -2 is the host's marker for "cancelled", not a build failure. The wording follows the intent:
      // only a deploy released a device, and only a deploy installs anything.
      const verb = mode === 'clean' ? '清理' : '构建'
      pushLog(exitCode === 0 ? 'ok' : 'err', exitCode === 0
        ? mode === 'clean' ? '构建产物已清理' : mode === 'build' ? '构建完成' : '部署完成'
        : exitCode === -2
          ? `${verb}已取消${mode === 'run' ? '(设备已释放)' : ''}`
          : `${verb}结束(退出码 ${exitCode ?? '未知'})`)
    } catch (error) {
      pushLog('err', `${mode === 'clean' ? '清理' : '构建'}失败:${error instanceof Error ? error.message : String(error)}`)
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
    if (!targetDevice) { pushLog('err', '请先选择在线设备(设备操作)'); return }
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
        icon: IC.refresh, ghost: true, disabled: busy !== '', title: '刷新',
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
          h(Btn, { primary: true, style: { padding: '4px 12px' }, onClick: confirmMount, title: '确认切换挂载方式并重挂面板' }, '切换')),
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
      h('div', { style: { fontSize: 11, marginTop: 2, marginBottom: 6, opacity: .85 } }, '建议安装 @deveco/deveco-cli(仅覆盖 CLI,hdc/模拟器仍需安装 DevEco Studio SDK 并设置 DEVECO_SDK_HOME)。'),
      h(Btn, { secondary: true, disabled: installing, onClick: installCli, title: '只安装命令行工具,SDK 与模拟器仍需 DevEco Studio' }, busy === 'cli' ? '安装中…' : '一键安装 devecocli')))
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
        h(Btn, { icon: IC.scan, secondary: true, disabled: busy !== '', onClick: scanEmus, title: '列出本机可用的模拟器实例' }, busy === 'scan' ? '扫描中' : '扫描可用')),
      h(Btn, { icon: IC.play, primary: true, disabled: busy !== '' || (!instanceSel && !emuTarget.trim()), onClick: emuStart, title: '启动选中的实例,冷启动较慢' }, busy === 'start' ? '启动中' : '启动'),
      h(Btn, { icon: IC.stop, dangerSolid: true, disabled: busy !== '', onClick: emuStop, title: '停止选中的实例' }, '停止')),
    h('div', { style: row },
      h('span', { style: label }, '状态'),
      // A value, so it reads at the size values read at — it used to sit at hint size beside a 12px
      // button, which made the state of the emulator the smallest thing on its own row.
      selInst ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: selToneColor } },
        h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: selToneColor } }),
        selTone.label) : h('span', { style: { fontSize: 12, color: s.faint } }, '未实例'),
      h('div', { style: { flex: 1 } }),
      h(Btn, { secondary: true, disabled: busy !== '', onClick: checkReady, title: '检测模拟器串号是否已上线' }, '检测就绪'),
      h(Btn, { ghost: true, disabled: busy !== '', onClick: toggleManual, title: showManual ? '收起手动输入' : '自己填设备串号,不走在线设备列表' }, showManual ? '收起手动输入' : '手动输入'),
      h(Btn, { ghost: true, disabled: busy !== '', onClick: () => setShowRaw((v) => !v), title: showRaw ? '收起面板的原始输出' : '展开面板的原始输出,排查时看' }, showRaw ? '收起原始输出' : '原始输出')),
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
        h(Btn, { secondary: true, disabled: !manualSerial.trim(), onClick: () => setDevice(manualSerial.trim()), title: '把填写的串号设为部署目标设备' }, '用该串号作为部署设备'),
        h('div', { style: { fontSize: 11, color: s.faint } }, '实例名参与启动/停止,串号可一键设为部署设备')))
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
      h(Btn, { icon: IC.folder, secondary: true, disabled: busy !== '', onClick: pickNative, title: '选择一个本地目录作为项目根' }, '浏览')),
    h('div', { style: row },
      h('span', { style: label }, '项目'),
      h(Dropdown, {
        value: project, placeholder: projectOptions.length ? '选择扫描到的项目…' : '扫描后选择项目',
        align: 'left',
        options: projectOptions.map((p) => ({ value: p, label: p })),
        onChange: setProject,
      }),
      h(Btn, { icon: IC.scan, secondary: true, disabled: busy !== '', onClick: () => runScan(), title: '在根目录下(最多 3 层)查找鸿蒙工程' }, busy === 'scan' ? '扫描中' : '扫描')),
    modules.length > 1 ? h('div', { style: row, key: 'moduleRow' },
      h('span', { style: label }, '入口模块'),
      h(Dropdown, { value: moduleSel, placeholder: '选择入口模块', align: 'left', options: modules.map((m) => ({ value: m, label: m })), onChange: (v) => { setModuleSel(v); lsSet(lsModuleKey(project), v) } }),
    ) : null,
    // On-demand project checks (no model-tool schema cost). Details live in tooltips so
    // the panel itself stays free of explanatory clutter.
    h('div', { style: row, key: 'lintRow' },
      h('span', { style: label }, '代码检查'),
      h(Btn, {
        secondary: true, disabled: busy !== '' || !project.trim(),
        onClick: () => runLint('changed'), title: '只检查已跟踪文件的未提交改动(快,新建文件请用「全量检查」)',
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
        title: fixReady.changed ? '自动修复未提交改动中可修复的告警,无法自动修复的不会列出' : '先点「检查改动」查看范围后才能修复',
      }, busy === 'lint-fix' ? '修复中…' : '自动修复'),
      h(Btn, {
        secondary: true, disabled: busy !== '' || !fixReady.all, onClick: () => runLint('fix-all'),
        title: fixReady.all ? '自动修复整个项目中可修复的告警,无法自动修复的不会列出' : '先点「全量检查」查看范围后才能修复',
      }, busy === 'lint-fix-all' ? '修复中…' : '全量修复')),
    // Live status while a check runs: the linter only writes its report at the end, so the
    // ticking clock is what tells the user it is still working.
    lintTitle ? h('div', {
      key: 'lintProgress',
      style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: s.muted, margin: '-2px 0 8px' },
    },
      h('span', { style: { display: 'inline-flex' } }, h(Icon, { src: IC.clock, size: 12 })),
      `${lintTitle}进行中… 已用时 ${lintSec}s(检查工具在结束时才输出报告)`) : null,
    h('div', { style: { fontSize: 11, color: s.faint, margin: '-2px 0 8px' } }, '需包含 build-profile.json5 的项目根,点「扫描」列出子目录项目,或「浏览」直接选择'),
  ))

  // The target and the command that runs against it belong together, and both stay outside the fold
  // below: the plugin's primary action must not vanish when the operation card is collapsed.
  const devLabel = (serial) => deviceLabel(instances, serial)
  nodes.push(h(Card, { key: 'deployCard', title: '设备部署' },
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
    // One row: the button names the command it will run, and the control beside it says what it is for —
    // 执行操作, opening the four commands. Naming the two differently is what keeps the row from saying
    // the same words twice.
    h('div', { key: 'deployRow', style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
      h('span', { style: label }, '操作'),
      h(Btn, {
        // Solid red for the risky command, blue for the two build ones: the fill is what carries the
        // warning. One press runs it — the command had to be picked from the menu first, which is the
        // deliberate step, and what clean deletes a build recreates.
        primary: deployAction !== 'clean', dangerSolid: deployAction === 'clean', disabled: busy !== '',
        icon: deployAction === 'clean' ? undefined : IC.deploy,
        title: deployAction === 'clean'
          ? '删除该工程的构建产物,不安装、不启动'
          : `构建耗时取决于改动量,首次约 1–3 分钟${targetDevice ? `,目标 ${targetDevice}` : ''}`,
        onClick: () => { void runDeploy(deployAction) },
        style: { flex: '1 1 120px', minWidth: 0, padding: '8px 10px', fontWeight: 600, fontSize: 13 },
      }, busy !== ''
        ? (deployAction === 'clean' ? '清理中…' : deployAction === 'build' ? '构建中…' : deployAction === 'skipbuild' ? '部署中…' : '构建部署中…')
        : (deployAction === 'clean'
          ? '清理构建'
          : deployAction === 'build' ? '构建' : deployAction === 'skipbuild' ? '部署' : '构建并部署')),
      h('div', { style: { flex: '0 0 auto', width: 108 } },
        h(Dropdown, {
          value: deployAction, caption: '执行选项',
          title: `当前命令:${deployCommandLabel(deployAction)}。点开可选择`,
          options: DEPLOY_COMMANDS,
          onChange: setDeployAction,
        })),
    ),
    (targetDevice
      ? h('div', { style: { fontSize: 11, color: s.faint, marginTop: 6 } }, '部署将发送到该设备(启动模拟器后自动更新)')
      : (devices.length
        ? h('div', { style: { fontSize: 11, color: s.faint, marginTop: 6 } }, `检测到 ${devices.length} 台在线设备,已默认选第一台`)
        : h('div', { style: { fontSize: 11, color: s.faint, marginTop: 6 } }, '暂无在线设备,请先在「模拟器实例」启动模拟器'))),
  ))

  // What is left acts on the device named above and is reached far less often than the deploy, so it
  // folds — remembering the choice — the way the log card's filter row does. The header keeps naming the
  // device, so an expanded card never acts on something the reader cannot see.
  nodes.push(h(Card, {
    key: 'devCard',
    title: '设备操作',
    action: h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      // Ellipsised rather than wrapped: in a narrow sidebar a long device label must not push the card's
      // own title around.
      h('span', { style: { fontSize: 11, color: s.faint, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 } }, targetDevice ? devLabel(targetDevice) : '暂无在线设备'),
      h(Btn, {
        ghost: true, onClick: () => setShowDevOps((on) => !on), style: { padding: '2px 8px', fontSize: 12 },
        title: showDevOps ? '收起控制、传输与截图' : '展开控制、传输与截图',
      }, showDevOps ? '收起' : '展开')),
  },
    showDevOps ? [
      // The emulator controls act on the device this panel names, exactly as the deploy does — the CLI
      // takes a serial here as readily as an instance name — so they lead the card: pick one, run it.
      h('div', { key: 'emuControlRow', style: { ...row, marginBottom: 0 } },
        h('span', { style: label }, '控制'),
        h(Dropdown, { value: emuControl, options: EMU_CONTROLS, onChange: setEmuControl }),
        h(Btn, {
          secondary: true, disabled: busy !== '' || !targetDevice, onClick: () => { void runEmuControl() },
          // Same width as the 浏览 button on the row below, so the two stack in one column instead of stepping.
          style: { flex: '0 0 86px', boxSizing: 'border-box' },
          title: '执行选中的设备操作,作用于上方设备',
        }, busy === 'control' ? '执行中' : '执行')),
      // The two ends first, the direction last: a press here submits the pair above, which is why the
      // buttons read as the direction of travel rather than as a mode that has to be picked first.
      h('div', { key: 'fileLocalRow', style: { ...row, marginTop: 8, marginBottom: 0 } },
        h('span', { style: label }, '本地路径'),
        h(Dropdown, {
          editable: true, align: 'left', value: fileLocal,
          placeholder: '相对工作区或绝对路径',
          title: '上传时填要上传的文件,下载时填保存目录',
          options: [
            // An empty field already means the workspace root for a download, so offering it says out loud
            // what the field would otherwise do silently. Not removable: it is not a history entry.
            ...(scopeCwd ? [{ value: scopeCwd, label: scopeCwd, title: scopeCwd }] : []),
            ...recentLocal.filter((p) => p !== scopeCwd)
              .map((p) => ({
                value: p, label: p, title: p,
                onRemove: () => setRecentLocal((prev) => prev.filter((x) => x !== p)),
              })),
          ],
          onChange: setFileLocal,
        }),
        // The shell's chooser picks directories only, so the button says so rather than promising a file.
        h(Btn, {
          icon: IC.folder, secondary: true, disabled: busy !== '', onClick: () => { void pickLocalPath() },
          // Same width as the 执行 button two rows above: the card's row-end buttons form one column.
          style: { flex: '0 0 86px', boxSizing: 'border-box' },
          title: '选择一个本地目录,选完可在路径后补上文件名',
        }, '浏览')),
      h('div', { key: 'fileRemoteRow', style: { ...row, marginTop: 6, marginBottom: 0 } },
        h('span', { style: label }, '设备路径'),
        // The device cannot be listed — devecocli has no such command — so the field carries the device's two
        // folders plus whatever already worked. Editable, because a sandbox path has no enumerable set:
        // pasting one is the case that matters most, and a plain menu would take that away.
        h(Dropdown, {
          editable: true, align: 'left', value: fileRemote,
          placeholder: '/storage/media/100/local/files/Docs/Download/文件名',
          title: '设备上的文件路径,可从下拉选常用目录',
          options: [
            ...DEVICE_PATH_PRESETS.map((p) => ({ value: p, label: p, title: p })),
            ...recentRemote.filter((p) => !DEVICE_PATH_PRESETS.includes(p))
              .map((p) => ({
                value: p, label: p, title: p,
                onRemove: () => setRecentRemote((prev) => prev.filter((x) => x !== p)),
              })),
          ],
          onChange: setFileRemote,
        })),
      // Labelled and left-aligned like the other action rows here (代码修复, 执行): the label already
      // anchors the left end, so the buttons follow it. The 状态 row pushes its buttons right only because
      // something sits to their left — borrowing that shape here is what made the row look orphaned.
      h('div', { key: 'fileActionsRow', style: { ...row, marginTop: 8, marginBottom: 0 } },
        h('span', { style: label }, '传输'),
        h(Btn, {
          secondary: true, disabled: busy !== '' || !targetDevice, onClick: () => { void runFileTransfer('send') },
          title: '把「本地路径」的文件复制到设备上的「设备路径」',
        }, busy === 'file-send' ? '上传中…' : '上传到设备'),
        h(Btn, {
          secondary: true, disabled: busy !== '' || !targetDevice, onClick: () => { void runFileTransfer('recv') },
          title: '把「设备路径」的文件复制到「本地路径」,本地路径留空则保存到工作区',
        }, busy === 'file-recv' ? '下载中…' : '下载到本地')),
      // The screenshot closes the card: it is the thing you reach for once the device is doing what you
      // came for. Outlined and full width, so it never competes with the primary button above.
      h('div', { style: { marginTop: 8 } },
        h(Btn, {
          secondary: true, icon: IC.camera, disabled: busy !== '' || !targetDevice, onClick: takeShot,
          style: { width: '100%' },
          title: '截取当前设备屏幕,图片保存到工作区的 screenshots 目录',
        }, busy === 'shot' ? '截图中…' : '截图当前设备屏幕')),
    ] : null,
  ))

  /**
   * Follow the device log until it is stopped. The panel owns the request: 停止 aborts the fetch, which
   * closes the connection, which is what lets the other side kill the CLI. Lines land in the same box as
   * every other run, one line at a time.
   */
  const toggleFollow = async () => {
    if (following) { followCtl.current?.abort(); return }
    const ctl = new AbortController()
    followCtl.current = ctl
    setFollowing(true)
    pushLog('info', `开始实时监听日志 → ${targetDevice || '运行中的实例'}(点“停止监听”结束)`)
    try {
      const res = await fetch(`${API}/log.follow`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({
          device: targetDevice || undefined,
          level: logLevel || undefined,
          bundle: logBundle || undefined,
          keyword: logKeyword.trim() || undefined,
          from: logFrom.trim() || undefined,
        }),
      })
      if (res.status !== 200) {
        let msg = `HTTP ${res.status}`
        try { const j = await res.json(); if (j && j.error && j.error.message) msg = j.error.message } catch { /* not JSON */ }
        pushLog('err', `监听失败:${msg}`)
        return
      }
      if (!res.body) { pushLog('err', '宿主未返回可读内容'); return }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      // A chatty device can push hundreds of lines a second (measured ~775/s on an emulator), and one state
      // update per line locks the render loop — the box would look stuck. Lines are collected here and flushed
      // on a timer, which keeps the scroll smooth and applies the 200-entry cap in one place.
      let pending: { kind: string; text: string }[] = []
      const flush = () => {
        if (pending.length === 0) return
        const batch = pending
        pending = []
        setLogs((prev) => [...prev, ...batch].slice(-200))
      }
      const timer = setInterval(flush, 200)
      // A follow that matches nothing looks identical to a broken one. If the first seconds bring no line at all,
      // say so once — the usual cause is a level filter this device never emits.
      let seen = false
      const quiet = setTimeout(() => {
        if (!seen) pushLog('info', '已开始监听,按当前条件暂时没有日志输出')
      }, 3000)
      const put = (line) => {
        if (!line || exitCodeOf(line) !== null) return
        const clean = cleanCliLine(line)
        if (clean.trim()) { seen = true; pending.push({ kind: 'raw', text: clean }) }
      }
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() || ''
          for (const l of lines) put(l.replace(/\r$/, ''))
        }
        if (buf.trim()) put(buf)
        // Show everything that arrived before the closing line.
        flush()
      } finally {
        clearInterval(timer)
        // The quiet warning must not outlive the stream, or a stopped follow would still get its line.
        clearTimeout(quiet)
        // A stop mid-flood still shows what it had: flush is a no-op once the buffer is empty.
        flush()
      }
      pushLog('info', '日志监听已结束')
    } catch (error) {
      // An abort is the user stopping the follow, not a failure to report as one.
      pushLog(ctl.signal.aborted ? 'info' : 'err', ctl.signal.aborted
        ? '已停止监听'
        : `监听失败:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      followCtl.current = null
      setFollowing(false)
    }
  }

  /**
   * The line that opens every read. The box is append-only — deploys, starts and earlier reads share it — so
   * each read says which conditions it ran under, which is what lets an older block be told apart at a glance.
   * The clock comes from the panel's own per-line prefix; printing one here too would show the time twice.
   */
  const readBanner = (device: string, tail: number) => {
    const label = (list: Array<{ value: string; label: string }>, value: string) => list.find((o) => o.value === value)?.label
    const bits = [`${tail} 行`, label(LOG_TIMES, logFrom) ?? logFrom, label(LOG_LEVELS, logLevel) ?? '全部级别']
    if (logBundle.trim()) bits.push(`应用 ${logBundle.trim()}`)
    if (logKeyword.trim()) bits.push(`关键字 ${logKeyword.trim()}`)
    return `— 读取设备日志到调试框(${bits.join(', ')}) @ ${device} —`
  }

  /** One log snapshot, printed where every other run lands. */
  const readLog = async () => {
    setBusy('log')
    try {
      const r = await rpc('log.snapshot', {
        device: targetDevice || undefined,
        level: logLevel || undefined,
        bundle: logBundle || undefined,
        keyword: logKeyword.trim() || undefined,
        from: logFrom.trim() || undefined,
        tail: Number(logLines) || 50,
      })
      pushLog(r.code === 0 ? 'ok' : 'err', `${readBanner(r.device, r.tail)}\n${String(r.output ?? '').trim() ? r.output : '(当前条件没有匹配到日志,可先放宽级别或关键字再试)'}`)
    } catch (error) {
      pushLog('err', `读取设备日志失败:${error instanceof Error ? error.message : String(error)}`)
    } finally { setBusy('') }
  }

  /**
   * Save what the debug box holds. The panel owns the lines — streamed CLI output already collected — so this
   * asks where to put them and lets the host write them there. Escape sequences come off first: they carry the
   * CLI's colours on screen and mean nothing in a text file.
   */
  const exportLog = async () => {
    if (logs.length === 0) { pushLog('err', '调试框暂无日志可导出'); return }
    const ui = ctx.get('uiWorkspace')
    if (!ui || typeof ui.pickDirectory !== 'function') { pushLog('err', '系统目录选择不可用,无法选择保存位置'); return }
    // The picker runs before the busy flag: an open system dialog is not the panel being busy.
    let dir = ''
    try {
      dir = (await ui.pickDirectory()) || ''
    } catch (error) {
      pushLog('err', `选择保存文件夹失败:${error.message}`)
      return
    }
    if (!dir) return
    setBusy('log-export')
    try {
      const text = logs.map((l) => ansiRuns(l.text).map((run) => run.text).join('')).join('\n')
      // The request body is capped, so a very long box exports its tail: the recent part is the useful one.
      const capped = text.length > LOG_EXPORT_MAX
      const v = await rpc('log.export', {
        dir, device: targetDevice || undefined, text: capped ? text.slice(-LOG_EXPORT_MAX) : text,
      })
      pushLog('ok', `调试日志已导出:${v.path}(${v.bytes} 字节${capped ? ',已截取最近部分' : ''})`)
    } catch (error) {
      pushLog('err', `导出调试日志失败:${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy('')
    }
  }

  /**
   * One log, from the device straight to a file. It takes the same conditions as 读取设备日志到调试框 and skips
   * entirely — that is the point: the box keeps only the last 200 lines, so a long log written through it
   * would be a tail. The box gets nothing either, just the line saying where the file landed.
   */
  const exportDeviceLog = async () => {
    const ui = ctx.get('uiWorkspace')
    if (!ui || typeof ui.pickDirectory !== 'function') { pushLog('err', '系统目录选择不可用,无法选择保存位置'); return }
    // The picker runs before the busy flag: an open system dialog is not the panel being busy.
    let dir = ''
    try {
      dir = (await ui.pickDirectory()) || ''
    } catch (error) {
      pushLog('err', `选择保存文件夹失败:${error.message}`)
      return
    }
    if (!dir) return
    setBusy('log-export-device')
    try {
      const r = await rpc('log.snapshot', {
        device: targetDevice || undefined,
        level: logLevel || undefined,
        bundle: logBundle || undefined,
        keyword: logKeyword.trim() || undefined,
        from: logFrom.trim() || undefined,
        tail: Number(logLines) || 50,
      })
      if (r.code !== 0) { pushLog('err', `导出设备日志失败:${r.output}`); return }
      const text = ansiRuns(r.output).map((run) => run.text).join('')
      const capped = text.length > LOG_EXPORT_MAX
      const v = await rpc('log.export', {
        dir, device: targetDevice || undefined, text: capped ? text.slice(-LOG_EXPORT_MAX) : text,
      })
      pushLog('ok', `设备日志已导出:${v.path}(${v.bytes} 字节${capped ? ',已截取最近部分' : ''})`)
    } catch (error) {
      pushLog('err', `导出设备日志失败:${error instanceof Error ? error.message : String(error)}`)
    } finally { setBusy('') }
  }

  // Debug output
  nodes.push(h('div', { key: 'logWrap', style: { ...card, marginTop: 4, padding: 8, marginBottom: 0 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' } },
      h('span', { style: { fontSize: 13, fontWeight: 600, color: s.fg } }, '调试输出'),
      h('div', { style: { flex: 1 } }),
      // The header holds the two actions that are about the box itself rather than about the device: save what it
      // holds, and clear it. The reset stays rightmost, where the one press that cannot be undone belongs.
      h(Btn, {
        ghost: true, disabled: busy !== '' || logs.length === 0, onClick: () => { void exportLog() },
        style: { padding: '2px 8px', fontSize: 12 },
        title: '把下方调试框当前内容保存为文本文件,点击后选择保存文件夹',
      }, busy === 'log-export' ? '导出中…' : '导出调试日志'),
      h(Btn, {
        ghost: true, disabled: logs.length === 0, onClick: clearLogs, style: { padding: '2px 8px', fontSize: 12 },
        title: '清空下方日志显示,已导出的文件不受影响',
      }, '清空')),
    // The conditions are always on show: the actions that use them now sit inside this block, and a folded
    // block would leave the card without any way to read a log.
    h('div', { style: { marginBottom: 6 } },
      // A labelled form rather than placeholders: a value has to keep saying what it is once the hint is
      // gone, the same fix the transfer paths got.
      h('div', { style: { fontSize: 11, color: s.muted, marginBottom: 4 } }, '筛选条件'),
      h('div', { style: { ...row, marginBottom: 6 } },
        h('span', { style: label }, '应用'),
        h('input', {
          style: field, value: logBundle, placeholder: '如 com.example.app',
          title: '只保留该应用的日志,填应用的包名',
          onChange: (e) => setLogBundle(e.target.value), spellCheck: false,
        })),
      h('div', { style: { ...row, marginBottom: 6 } },
        h('span', { style: label }, '关键字'),
        h('input', {
          style: field, value: logKeyword, placeholder: '包含该词',
          title: '只保留包含该关键字的日志行',
          onChange: (e) => setLogKeyword(e.target.value), spellCheck: false,
        }),
        // The level closes this row: it narrows the same lines the keyword does, so the two read as one
        // filter. A list rather than a switch, so the next level this CLI grows is one more option.
        h('div', { style: { flex: '0 0 auto', width: 96 } },
          h(Dropdown, {
            value: logLevel, placeholder: '全部级别',
            options: LOG_LEVELS,
            onChange: setLogLevel,
          })),
        // The live toggle closes this row, right of the level: 实时监听 and 停止监听 are the same length, so the
        // row cannot shift when it flips, and the row of data actions below keeps its two even halves.
        h(Btn, {
          primary: true, disabled: busy !== '', onClick: () => { void toggleFollow() }, style: { flex: '0 0 auto' },
          title: following ? '停止监听,并结束设备侧的日志流' : '实时监听设备日志:按上面的条件,最长 30 分钟,再点一次停止',
        }, following ? '停止监听' : '实时监听')),
      // Each parameter sits on the row of the action it decides, labelled on the left like the two above: the
      // count belongs to the one-shot read, the start belongs to the follow (where it reads as "backfill from
      // here"). Both rows keep the button at full width, so 实时监听 turning into 停止监听 cannot shift it.
      h('div', { style: { ...row, marginBottom: 6 } },
        h('span', { style: label }, '读取行数'),
        // 112 wide like the start dropdown below, and border-box for it: the two parameters then end on the same
        // vertical line, which is what lines their buttons up too.
        h('input', {
          style: { ...field, boxSizing: 'border-box', width: 112, flex: '0 0 auto', textAlign: 'center' }, value: logLines,
          placeholder: '50', title: '一次读取最后多少行',
          onChange: (e) => setLogLines(e.target.value), spellCheck: false,
        }),
        // The start sits on this row because these are the actions it narrows: it decides how far back a read
        // reaches. The follow takes it as its backfill point, which its own tooltip says.
        h('span', { style: { fontSize: 11, color: s.muted } }, '起始时间'),
        h('div', { style: { flex: '0 0 auto', width: 112 }, title: '读取与导出取这段时间内的日志,实时监听先补这段时间的历史再持续输出' },
          h(Dropdown, {
            value: logFrom, placeholder: logFrom || LOG_TIMES[0].label,
            options: LOG_TIMES,
            onChange: setLogFrom,
          })),
        h(Btn, {
          primary: true, disabled: busy !== '' || following, onClick: () => { void readLog() }, style: { flex: 1 },
          title: '按上面的条件取最后 N 行,只读一次,不会持续输出',
        }, busy === 'log' ? '读取中…' : '读取设备日志到调试框'),
        h(Btn, {
          primary: true, disabled: busy !== '' || following, onClick: () => { void exportDeviceLog() },
          style: { flex: 1 },
          title: '取回的日志只写成文件,不写入下方调试框',
        }, busy === 'log-export-device' ? '导出中…' : '导出设备日志到文件')),
    ),
    h('pre', {
      key: 'logbox', ref: logBox, style: {
        ...field, maxHeight: 220, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'ui-monospace, Consolas, "Courier New", monospace', fontSize: 11,
      },
    }, logs.length === 0
      ? '(构建、部署与设备日志将在此显示)'
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
        title: '复制截图文件的完整路径',
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

