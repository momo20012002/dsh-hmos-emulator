/**
 * Which sidebar carries the emulator panel, and the switch that moves it.
 *
 * The same panel has two possible hosts, and exactly one of them may ever be registered at a
 * time — two live registrations show two «鸿蒙模拟器» tabs:
 *   native — DSH's own right Sidebar: a registered tab type plus the keyed seat that draws it.
 *   better — the optional dsh-better-sidebar workbench: one registered tab.
 *
 * The choice is a client preference that defaults to the native host. It persists through the shell's
 * client store (see {@link preferenceStore}), which is localStorage underneath: the value is needed
 * synchronously, before the first registration, so a host round trip is not an option. Availability
 * is probed against the live services on every apply: an unavailable host never becomes the
 * effective one, and asking for it is refused with a readable reason instead of being ignored or
 * half-mounted.
 *
 * This module holds no renderer of its own — the panel component and its glyph arrive from the
 * entry half, so the file stays importable outside the browser bundle.
 */
import { Ctx } from './ctx.js'
import { preferenceStore } from './host-store.js'
import { clientLoggerOf } from './log.js'

/** Which sidebar carries the panel. */
export type MountMode = 'native' | 'better'

/** What the panel's switch renders: the request, the result, and why they differ. */
export interface MountStatus {
  /** What the user last chose; persisted, defaults to `native`. */
  requested: MountMode
  /** What is registered right now, or `none` when this host offers neither. */
  effective: MountMode | 'none'
  nativeReady: boolean
  betterReady: boolean
  /** Which services this page publishes right now, for the panel's diagnostic log. */
  services: HostServices
  /** Readable reason the requested host is not the effective one; empty when it is. */
  reason: string
}

/** The three services the two hosts are made of: what the probe reads, kept for diagnosis. */
export interface HostServices {
  readonly slots: boolean
  readonly tabs: boolean
  readonly better: boolean
}

/** The panel and its glyph, supplied by the entry half. */
export interface MountView {
  /** The panel component, mounted in whichever host wins. */
  view: (props: any) => any
  /** The tab glyph, at the size the host asks for. */
  icon: (size?: number) => any
  /**
   * Wraps a native tab body. The seat injects `useTabInfo`, and `tab.actions.close` is the only way
   * one's own tab can be closed — register it through {@link retainNativeTab} so a host switch
   * retires the open tab instead of leaving its chip behind.
   * @param props - the body's slot props, including the injected tab hook.
   * @param render - draws the panel for one tab scope.
   * @returns the rendered body.
   */
  nativeBody?: (props: any, render: (scope: any) => any) => any
}

/** One live registration, disposable as a unit. */
interface ActiveMount {
  mode: MountMode
  fiber: any
  disposers: (() => void)[]
  disposed: boolean
  /** Called once the registration actually landed, which can be later than the mount attempt. */
  settle?: () => void
  /**
   * Whether this registration still owes the user a reveal: a switch opens the panel in the host that
   * took it, and that open has to wait for the type to be registered (see {@link openInHost}).
   */
  reveal?: boolean
}

/**
 * The requested host, as the shell's client store persists it.
 *
 * One read per page: the store rehydrates itself while this module is evaluated, and every later read
 * answers from memory — which is what lets {@link applyMount} decide the host synchronously, before
 * any registration. A value that does not parse (a raw `better` left by an older write, or anything
 * else) is dropped by the store and the default stands; the panel then simply shows in the built-in
 * column, which is also where a first-time reader lands. See {@link preferenceStore} for what happens
 * on a shell that publishes no store at all.
 */
const mountStore = preferenceStore<MountMode>('dsh-hmos-emulator:mount', 'native')
/** Identity of the native tab type; also the key its body registers under. */
const NATIVE_ID = 'dsh-hmos-emulator/panel'
/** The kind `ctx.sidebarRight.openTab` names, and what the guide entry opens. */
const NATIVE_KIND = 'hmosEmulator'
/** The better-sidebar tab id this plugin has always used. */
const BETTER_ID = 'hmos:emulator'

