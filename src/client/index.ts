/* eslint-disable */
    interface Ctx { get(name: string): any; effect(callback: () => any, label?: string): void }
    const { createElement: h, useEffect, useRef, useState } = require('react')

    // ── iconfont 图标(内联 SVG;渲染时统一 fill→currentColor 取主题色) ──
    const svg = (vb, body) => `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" fill="currentColor">${body}</svg>`
    const IC = {
      emulator: svg('0 0 1024 1024', '<path d="M768 264.32c-21.12-11.52-42.24-21.76-64-28.8-30.72-11.52-61.44-18.56-91.52-17.92h-3.2c-159.36 3.84-348.8 187.52-348.8 223.36 0 36.48 176.64 227.2 352 224.64 30.656-0.704 61.44-7.04 91.52-17.344 21.76-7.68 43.52-17.28 64-28.8 111.36-59.52 196.48-159.36 196.48-178.56 0-18.496-88.96-116.416-196.48-176.576z m0 214.4c-9.6 35.2-32.64 65.28-64 85.12-25.6 17.28-57.6 26.88-91.52 26.88-88.96 0-160.64-67.2-160.64-149.76s71.68-149.12 160.64-149.12c33.92 0 65.92 9.6 91.52 26.88 31.36 19.84 54.4 49.92 64 85.12a140.544 140.544 0 0 1 0 74.88z"/><path d="M546.944 441.728c0 33.408 28.864 60.608 65.28 60.608 35.904 0 65.152-27.2 65.152-60.608 0-33.6-29.248-60.608-65.152-60.608-36.416 0-65.28 26.944-65.28 60.608z"/><path d="M768 128.64V128c0-35.2-28.8-64-64-64H192c-35.2 0-64 28.8-64 64v768c0 35.2 28.8 64 64 64h512c35.2 0 64-28.8 64-64v-192H192V183.04c0-30.08 23.04-55.04 51.2-55.04M448 771.84c24.96 0 44.8 20.48 44.8 45.44 0 24.384-19.84 44.8-44.8 44.8s-44.8-20.416-44.8-44.8c0-24.96 19.84-45.44 44.8-45.44z m320-535.04v-1.28h-2.56c0.64 0.64 1.92 0.64 2.56 1.28z"/>'),
      play: svg('0 0 1024 1024', '<path d="M675.328 117.717333A425.429333 425.429333 0 0 0 512 85.333333C276.352 85.333333 85.333333 276.352 85.333333 512s191.018667 426.666667 426.666667 426.666667 426.666667-191.018667 426.666667-426.666667c0-56.746667-11.093333-112-32.384-163.328a21.333333 21.333333 0 0 0-39.402667 16.341333A382.762667 382.762667 0 0 1 896 512c0 212.074667-171.925333 384-384 384S128 724.074667 128 512 299.925333 128 512 128c51.114667 0 100.8 9.984 146.986667 29.12a21.333333 21.333333 0 0 0 16.341333-39.402667zM456.704 305.92C432.704 289.152 405.333333 303.082667 405.333333 331.797333v360.533334c0 28.586667 27.541333 42.538667 51.370667 25.856l252.352-176.768c21.76-15.253333 21.632-43.541333 0-58.709334l-252.373333-176.768z m-8.597333 366.72V351.466667l229.269333 160.597333-229.269333 160.597333z"/>'),
      stop: svg('0 0 1024 1024', '<path d="M512 853.333333c-187.733333 0-341.333333-153.6-341.333333-341.333333s153.6-341.333333 341.333333-341.333333 341.333333 153.6 341.333333 341.333333-153.6 341.333333-341.333333 341.333333z m0-85.333333c140.8 0 256-115.2 256-256s-115.2-256-256-256-256 115.2-256 256 115.2 256 256 256z m-85.333333-341.333333h170.666666v170.666666h-170.666666v-170.666666z"/>'),
      refresh: svg('0 0 1024 1024', '<path d="M511.582491 63.413262C265.134543 63.413262 64.62588 263.921925 64.62588 510.369873s200.508663 446.957635 446.957635 446.957635 446.957635-200.508663 446.957635-446.957635S758.031463 63.413262 511.582491 63.413262zM509.001713 751.859903c-98.517781 0-182.467775-62.623269-214.771505-150.056598l0.327458-0.134053c-2.007727-4.036943-3.38305-8.422833-3.38305-13.237489 0-16.647145 13.494339-30.142507 30.142507-30.142507 13.389962 0 24.358781 8.877181 28.2893 20.955264l0.422625-0.172939c23.269983 65.442478 85.645612 112.503307 158.972665 112.503307 93.106538 0 168.845523-75.738985 168.845523-168.845523s-75.738985-168.845523-168.845523-168.845523c-20.432355 0-39.874149 3.980661-58.013275 10.66899l21.248953 40.742936c2.486634 2.677992 4.0175 6.2831 4.0175 10.243295 0 8.417717-8.404414 14.921851-15.365966 15.07023-0.102331 0-0.206708 0-0.309038 0-0.220011 0-0.427742 0-0.647753-0.013303l-150.579507-6.463202c-5.372358-0.234337-10.229992-3.310396-12.716626-8.093329-2.486634-4.76963-2.236947-10.509355 0.647753-15.055904l80.890308-127.179564c2.8847-4.533246 8.006348-7.151887 13.365402-6.960529 5.372358 0.234337 10.227945 3.312442 12.71458 8.095375l18.580171 35.625382c26.629497-10.855232 55.683207-16.963347 86.168522-16.963347 126.338407 0 229.130537 102.791108 229.130537 229.130537S635.340119 751.859903 509.001713 751.859903z"/>'),
      scan: svg('0 0 1024 1024', '<path d="M128 384V160c0-17.6 14.4-32 32-32h224v64H192v192h-64z m512-192h192v192h64V160c0-17.6-14.4-32-32-32H640v64z m192 448v192H640v64h224c17.6 0 32-14.4 32-32V640h-64z m-448 192H192V640h-64v224c0 17.6 14.4 32 32 32h224v-64z m512-352H128v64h768v-64z"/>'),
      deploy: svg('0 0 1024 1024', '<path d="M576 64L256 576h176L352 960l352-512H512l64-384z"/>'),
      folder: svg('0 0 1024 1024', '<path d="M855.04 385.024q19.456 2.048 38.912 10.24t33.792 23.04 21.504 37.376 2.048 54.272q-2.048 8.192-8.192 40.448t-14.336 74.24-18.432 86.528-19.456 76.288q-5.12 18.432-14.848 37.888t-25.088 35.328-36.864 26.112-51.2 10.24l-567.296 0q-21.504 0-44.544-9.216t-42.496-26.112-31.744-40.96-12.288-53.76l0-439.296q0-62.464 33.792-97.792t95.232-35.328l503.808 0q22.528 0 46.592 8.704t43.52 24.064 31.744 35.84 12.288 44.032l0 11.264-53.248 0q-40.96 0-95.744-0.512t-116.736-0.512-115.712-0.512-92.672-0.512l-47.104 0q-26.624 0-41.472 16.896t-23.04 44.544q-8.192 29.696-18.432 62.976t-18.432 61.952q-10.24 33.792-20.48 65.536-2.048 8.192-2.048 13.312 0 17.408 11.776 29.184t29.184 11.776q31.744 0 43.008-39.936l54.272-198.656q133.12 1.024 243.712 1.024l286.72 0z"/>'),
      clock: svg('0 0 1024 1024', '<path d="M511.913993 63.989249c-247.012263 0-447.924744 200.912481-447.924744 447.924744s200.912481 447.924744 447.924744 447.924744 447.924744-200.912481 447.924744-447.924744S758.926256 63.989249 511.913993 63.989249zM511.913993 895.677474c-211.577356 0-383.763481-172.186125-383.763481-383.763481 0-211.577356 172.014111-383.763481 383.763481-383.763481s383.763481 172.014111 383.763481 383.763481S723.491349 895.677474 511.913993 895.677474z"/><path d="M672.05913 511.913993l-159.973123 0L512.086007 288.123635c0-17.717453-14.277171-32.166639-31.994625-32.166639-17.717453 0-31.994625 14.449185-31.994625 32.166639l0 255.956996c0 17.717453 14.277171 31.994625 31.994625 31.994625l191.967747 0c17.717453 0 32.166639-14.277171 32.166639-31.994625C704.053754 526.191164 689.604569 511.913993 672.05913 511.913993z"/>'),
      chevron: svg('0 0 1024 1024', '<path d="M256 384l256 256 256-256H256z"/>'),
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

    // ── 设计系统(产品化,跟随 DSH 主题变量,明暗两态可用) ────────────────
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
    const logLine = (kind) => ({
      fontSize: 11, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: s.fg,
    })

    /** 内联 SVG 图标:统一取 currentColor,跟随主题。 */
    function Icon({ src, size = 16 }: { src: string; size?: number }) {
      const body = String(src).replace(/fill="[^"]*"/g, 'fill="currentColor"')
      return h('span', {
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flex: '0 0 auto' },
        dangerouslySetInnerHTML: { __html: body },
      })
    }
    /** 带图标的按钮。 */
    function Btn({ children, icon, primary, secondary, danger, ghost, disabled, onClick, style, title }: {
      children?: any; icon?: string; primary?: boolean; secondary?: boolean; danger?: boolean; ghost?: boolean; disabled?: boolean; onClick?: any; style?: any; title?: string
    }) {
      const base = primary ? btnPrimary : secondary ? btnSecondary : danger ? btnDanger : ghost ? btnGhost : btnSecondary
      return h('button', {
        style: { ...base, ...style, ...(disabled ? { opacity: .5, cursor: 'not-allowed' } : undefined) },
        disabled, onClick, title,
      }, icon ? h(Icon, { src: icon, size: 15 }) : null, children)
    }
    /** 区块卡片。 */
    function Card({ title, children }: { title?: string; children?: any }) {
      return h('div', { style: card },
        title ? h('div', { style: { fontSize: 11, color: s.muted, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 8 } }, title) : null,
        children)
    }

    /** 主题化下拉框:默认收起,点按钮打开;选项走深色主题,不出现原生白底。 */
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
            background: 'var(--dsh-bg-solid, #1d1f28)', border: `1px solid ${s.border}`, borderRadius: 8, padding: 4,
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

    function Panel(props: { scope?: { sessionId?: string; cwd?: string }; ctx: Ctx }) {
      const { scope, ctx } = props
      const [tc, setTc] = useState(null)
      const [tcMsg, setTcMsg] = useState('')
      const [project, setProject] = useState('')
      const [scanRoot, setScanRoot] = useState('')
      const [projectOptions, setProjectOptions] = useState([])
      const [emuRaw, setEmuRaw] = useState('')
      const [emuTarget, setEmuTarget] = useState('')
      const [instances, setInstances] = useState([])
      const [instanceSel, setInstanceSel] = useState('')
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
      const [busy, setBusy] = useState('')
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
          setInstances(emu.instances || [])
          setInstanceSel((prev) => prev || ((emu.instances || [])[0]?.name || ''))
          setDevices(dev.devices || [])
          setDevRaw(dev.raw || '')
          setScanRoot((prev) => prev || (scope && scope.cwd) || '')
          if (!device && dev.devices && dev.devices.length === 1) setDevice(dev.devices[0])
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

      // ── 应用工程选择 ─────────────────────────────────────────────────
      // 直接调用系统/宿主原生目录选择框。
      const pickNative = async () => {
        setBusy('browse')
        try {
          const ui = ctx.get('uiWorkspace')
          if (ui && typeof ui.pickDirectory === 'function') {
            const p = await ui.pickDirectory()
            if (p) { setProject(p); pushLog('ok', `已选择项目:${p}`) }
          } else {
            pushLog('err', '系统目录选择不可用,请用「扫描」或直接粘贴路径')
          }
        } catch (error) {
          pushLog('err', `系统选择失败:${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy('')
        }
      }
      // 扫描「扫描目录」下的工程,填充工程下拉框。
      const runScan = async () => {
        const root = scanRoot.trim()
        if (!root) { pushLog('err', '请先填写扫描目录'); return }
        setBusy('scan')
        try {
          const value = await rpc('scan', { root })
          setProjectOptions(value.projects || [])
          if (value.projects && value.projects.length) {
            pushLog('info', `扫描「${value.root}」发现 ${value.projects.length} 个项目,已默认选中第一个`)
            setProject(value.projects[0])
          } else {
            pushLog('info', `“${value.root}”下(≤3 层)未发现鸿蒙项目`)
          }
        } catch (error) {
          pushLog('err', `扫描失败:${error.message}`)
        } finally {
          setBusy('')
        }
      }
      const pickProject = (path) => {
        setProject(path)
        pushLog('ok', `已选择项目:${path}`)
      }

      // ── 模拟器/部署动作 ──────────────────────────────────────────────
      const scanEmus = async () => {
        if (busy === 'scan') return
        setBusy('scan')
        try {
          const v = await rpc('emu.list')
          setInstances(v.instances || [])
          setEmuRaw(v.raw || '')
          const first = (v.instances || [])[0]
          if (first) setInstanceSel((prev) => prev || first.name)
          else pushLog('info', '未扫描到可用模拟器实例(可在 DevEco Device Manager 创建;若报授权请先在终端执行 devecocli emulator license accept)')
        } catch (error) {
          pushLog('err', `扫描失败:${error.message}`)
        } finally {
          setBusy('')
        }
      }
      const emuStart = async () => {
        const target = instanceSel || emuTarget.trim()
        if (!target) { pushLog('err', '请先点“扫描可用”并选择实例,或手动输入实例名'); return }
        setBusy('start')
        try {
          const value = await rpc('emu.start', { name: target })
          pushLog(value.code === 0 ? 'ok' : 'err', `启动模拟器[${target}] 退出码=${value.code ?? '-'}\n${value.output}`)
          if (value.code === 0) pushLog('info', '模拟器冷启动约需 1–2 分钟,就绪后点“刷新”并在“部署目标”选择该设备')
        } catch (error) {
          pushLog('err', `启动失败:${error.message}`)
        } finally {
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
        } catch (error) {
          pushLog('err', `停止失败:${error.message}`)
        } finally {
          setBusy('')
        }
      }
      const deploy = async () => {
        if (!project.trim()) { pushLog('err', '请先在“应用项目”选择项目'); return }
        if (!device) { pushLog('err', '请先在“部署目标”选择在线设备'); return }
        setBusy('deploy')
        pushLog('info', `开始构建并部署 → ${project} @ ${device}(构建可能需要数分钟)`)
        try {
          const value = await rpc('deploy', { projectPath: project, device })
          pushLog(value.code === 0 ? 'ok' : 'err', `${value.note}\n${value.output}`)
        } catch (error) {
          pushLog('err', `部署失败:${error.message}`)
        } finally {
          setBusy('')
        }
      }

      // ── 渲染 ─────────────────────────────────────────────────────────
      const nodes = []
      // 顶栏
      nodes.push(h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 } },
        h('span', { style: { width: 20, height: 20, display: 'inline-flex', color: s.accent } }, h(Icon, { src: IC.emulator, size: 20 })),
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, '鸿蒙模拟器'),
          h('div', { style: { fontSize: 11, color: s.muted } }, 'DevEco 部署控制台')),
        h(Btn, { icon: IC.refresh, ghost: true, disabled: busy === 'refresh', onClick: refresh, title: '刷新' }, '刷新'),
      ))

      // 模拟器实例
      nodes.push(h(Card, { key: 'emuCard', title: '模拟器实例' },
        h('div', { style: row },
          h('span', { style: label }, '模拟器'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 } },
            h(Dropdown, {
              value: instanceSel, placeholder: instances.length ? '选择模拟器实例…' : '(先点“扫描可用”)',
              options: instances.map((it) => ({ value: it.name, label: it.name, status: it.status })),
              onChange: setInstanceSel,
            }),
            h(Btn, { icon: IC.scan, secondary: true, disabled: busy !== '', onClick: scanEmus }, busy === 'scan' ? '扫描中' : '扫描可用')),
          h(Btn, { icon: IC.play, primary: true, disabled: busy !== '' || (!instanceSel && !emuTarget.trim()), onClick: emuStart }, busy === 'start' ? '启动中' : '启动'),
          h(Btn, { icon: IC.stop, danger: true, disabled: busy !== '', onClick: emuStop }, '停止')),
        h('div', { style: row },
          h('span', { style: label }, '状态'),
          selInst ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: selInst.status === 'running' ? s.ok : s.faint } },
            h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: selInst.status === 'running' ? s.ok : s.faint } }),
            selInst.status === 'running' ? '运行中' : '已停止') : h('span', { style: { fontSize: 11, color: s.faint } }, '未实例'),
          h('div', { style: { flex: 1 } }),
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

      // 应用工程
      nodes.push(h(Card, { key: 'projCard', title: '应用项目' },
        h('div', { style: row },
          h('span', { style: label }, '查找目录'),
          h('input', {
            style: field, value: scanRoot, placeholder: '默认为当前工作目录',
            onChange: (e) => setScanRoot(e.target.value), spellCheck: false,
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
        h('div', { style: { fontSize: 11, color: s.faint, margin: '-2px 0 8px' } }, '需包含 build-profile.json5 的项目根;点「扫描」列出子目录项目,或「浏览」直接选择'),
      ))

      // 部署目标
      const devInst = device ? instances.find((it) => it.serial === device) : undefined
      nodes.push(h(Card, { key: 'devCard', title: '部署目标' },
        h('div', { style: row },
          h('span', { style: label }, '设备'),
          h(Dropdown, {
            value: device, placeholder: devices.length ? '选择在线设备…' : '(无在线设备,先启动模拟器)',
            options: devices.map((d) => {
              const inst = instances.find((it) => it.serial === d)
              return { value: d, label: inst ? `${inst.name} (${d})` : d, status: inst ? inst.status : undefined }
            }),
            onChange: setDevice,
          })),
        (devices.length
          ? (device
            ? h('div', { style: { fontSize: 11, color: s.faint, marginTop: 4 } }, `已选择目标:${devInst ? `${devInst.name} ` : ''}${device}`)
            : h('div', { style: { fontSize: 11, color: s.faint, marginTop: 4 } }, `在线设备 ${devices.length} 台,请选择部署目标`))
          : h('div', { style: { fontSize: 11, color: s.faint, marginTop: 4 } }, '暂无在线设备;请先在「模拟器实例」启动模拟器,再点「刷新」')),
      ))

      // 部署主按钮
      nodes.push(h('div', { key: 'deployBtn', style: { marginTop: 2 } },
        h(Btn, {
          primary: true, disabled: busy !== '', onClick: deploy, icon: IC.deploy,
          style: { width: '100%', padding: '10px 12px', fontWeight: 600, fontSize: 13 },
        }, busy === 'deploy' ? '构建并部署中…' : '构建并部署到所选设备'),
        h('div', { style: { fontSize: 11, color: s.faint, margin: '6px 2px 0' } }, 'devecocli run:构建 → 安装 → 启动(首次约 1–3 分钟)'),
      ))

      // 调试输出
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

      return h('div', { style: { padding: 8, color: s.fg } }, nodes)
    }

    function apply(ctx: Ctx) {
      // 隔离:客户端 apply 的任何异常只打日志、绝不抛出,避免影响 DSH client loader。
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
