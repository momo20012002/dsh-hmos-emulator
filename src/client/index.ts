/* eslint-disable */
    interface Ctx { get(name: string): any; effect(callback: () => any, label?: string): void }
    const { createElement: h, useEffect, useRef, useState } = require('react')

    // ── Inline SVG icons; fill is forced to currentColor so they follow the theme ──
    const svg = (vb, body) => `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" fill="currentColor">${body}</svg>`
    const IC = {
      emulator: svg('0 0 1024 1024', '<path d="M768 264.32c-21.12-11.52-42.24-21.76-64-28.8-30.72-11.52-61.44-18.56-91.52-17.92h-3.2c-159.36 3.84-348.8 187.52-348.8 223.36 0 36.48 176.64 227.2 352 224.64 30.656-0.704 61.44-7.04 91.52-17.344 21.76-7.68 43.52-17.28 64-28.8 111.36-59.52 196.48-159.36 196.48-178.56 0-18.496-88.96-116.416-196.48-176.576z m0 214.4c-9.6 35.2-32.64 65.28-64 85.12-25.6 17.28-57.6 26.88-91.52 26.88-88.96 0-160.64-67.2-160.64-149.76s71.68-149.12 160.64-149.12c33.92 0 65.92 9.6 91.52 26.88 31.36 19.84 54.4 49.92 64 85.12a140.544 140.544 0 0 1 0 74.88z"/><path d="M546.944 441.728c0 33.408 28.864 60.608 65.28 60.608 35.904 0 65.152-27.2 65.152-60.608 0-33.6-29.248-60.608-65.152-60.608-36.416 0-65.28 26.944-65.28 60.608z"/><path d="M768 128.64V128c0-35.2-28.8-64-64-64H192c-35.2 0-64 28.8-64 64v768c0 35.2 28.8 64 64 64h512c35.2 0 64-28.8 64-64v-192H192V183.04c0-30.08 23.04-55.04 51.2-55.04M448 771.84c24.96 0 44.8 20.48 44.8 45.44 0 24.384-19.84 44.8-44.8 44.8s-44.8-20.416-44.8-44.8c0-24.96 19.84-45.44 44.8-45.44z m320-535.04v-1.28h-2.56c0.64 0.64 1.92 0.64 2.56 1.28z"/>'),
      play: svg('0 0 1024 1024', '<path d="M320 256l448 256-448 256V256z"/>'),
      stop: svg('0 0 1024 1024', '<path d="M300 232h424a68 68 0 0 1 68 68v424a68 68 0 0 1-68 68H300a68 68 0 0 1-68-68V300a68 68 0 0 1 68-68z"/>'),
      refresh: svg('0 0 1024 1024', '<path d="M511.582491 63.413262C265.134543 63.413262 64.62588 263.921925 64.62588 510.369873s200.508663 446.957635 446.957635 446.957635 446.957635-200.508663 446.957635-446.957635S758.031463 63.413262 511.582491 63.413262zM509.001713 751.859903c-98.517781 0-182.467775-62.623269-214.771505-150.056598l0.327458-0.134053c-2.007727-4.036943-3.38305-8.422833-3.38305-13.237489 0-16.647145 13.494339-30.142507 30.142507-30.142507 13.389962 0 24.358781 8.877181 28.2893 20.955264l0.422625-0.172939c23.269983 65.442478 85.645612 112.503307 158.972665 112.503307 93.106538 0 168.845523-75.738985 168.845523-168.845523s-75.738985-168.845523-168.845523-168.845523c-20.432355 0-39.874149 3.980661-58.013275 10.66899l21.248953 40.742936c2.486634 2.677992 4.0175 6.2831 4.0175 10.243295 0 8.417717-8.404414 14.921851-15.365966 15.07023-0.102331 0-0.206708 0-0.309038 0-0.220011 0-0.427742 0-0.647753-0.013303l-150.579507-6.463202c-5.372358-0.234337-10.229992-3.310396-12.716626-8.093329-2.486634-4.76963-2.236947-10.509355 0.647753-15.055904l80.890308-127.179564c2.8847-4.533246 8.006348-7.151887 13.365402-6.960529 5.372358 0.234337 10.227945 3.312442 12.71458 8.095375l18.580171 35.625382c26.629497-10.855232 55.683207-16.963347 86.168522-16.963347 126.338407 0 229.130537 102.791108 229.130537 229.130537S635.340119 751.859903 509.001713 751.859903z"/>'),
      scan: svg('0 0 1024 1024', '<path d="M128 384V160c0-17.6 14.4-32 32-32h224v64H192v192h-64z m512-192h192v192h64V160c0-17.6-14.4-32-32-32H640v64z m192 448v192H640v64h224c17.6 0 32-14.4 32-32V640h-64z m-448 192H192V640h-64v224c0 17.6 14.4 32 32 32h224v-64z m512-352H128v64h768v-64z"/>'),
      deploy: svg('0 0 1024 1024', '<path d="M576 64L256 576h176L352 960l352-512H512l64-384z"/>'),
      folder: svg('0 0 1024 1024', '<path d="M855.04 385.024q19.456 2.048 38.912 10.24t33.792 23.04 21.504 37.376 2.048 54.272q-2.048 8.192-8.192 40.448t-14.336 74.24-18.432 86.528-19.456 76.288q-5.12 18.432-14.848 37.888t-25.088 35.328-36.864 26.112-51.2 10.24l-567.296 0q-21.504 0-44.544-9.216t-42.496-26.112-31.744-40.96-12.288-53.76l0-439.296q0-62.464 33.792-97.792t95.232-35.328l503.808 0q22.528 0 46.592 8.704t43.52 24.064 31.744 35.84 12.288 44.032l0 11.264-53.248 0q-40.96 0-95.744-0.512t-116.736-0.512-115.712-0.512-92.672-0.512l-47.104 0q-26.624 0-41.472 16.896t-23.04 44.544q-8.192 29.696-18.432 62.976t-18.432 61.952q-10.24 33.792-20.48 65.536-2.048 8.192-2.048 13.312 0 17.408 11.776 29.184t29.184 11.776q31.744 0 43.008-39.936l54.272-198.656q133.12 1.024 243.712 1.024l286.72 0z"/>'),
      clock: svg('0 0 1024 1024', '<path d="M511.913993 63.989249c-247.012263 0-447.924744 200.912481-447.924744 447.924744s200.912481 447.924744 447.924744 447.924744 447.924744-200.912481 447.924744-447.924744S758.926256 63.989249 511.913993 63.989249zM511.913993 895.677474c-211.577356 0-383.763481-172.186125-383.763481-383.763481 0-211.577356 172.014111-383.763481 383.763481-383.763481s383.763481 172.014111 383.763481 383.763481S723.491349 895.677474 511.913993 895.677474z"/><path d="M672.05913 511.913993l-159.973123 0L512.086007 288.123635c0-17.717453-14.277171-32.166639-31.994625-32.166639-17.717453 0-31.994625 14.449185-31.994625 32.166639l0 255.956996c0 17.717453 14.277171 31.994625 31.994625 31.994625l191.967747 0c17.717453 0 32.166639-14.277171 32.166639-31.994625C704.053754 526.191164 689.604569 511.913993 672.05913 511.913993z"/>'),
      chevron: svg('0 0 1024 1024', '<path d="M256 384l256 256 256-256H256z"/>'),
      camera: svg('0 0 1024 1024', '<path d="M928 256H768l-64-96a64 64 0 0 0-53-28H373a64 64 0 0 0-53 28l-64 96H96a64 64 0 0 0-64 64v512a64 64 0 0 0 64 64h832a64 64 0 0 0 64-64V320a64 64 0 0 0-64-64zM512 800a224 224 0 1 1 0-448 224 224 0 0 1 0 448z m0-352a128 128 0 1 0 0 256 128 128 0 0 0 0-256z"/>'),
    }

    const API = '/dsh-hmos-emulator/api'

    async function rpc(method: string, body?: any) {
      let res
      try {
        res = await fetch(`${API}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body === undefined ? {} : body),
        })
      } catch (error) {
        throw new Error(`无法连接宿主端:${error instanceof Error ? error.message : String(error)}`)
      }
      let json = null
      try {
        json = await res.json()
      } catch {
        throw new Error(`宿主返回非 JSON(HTTP ${res.status})`)
      }
      if (json && json.ok === true) return json.value
      const message = json && json.error && json.error.message ? json.error.message : `HTTP ${res.status}`
      throw new Error(message)
    }

    // ── Design tokens (follow DSH theme variables; usable in light and dark) ──
    /** Panel-facing names of the four check modes, shared by the buttons and the status line. */
    const LINT_TITLES = { changed: '检查改动', all: '全量检查', fix: '自动修复', 'fix-all': '全量修复' }
    /** Elapsed time of a running step: "42s" below a minute, "1m12s" above. */
    const fmtDur = (ms: number) => {
      const sec = Math.max(0, Math.round(ms / 1000))
      return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
    }
    const s = {
      fg: 'var(--dsh-fg, #e6e6e6)',
      muted: 'var(--dsh-muted, rgba(148,148,160,.9))',
      faint: 'rgba(148,148,160,.7)',
      border: 'var(--dsh-border, rgba(148,148,160,.18))',
      bg: 'rgba(148,148,160,.05)',
      bg2: 'rgba(148,148,160,.03)',
      accent: 'var(--dsh-accent, #4f6ef7)',
      accentSoft: 'rgba(79,110,247,.16)',
      ok: 'var(--dsh-success, #2f9e44)',
      danger: 'var(--dsh-danger, #e5484d)',
      solid: '#1d1f28',
    }
    const row = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }
    const label = { fontSize: 12, color: s.muted, width: 64, flex: '0 0 64px' }
    const field = {
      flex: 1, minWidth: 0, background: s.bg2, color: s.fg,
      border: `1px solid ${s.border}`, borderRadius: 8, padding: '6px 10px', fontSize: 12,
      fontFamily: 'ui-monospace, Consolas, "Courier New", monospace',
    }
    const card = { background: s.bg, border: `1px solid ${s.border}`, borderRadius: 10, padding: 10, marginBottom: 12 }
    const btnBase = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      borderRadius: 8, padding: '6px 12px', fontSize: 12, lineHeight: 1, cursor: 'pointer',
      border: `1px solid transparent`, whiteSpace: 'nowrap',
    }
    const btnPrimary = { ...btnBase, background: s.accent, color: '#fff' }
    const btnSecondary = { ...btnBase, border: `1px solid ${s.border}`, color: s.fg, background: 'transparent' }
    const btnGhost = { ...btnBase, color: s.muted, background: 'transparent' }
    const btnDanger = { ...btnBase, border: `1px solid ${s.danger}`, color: s.danger, background: 'transparent' }
    const btnDangerSolid = { ...btnBase, background: s.danger, color: '#fff' }
    const logLine = (kind) => ({
      fontSize: 11, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: s.fg,
    })
    const warnBox = { background: 'rgba(229,72,77,.12)', border: `1px solid ${s.danger}`, color: s.danger, borderRadius: 8, padding: 8, fontSize: 12, marginBottom: 10, lineHeight: 1.5 }

    /** Inline SVG icon forced to currentColor so it follows the theme. */
    function Icon({ src, size = 16 }: { src: string; size?: number }) {
      const body = String(src).replace(/fill="[^"]*"/g, 'fill="currentColor"')
      return h('span', {
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flex: '0 0 auto' },
        dangerouslySetInnerHTML: { __html: body },
      })
    }
    /** Button with an optional leading icon. */
    function Btn({ children, icon, primary, secondary, danger, dangerSolid, ghost, disabled, onClick, style, title }: {
      children?: any; icon?: string; primary?: boolean; secondary?: boolean; danger?: boolean; dangerSolid?: boolean; ghost?: boolean; disabled?: boolean; onClick?: any; style?: any; title?: string
    }) {
      const base = primary ? btnPrimary : secondary ? btnSecondary : dangerSolid ? btnDangerSolid : danger ? btnDanger : ghost ? btnGhost : btnSecondary
      return h('button', {
        style: { ...base, ...style, ...(disabled ? { opacity: .5, cursor: 'not-allowed' } : undefined) },
        disabled, onClick, title,
      }, icon ? h(Icon, { src: icon, size: 15 }) : null, children)
    }
    /** Card block. action renders at the right of the title row; style overrides the card. */
    function Card({ title, action, style, children }: { title?: string; action?: any; style?: any; children?: any }) {
      return h('div', { style: { ...card, ...style } },
        (title || action) ? h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 8 } },
          title ? h('span', { style: { fontSize: 11, color: s.muted, letterSpacing: '.06em', textTransform: 'uppercase' } }, title) : null,
          h('div', { style: { flex: 1 } }),
          action || null) : null,
        children)
    }

    /** Themed dropdown: closed by default, opens on click; the list uses the dark surface. */
    function Dropdown({ value, placeholder, options, onChange }: {
      value?: string; placeholder?: string; options?: { value: string; label: string; status?: string }[]; onChange?: (v: string) => void
    }) {
      const [open, setOpen] = useState(false)
      const current = options.find((o) => o.value === value)
      return h('div', { style: { position: 'relative', flex: 1, minWidth: 0 } },
        h('div', { style: { position: 'relative' } },
          h('button', {
            style: { ...field, display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', color: s.fg, cursor: 'pointer', width: '100%' },
            onClick: () => setOpen((o) => !o),
          },
            h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: current ? s.fg : s.faint } }, current ? current.label : (placeholder || '选择…')),
            h('span', { style: { display: 'inline-flex', color: s.faint, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .12s' } }, h(Icon, { src: IC.chevron, size: 14 }))),
          open ? h('div', { style: {
            position: 'absolute', zIndex: 10, left: 0, right: 0, top: 'calc(100% + 4px)',
            background: s.solid, border: `1px solid ${s.border}`, borderRadius: 8, padding: 4,
            boxShadow: '0 8px 24px rgba(0,0,0,.45)', maxHeight: 220, overflowY: 'auto',
          } },
            options.length === 0
              ? h('div', { style: { padding: '7px 8px', fontSize: 12, color: s.faint } }, '无可选项')
              : options.map((o) => h('div', {
                key: o.value, style: {
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
                  background: o.value === value ? s.accentSoft : 'transparent', color: s.fg,
                },
                onClick: () => { onChange(o.value); setOpen(false) },
                onMouseEnter: (e) => { e.currentTarget.style.background = s.accentSoft },
                onMouseLeave: (e) => { e.currentTarget.style.background = o.value === value ? s.accentSoft : 'transparent' },
              },
                o.status ? h('span', { style: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto', background: o.status === 'running' ? s.ok : s.faint, boxShadow: '0 0 0 1px rgba(0,0,0,.25)' }, title: o.status }) : null,
                h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 } }, o.label))))
            : null),
        open ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 9 }, onClick: () => setOpen(false) }) : null,
      )
    }

    // Keep the last screenshot in module scope so it survives a panel remount.
    let lastShot = null

    function Panel(props: { scope?: { sessionId?: string; cwd?: string }; ctx: Ctx }) {
      const { scope, ctx } = props
      // Persist the last selection (project / scan dir / instance / module) to avoid re-picking.
      const LS_PREFIX = 'dsh-hmos-emulator:'
      const lsGet = (k) => { try { return localStorage.getItem(LS_PREFIX + k) || '' } catch { return '' } }
      const lsSet = (k, v) => { try { localStorage.setItem(LS_PREFIX + k, v) } catch { /* ignore */ } }
      // localStorage is shared by every session of this origin, but a scan root and a project
      // belong to one workspace: keyed per session, so opening another session does not restore
      // the previous workspace's selection instead of its own.
      const lsSessionKey = (k) => ((scope && scope.sessionId) ? `${k}:${scope.sessionId}` : k)
      // An entry module name only means something inside the project it came from.
      const lsModuleKey = (p) => (p ? `module:${p}` : 'module')
      const [tc, setTc] = useState(null)
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
      const [emuRaw, setEmuRaw] = useState('')
      const [emuTarget, setEmuTarget] = useState('')
      const [instances, setInstances] = useState([])
      const [instanceSel, setInstanceSel] = useState(() => lsGet('instance'))
      const [shot, setShotState] = useState(lastShot)
      const [copied, setCopied] = useState(false)
      const [lintReady, setLintReady] = useState(false)
      // Fix buttons stay locked until the matching check has shown what is in scope.
      const [fixReady, setFixReady] = useState({ changed: false, all: false })
      const [lintSec, setLintSec] = useState(0)
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
      const [devices, setDevices] = useState([])
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
        const line = `${new Date().toLocaleTimeString()} ${text}`
        setLogs((prev) => [...prev.slice(-200), { kind, text: line }])
      }
      const clearLogs = () => setLogs([])

      useEffect(() => {
        const box = logBox.current
        if (box) box.scrollTop = box.scrollHeight
      }, [logs])

      const refresh = async () => {
        if (busy === 'refresh') return
        setBusy('refresh')
        try {
          const [toolchain, emu, dev] = await Promise.all([
            rpc('toolchain'), rpc('emu.list').catch((e) => ({ raw: `获取失败:${e.message}` })), rpc('devices'),
          ])
          setTc(toolchain)
          setTcMsg('')
          setEmuRaw(emu.raw || '(空)')
          // Resolve the target from the list just fetched: the state variables still hold this
          // render's values here, so looking the instance up in `instances` misses its serial and
          // silently falls back to the first device whenever more than one is online.
          const list = emu.instances || []
          const selName = instanceSel || list[0]?.name || ''
          setInstances(list)
          setInstanceSel((prev) => prev || selName)
          setDevices(dev.devices || [])
          if (dev.devices && dev.devices.length) {
            setDevice(pickDevice(dev.devices, list.find((it) => it.name === selName)?.serial))
          }
          pushLog('info', '已刷新:工具链就绪' + (toolchain.devecoCliJs ? '' : '(devecocli 未找到)'))
        } catch (error) {
          pushLog('err', `刷新失败:${error.message}`)
          setTcMsg(error.message)
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
      // A check prints nothing until it is done (verified: codelinter buffers its whole run), so
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
      // panel is already rendered (the previous one-shot default inside refresh() never ran again).
      useEffect(() => {
        if (!scopeCwd || scanRootEdited.current) return
        setScanRoot((prev) => prev || scopeCwd)
      }, [scopeCwd])
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
      // (Setting the project alone used to leave the row showing its placeholder, because the
      // dropdown can only render a value it has an option for.)
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
      const scanInto = async (root) => {
        const value = await rpc('scan', { root })
        setProjectOptions(value.projects || [])
        if (value.projects && value.projects.length) {
          // Selecting the project is enough: the project effect loads its entry modules.
          setProject(value.projects[0])
          pushLog('info', `扫描「${value.root}」发现 ${value.projects.length} 个项目,已默认选中第一个`)
        } else {
          setModules([]); setModuleSel('')
          pushLog('info', `“${value.root}”下(≤3 层)未发现鸿蒙项目`)
        }
        return value.projects || []
      }
      const runScan = async () => {
        const root = scanRoot.trim()
        if (!root) { pushLog('err', '请先填写扫描目录'); return }
        setBusy('scan')
        try {
          await scanInto(root)
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
          // Prefer the module remembered for THIS project, then entry, then the first one.
          const remembered = lsGet(lsModuleKey(proj))
          setModuleSel(() => (mods.includes(remembered) ? remembered : mods.includes('entry') ? 'entry' : mods[0] || ''))
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
          const st = v.summary || {}
          // The host phrases the outcome ("nothing to check" vs "checked and clean") because only
          // it can tell those apart; fall back to raw numbers on an older host.
          const line = v.stats || `错误 ${st.errors ?? '-'}、警告 ${st.warnings ?? '-'}、建议 ${st.suggestions ?? '-'}、涉及文件 ${st.files ?? '-'}`
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
      // Pick the deploy target: prefer the running emulator serial, else the first device.
      const pickDevice = (list: string[], preferredSerial?: string) => {
        if (!list || !list.length) return ''
        if (preferredSerial && list.includes(preferredSerial)) return preferredSerial
        return list[0]
      }
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
            if (line.startsWith('[HMOS_EXIT]=')) { exitCode = Number(line.slice(12)); return }
            // Strip ANSI color codes and \r, then trailing spaces, so the log stays readable.
            const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').replace(/\s+$/, '')
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
          pushLog(exitCode === 0 ? 'ok' : 'err', exitCode === 0 ? '部署完成' : `部署结束(退出码 ${exitCode ?? '未知'})`)
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
      const installCli = async () => {
        if (busy === 'cli') return
        setBusy('cli')
        try {
          const v = await rpc('deveco.install')
          pushLog(v.code === 0 ? 'ok' : 'err', `${v.note}\n${v.output}`)
          if (v.code === 0) {
            const t = await rpc('toolchain')
            setTc(t)
            pushLog('ok', '已重新检测工具链')
          }
        } catch (error) {
          pushLog('err', `安装失败:${error.message}`)
        } finally {
          setBusy('')
        }
      }

      // Shorten the path to its last two segments (keeps the file name); full path in title.
      const shortPath = (p) => {
        const parts = String(p).split(/[\\/]/)
        return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : String(p)
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

      // Update devecocli (devecocli update) so an outdated CLI can be fixed in one click.
      const updateCli = async () => {
        if (busy === 'cli-up') return
        setBusy('cli-up')
        try {
          const v = await rpc('deveco.update')
          pushLog(v.code === 0 ? 'ok' : 'err', `${v.note}\n${v.output}`)
          if (v.code === 0) {
            const t = await rpc('toolchain')
            setTc(t)
            pushLog('ok', '已重新检测工具链')
          }
        } catch (error) {
          pushLog('err', `更新失败:${error.message}`)
        } finally {
          setBusy('')
        }
      }

      // ── Render ──────────────────────────────────────────────────────────
      const nodes = []
      // Header
      nodes.push(h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
        h('span', { style: { width: 20, height: 20, display: 'inline-flex', color: s.accent } }, h(Icon, { src: IC.emulator, size: 20 })),
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, '鸿蒙模拟器'),
          h('div', { style: { fontSize: 11, color: s.muted } }, 'DevEco 部署控制台')),
        h(Btn, { icon: IC.refresh, ghost: true, disabled: busy === 'refresh', onClick: refresh, title: '刷新' }, '刷新'),
      ))

      // devecocli version row (one-click update; keeps CLI and IDE toolchains in sync)
      if (tc && tc.devecoCliJs) {
        nodes.push(h('div', { key: 'cliVer', style: { display: 'flex', alignItems: 'center', gap: 6, margin: '-4px 0 8px', fontSize: 11, color: s.faint } },
          h('span', null, `devecocli ${tc.devecoCliVersion || '版本未知'}`),
          h(Btn, { ghost: true, disabled: busy !== '', onClick: updateCli, style: { padding: '2px 8px' } }, busy === 'cli-up' ? '更新中…' : '更新'),
        ))
      }

      // Toolchain banners so a missing CLI surfaces before the user clicks anything
      if (tc) {
        if (!tc.devecoCliJs) nodes.push(h('div', { key: 'warnCli', style: warnBox },
          h('div', null, '未检测到 devecocli:启动/部署功能不可用。'),
          h('div', { style: { fontSize: 11, marginTop: 2, marginBottom: 6, opacity: .85 } }, '建议安装 @deveco/deveco-cli(仅覆盖 CLI;hdc/模拟器仍需安装 DevEco Studio SDK 并设置 DEVECO_SDK_HOME)。'),
          h(Btn, { secondary: true, disabled: busy === 'cli', onClick: installCli }, busy === 'cli' ? '安装中…' : '一键安装 devecocli')))
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
          selInst ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: selInst.status === 'running' ? s.ok : s.danger } },
            h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: selInst.status === 'running' ? s.ok : s.danger } }),
            selInst.status === 'running' ? '运行中' : '已停止') : h('span', { style: { fontSize: 11, color: s.faint } }, '未实例'),
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
          h(Btn, { icon: IC.scan, secondary: true, disabled: busy !== '', onClick: runScan }, busy === 'scan' ? '扫描中' : '扫描')),
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
      const devLabel = (serial) => {
        const n = instances.find((it) => it.serial === serial)?.name
        return n ? `${n} (${serial})` : serial
      }
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
          h('span', { style: { fontSize: 11, color: s.muted, letterSpacing: '.06em', textTransform: 'uppercase' } }, '调试输出'),
          h('div', { style: { flex: 1 } }),
          h(Btn, { ghost: true, onClick: clearLogs, style: { padding: '2px 8px' } }, '清空')),
        h('pre', {
          key: 'logbox', ref: logBox, style: {
            ...field, maxHeight: 220, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'ui-monospace, Consolas, "Courier New", monospace', fontSize: 11,
          },
        }, logs.length === 0
          ? '(构建/部署信息将显示在这里)'
          : logs.map((l, i) => h('div', { key: i, style: { ...logLine(l.kind), color: l.kind === 'err' ? s.danger : l.kind === 'ok' ? s.ok : l.kind === 'info' ? s.muted : s.fg } }, l.text))),
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
        onMouseDown: onPanelDragStart,
        style: {
          padding: 8, color: s.fg, height: '100%', overflowY: 'auto', boxSizing: 'border-box',
          background: 'var(--dsw-alias-bg-base, rgba(46, 52, 66, 0.55))',
          backdropFilter: 'blur(18px) saturate(1.15)',
          WebkitBackdropFilter: 'blur(18px) saturate(1.15)',
        },
      }, nodes)
    }

    function apply(ctx: Ctx) {
      // Isolation: never throw from client apply; log only, so the DSH client loader is unaffected.
      let disposed = false
      let registered = false
      let timer = null
      let attempts = 0
      const tryRegister = () => {
        if (disposed || registered) return
        try {
          const better = ctx.get('betterSidebar')
          if (better === undefined || typeof better.registerTab !== 'function') {
            if (++attempts > 80) { console.warn('[dsh-hmos-emulator] 未检测到 dsh-better-sidebar 服务,停止等待。'); return }
            timer = setTimeout(tryRegister, 700)
            return
          }
          registered = true
          ctx.effect(() => better.registerTab({
            id: 'hmos:emulator',
            title: () => '鸿蒙模拟器',
            icon: (size) => h(Icon, { src: IC.emulator, size: size || 16 }),
            order: 55,
            single: true,
            component: (props) => h(Panel, { scope: props.scope, ctx }),
          }), 'dsh-hmos-emulator: register tab')
        } catch (error) {
          console.error('[dsh-hmos-emulator] 客户端注册异常(已隔离,不影响 DSH):', error)
        }
      }
      tryRegister()
      ctx.effect(() => () => { disposed = true; if (timer) clearTimeout(timer) })
    }
module.exports = { apply };