let active: ActiveMount | undefined
let mountView: MountView | undefined
let status: MountStatus = { requested: 'native', effective: 'none', nativeReady: false, betterReady: false, services: { slots: false, tabs: false, better: false }, reason: '' }
const listeners = new Set<() => void>()
/** The service watchers, armed once per mount context; see {@link watchMissingHosts}. */
let hostWatchers: any[] | undefined
/** The context those watchers were armed for, so a different one re-arms. */
let watchedCtx: Ctx | undefined
/**
 * Live native tab bodies, by their own close action.
 *
 * Unregistering the type is not enough to retire a tab that is already open: the record survives,
 * its type is gone, and the right Sidebar draws its "nothing can view this" notice under the chip
 * title captured at open time. A host switch therefore closes those tabs first, while their body
 * is still mounted and can still close itself.
 */
const nativeTabClosers = new Set<() => void>()
/**
 * Live better-sidebar tabs, by the id their body reported, with the seat session each one lives in.
 *
 * The same hazard as the native closers, with two differences: the tab lives in the host's own column,
 * and the only handle that closes it is the id it was opened under, which arrives with the body's props
 * rather than with the registration. The session is kept beside it because that host restarts tab ids
 * per session — its own API says so — and closing by an id alone would look it up in whichever session
 * happens to be current, where the same id names somebody else's tab.
 */
const betterTabs = new Map<string, string>()

/**
 * Let one mounted native tab body be retired by a host switch.
 * @param close - the tab's own close action, from its `useTabInfo().tab.actions`.
 * @returns the release, run when the body unmounts.
 */
export function retainNativeTab(close: () => void): () => void {
  nativeTabClosers.add(close)
  return () => { nativeTabClosers.delete(close) }
}

/** Close every open native tab before its type disappears. */
function closeNativeTabs(): void {
  for (const close of [...nativeTabClosers]) {
    try { close() } catch { /* a tab already closed by the user needs nothing */ }
  }
  nativeTabClosers.clear()
}

/**
 * Remember the id one better-sidebar tab is open under, as its own body reports it, with its session.
 *
 * Only the body knows either: better-sidebar draws these tabs in the host's column and hands the tab's
 * host id and the seat's scope to the component it registered, so both arrive with a render. They are
 * what {@link closeBetterTabs} needs, and they are the only handles the plugin's `closeTab` accepts.
 * @param id - the open tab's id, from the body's props.
 * @param sessionId - the seat session that tab lives in, from the same props.
 */
function retainBetterTab(id: string, sessionId: string): void {
  betterTabs.set(id, sessionId)
}

/**
 * Retire the tab the better-sidebar host still shows, before its type goes away.
 *
 * The counterpart of {@link closeNativeTabs} for the other direction, and the same hazard: a tab whose
 * type is no longer registered cannot be drawn, so the column keeps the chip and shows its "nothing can
 * view this" notice until the user closes the orphan by hand.
 *
 * It closes by the id each tab was actually opened under, captured from the body's own props — never by
 * the type. better-sidebar keys its records by that id and its own API documents that "a tab id is not
 * a type": a close by `hmos:emulator` found no record, fell through to its bottom-workbench path, and
 * left the native tab exactly where it was.
 *
 * The session travels with the id. That host restarts ids per session, so an id on its own resolves
 * against whichever session is current: a tab of ours opened elsewhere would be looked up in the wrong
 * session — either missing (the orphan survives) or matching a same-numbered tab of somebody else's and
 * closing that instead.
 * @param ctx - the client context the better-sidebar service is read from.
 */
function closeBetterTabs(ctx: Ctx): void {
  const better = ctx.get('betterSidebar')
  for (const [id, sessionId] of [...betterTabs]) {
    betterTabs.delete(id)
    if (typeof better?.closeTab !== 'function') continue
    try { better.closeTab(id, { sessionId }) } catch { /* a tab the user already closed needs no second close */ }
  }
}

/**
 * Reveal the panel in the host that just took it.
 *
 * Registering a tab type only makes it available; without this, a flip leaves the panel nowhere
 * visible (the old host's tab is gone and the new host has no open tab), which reads as "the switch
 * did nothing". Called for an explicit switch only — a page load must not open tabs on its own.
 *
 * It runs once the type is registered, never before: the right column's `openTab` throws while its
 * registry has no such kind, and better-sidebar's returns silently — both were swallowed here, which is
 * why a switch used to leave the panel to be opened by hand. The registration callback is the first
 * moment the tab can be asked for, and {@link ActiveMount.reveal} is what carries the intent to it.
 * @param ctx - the client context the host's own open API is read from.
 * @param mode - the host that took the panel.
 */
function openInHost(ctx: Ctx, mode: MountMode): void {
  try {
    if (mode === 'native') {
      const sidebar = ctx.get('sidebarRight')
      if (typeof sidebar?.openTab === 'function') sidebar.openTab(NATIVE_KIND)
      return
    }
    // better-sidebar's own seed: `target` defaults to the right Sidebar, where its registered types
    // (this one included) are drawn as native tabs.
    const better = ctx.get('betterSidebar')
    if (typeof better?.openTab === 'function') better.openTab({ type: BETTER_ID })
  } catch { /* a host that has gone away opens nothing: the tab stays openable by hand */ }
}

/**
 * Reveal the panel at the first moment its tab can be asked for: once this registration landed.
 *
 * The switch records the intent ({@link ActiveMount.reveal}) instead of opening the tab itself, because
 * the mount attempt returns before the registration callback runs — and an open that arrives first is
 * refused (a throw from the right column, a silent return from better-sidebar).
 * @param ctx - the client context.
 * @param record - the registration that just landed.
 * @param mode - the host it landed in.
 */
function revealOnLanding(ctx: Ctx, record: ActiveMount, mode: MountMode): void {
  if (record.reveal !== true) return
  record.reveal = false
  openInHost(ctx, mode)
}
function readMode(): MountMode {
  return mountStore.getSnapshot() === 'better' ? 'better' : 'native'
}

/**
 * Remember the host the user asked for. Exported because writing the request and loading the page are
 * the two halves of the same behaviour: a test that seeds a stored request has to go through the path
 * the product writes with, or it is testing storage rather than this module.
 * @param mode - the host to ask for on this and later loads.
 */
export function writeMode(mode: MountMode): void {
  mountStore.set(mode)
}

/** The switch's current state. */
export function mountStatus(): MountStatus { return status }

/**
 * Watch the switch. The panel subscribes so a refused flip can show its reason.
 * @param listener - called after every status change.
 * @returns the unsubscribe.
 */
export function subscribeMount(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function publish(next: MountStatus): void {
  status = next
  for (const listener of [...listeners]) listener()
}

/**
 * Probe both hosts without touching them. `ctx.get` is a publication check, not a subscription:
 * `inject` below is what waits for a service that appears later.
 * @param ctx - the root client context.
 * @returns whether each host's registration API is live right now.
 */
function probe(ctx: Ctx): { nativeReady: boolean; betterReady: boolean; services: HostServices } {
  const slots = ctx.get('slots')
  const tabs = ctx.get('sidebarRightTabs')
  const better = ctx.get('betterSidebar')
  const services: HostServices = {
    slots: slots !== undefined,
    tabs: typeof tabs?.register === 'function',
    better: typeof better?.registerTab === 'function',
  }
  return {
    nativeReady: services.slots && services.tabs,
    betterReady: services.better,
    services,
  }
}

/** Take ownership of one registration half, which comes back as either a disposer or a fiber. */
function own(record: ActiveMount, value: any): void {
  if (typeof value === 'function') { record.disposers.push(value); return }
  if (value !== undefined && value !== null && typeof value.dispose === 'function') {
    record.disposers.push(() => { value.dispose() })
  }
}

/** Tear one registration down completely, ahead of the next one. */
function release(record: ActiveMount): void {
  record.disposed = true
  for (const dispose of record.disposers.splice(0)) {
    try { dispose() } catch { /* a host that already dropped it needs no second cleanup */ }
  }
  try { record.fiber?.dispose?.() } catch { /* the fiber may have ended with its service */ }
}

/** Collect whatever shape a registration half came back as into one plain disposer. */
function collectInto(halves: (() => void)[], value: any): void {
  if (typeof value === 'function') { halves.push(value); return }
  if (value !== undefined && value !== null && typeof value.dispose === 'function') {
    halves.push(() => { value.dispose() })
  }
}

/**
 * Register the native tab: the type, and the keyed seat that draws its body.
 *
 * Both halves sit inside one effect whose body returns a plain disposer — the shape a shipped tab
 * type uses. An effect may return a function, `null`, a promise, or an iterable; returning an
 * `inject(...)` fiber instead hands Cordis a thenable that settles to an object, which it rejects
 * as an invalid effect and then tears the registration down with.
 */
function registerNative(ctx: Ctx, log: any, record: ActiveMount, view: MountView): void {
  record.fiber = ctx.inject(['sidebarRightTabs', 'slots'], (scoped) => {
    if (record.disposed) return
    const tabs = scoped.get('sidebarRightTabs')
    const slots = scoped.get('slots')
    if (typeof tabs?.register !== 'function' || slots === undefined) {
      log.warn('[dsh-hmos-emulator] 内置右侧栏服务不完整,已跳过标签页注册。')
      return
    }
    own(record, scoped.effect(() => {
      const halves: (() => void)[] = []
      // The type and its body register together, and only once the body seat exists: a type
      // without a body would offer a guide entry that opens a tab nothing can draw.
      const seat = slots.inject('sidebar.right.pane.tab', () => {
        const body = slots.register({ name: 'sidebar.right.pane.tab', key: NATIVE_ID }, (props: any) => {
          const render = (scope: any) => view.view({ scope, ctx })
          return view.nativeBody === undefined
            ? render({ sessionId: props && props.sessionId })
            : view.nativeBody(props, render)
        })
        const type = tabs.register({
          id: NATIVE_ID,
          kind: NATIVE_KIND,
          title: () => '鸿蒙模拟器',
          guide: [{
            id: 'panel',
            order: 55,
            title: () => '鸿蒙模拟器',
            description: () => '启动鸿蒙模拟器并构建部署应用',
            icon: (props: any) => view.icon(props && props.size),
          }],
        })
        return () => {
          if (typeof body === 'function') body()
          if (typeof type === 'function') type()
        }
      })
      collectInto(halves, seat)
      record.settle?.()
      revealOnLanding(ctx, record, 'native')
      return () => {
        for (const dispose of halves.reverse()) {
          try { dispose() } catch { /* the host may have dropped it already */ }
        }
      }
    }, 'dsh-hmos-emulator: native tab type and body'))
  })
}

function registerBetter(ctx: Ctx, log: any, record: ActiveMount, view: MountView): void {
  record.fiber = ctx.inject(['betterSidebar'], (scoped) => {
    if (record.disposed) return
    const better = scoped.get('betterSidebar')
    if (better === undefined || typeof better.registerTab !== 'function') {
      log.warn('[dsh-hmos-emulator] betterSidebar 服务没有 registerTab,已跳过标签页注册。')
      return
    }
    own(record, scoped.effect(() => {
      const tab = better.registerTab({
        id: BETTER_ID,
        title: () => '鸿蒙模拟器',
        icon: (size: any) => view.icon(size),
        order: 55,
        single: true,
        // The panel outlives the injected scope, so it gets the root context: its own service reads
        // must not depend on a fiber that is disposed when better-sidebar reloads.
        component: (props: any) => {
          // The id this tab is open under and the session it lives in, as the host reports them to the
          // body — the handles a later switch closes it by. Captured on render, the only moment they are
          // offered.
          const id = props && props.tab && typeof props.tab.id === 'string' ? props.tab.id : ''
          const seat = props && props.scope && typeof props.scope.sessionId === 'string' ? props.scope.sessionId : ''
          if (id !== '') retainBetterTab(id, seat)
          return view.view({ scope: props && props.scope, ctx })
        },
      })
      record.settle?.()
      revealOnLanding(ctx, record, 'better')
      return () => { if (typeof tab === 'function') tab() }
    }, 'dsh-hmos-emulator: register tab'))
  })
}

/** Which host the persisted request resolves to, given what this page publishes right now. */
function resolveMode(requested: MountMode, ready: { nativeReady: boolean; betterReady: boolean }): MountMode | 'none' {
  if (requested === 'native') return ready.nativeReady ? 'native' : ready.betterReady ? 'better' : 'none'
  return ready.betterReady ? 'better' : ready.nativeReady ? 'native' : 'none'
}

/**
 * Why what is on screen is not what the user asked for.
 *
 * Written, not chatty, and free of mount vocabulary and service names: the reader is looking at a panel
 * that ended up somewhere else, so each sentence states where it is and, in the same breath, why. The
 * only names that appear are the two the user chose between. `none` is only ever reached in the instant
 * before either host publishes — the mount attempt then arms the requested one — so it has one wording.
 */
function reasonFor(requested: MountMode, effective: MountMode | 'none'): string {
  if (effective === requested) return ''
  if (effective === 'none') return '侧边栏尚未就绪,面板将在就绪后自动显示。'
  return requested === 'better'
    ? '未检测到 dsh-better-sidebar,面板继续显示在内置右侧栏。'
    : '内置右侧栏不可用,面板已切换到 dsh-better-sidebar。'
}

/**
 * What to say when the requested host was absent at mount and has arrived since: the panel stays where
 * it landed (moving a panel the user may be reading would be worse), so the line has to say that the
 * choice is now available rather than that it was refused.
 * @param requested - the host the user asked for and is not on screen.
 * @returns the sentence for the row under the capsule.
 */
function reasonLateReady(requested: MountMode): string {
  return `${requested === 'native' ? '内置右侧栏' : 'dsh-better-sidebar'}已就绪,现在可切换。`
}

/**
 * Follow the services this page has not published yet, so a half that is unavailable at load stops
 * being greyed the moment its service arrives.
 *
 * The probe is a snapshot, and a mount attempt only publishes two of them (at the attempt and when the
 * registration lands). A shell that publishes the right column's services later than that — a newer
 * release. A page whose hosts are both up on arrival arms nothing, and the fibers that are armed live
 * as long as the client half does.
 * @param ctx - the root client context.
 * @param ready - what the mount attempt found, so only the absent services are followed.
 */
function watchMissingHosts(ctx: Ctx, ready: { nativeReady: boolean; betterReady: boolean }): void {
  // Keyed by the context: the watchers belong to the context the panel was mounted in, so a second
  // mount attempt with a different one re-arms instead of following a context nobody uses.
  if (watchedCtx === ctx) return
  for (const fiber of hostWatchers ?? []) {
    try { fiber?.dispose?.() } catch { /* a fiber that ended with its service needs no disposal */ }
  }
  watchedCtx = ctx
  const missing = [
    // The native host needs both: the tab registry and the slot service its body seat registers in.
    ...(ready.nativeReady ? [] : ['slots', 'sidebarRightTabs']),
    ...(ready.betterReady ? [] : ['betterSidebar']),
  ]
  if (missing.length === 0) {
    hostWatchers = []
    return
  }
  hostWatchers = missing.map((name) => ctx.inject([name], () => {
    const now = probe(ctx)
    const requested = readMode()
    const requestedReady = requested === 'native' ? now.nativeReady : now.betterReady
    const otherReady = requested === 'native' ? now.betterReady : now.nativeReady
    // A mount attempt that ran before either service published committed to the requested host and armed
    // its registration (see `pending` in `applyMount`). If that host never arrives while the other one
    // does, the panel is registered nowhere and shown nowhere: re-resolve now, so it lands where it can
    // live. The request stays stored, and the row then says why it is not on the requested host.
    if (active !== undefined && mountView !== undefined && active.mode === requested && !requestedReady && otherReady) {
      applyMount(ctx, mountView)
      return
    }
    const mode = active?.mode ?? 'none'
    publish({
      requested,
      effective: mode,
      nativeReady: now.nativeReady,
      betterReady: now.betterReady,
      services: now.services,
      // The requested host may have arrived since the fallback: say it is available rather than that it
      // was refused, and leave the panel where the user is reading it.
      reason: mode === 'none' || mode === requested
        ? reasonFor(requested, mode)
        : reasonLateReady(requested),
    })
  }))
}

/**
 * Resolve the persisted request against what this host publishes, and register exactly one host.
 * @param ctx - the root client context, also handed to the panel so its reads outlive our fibers.
 * @param view - the panel component and glyph to mount in whichever host wins.
 * @param reveal - whether the host that wins should open the panel, which only an explicit switch asks
 * for: a page load must not open tabs on its own.
 * @returns the status the switch renders.
 */
export function applyMount(ctx: Ctx, view: MountView, reveal = false): MountStatus {
  mountView = view
  const log = clientLoggerOf(ctx)
  const requested = readMode()
  const ready = probe(ctx)
  const resolved = resolveMode(requested, ready)
  // Neither host is published yet: that is how a page looks in the instant between this bundle
  // loading and the sidebar's own services publishing, so the requested host is still armed — its
  // `inject` waits, and the landing registration settles this status.
  const pending = resolved === 'none'
  const mode = pending ? requested : resolved
  // One transport only: the previous registration is gone before the next one exists. The tab the
  // retiring host still shows is closed first — unregistering its type would leave the chip in the
  // strip with no body able to draw it, whichever host is doing the retiring.
  const previous = active
  active = undefined
  if (previous !== undefined) {
    if (previous.mode === 'native') closeNativeTabs()
    else closeBetterTabs(ctx)
    release(previous)
  }
  // The reveal waits for this registration: the record carries the intent into the callback that
  // registers the tab, which is the first moment the host can be asked for it.
  const record: ActiveMount = { mode, fiber: undefined, disposers: [], disposed: false, reveal }
  record.settle = () => {
    if (record.disposed) return
    const now = probe(ctx)
    publish({ requested: readMode(), effective: record.mode, nativeReady: now.nativeReady, betterReady: now.betterReady, services: now.services, reason: '' })
  }
  active = record
  if (mode === 'native') registerNative(ctx, log, record, view)
  else registerBetter(ctx, log, record, view)
  watchMissingHosts(ctx, ready)
  const next: MountStatus = {
    requested,
    effective: resolved,
    nativeReady: ready.nativeReady,
    betterReady: ready.betterReady,
    services: ready.services,
    reason: reasonFor(requested, resolved),
  }
  publish(next)
  return next
}

/**
 * Move the panel to the other host. A host this deployment cannot provide refuses the flip and
 * leaves the preference alone, so the switch springs back with a reason instead of persisting a
 * choice that would strand the panel.
 * @param ctx - the root client context.
 * @param mode - the host the user asked for.
 * @returns whether the flip was accepted, and the reason when it was not.
 */
export function switchMount(ctx: Ctx, mode: MountMode): { ok: boolean; reason: string } {
  if (mountView === undefined) return { ok: false, reason: '面板尚未初始化,暂时无法切换挂载方式。' }
  const ready = probe(ctx)
  if (!(mode === 'native' ? ready.nativeReady : ready.betterReady)) {
    const reason = mode === 'better'
      ? '未检测到 dsh-better-sidebar(或它已被停用),面板继续使用内置右侧栏。'
      : '内置右侧栏不可用,面板继续使用 dsh-better-sidebar。'
    publish({ ...mountStatus(), ...ready, reason })
    return { ok: false, reason }
  }
  writeMode(mode)
  // The flip is only visible once the panel is on screen in the new host, and that open happens in the
  // host's own registration callback — asking for it here would race the registration and be refused.
  const next = applyMount(ctx, mountView, true)
  return { ok: true, reason: next.reason }
}
