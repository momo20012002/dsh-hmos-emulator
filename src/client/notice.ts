/**
 * The version check's answer, as the shell's own transient banner shows it.
 *
 * This module owns the wording and the state, never a position or a lifetime: the banner is the
 * host's shared `Toast`, registered through its `shell.overlay` seat, so a result that needs no
 * decision disappears on its own instead of opening something the user has to close. Everything here
 * is React-free, so the mapping and the store can be asserted without a renderer.
 */

/** One notice: the sentence, the design treatment, and the action it offers. */
export interface CheckNotice {
  /** The banner's sentence, localized here because this plugin ships one language. */
  readonly text: string
  /** `success` takes the design's circled check; `warning` takes the host's warning glyph. */
  readonly tone?: 'success' | 'warning'
  /**
   * The action, labelled as a button is: a verb phrase standing on its own. `prefix` is the host's
   * seat for whatever sits between sentence and label — a connective when the sentence continues into
   * it, or the separating space when it does not.
   */
  readonly action?: { readonly prefix?: string; readonly label: string }
  /**
   * Hold the banner instead of letting it fade: a notice the user has to act on must not disappear
   * before they can. The banner then also offers a way to close it, because the host's banner has no
   * close button of its own.
   */
  readonly persist?: boolean
}

/** The observable the overlay entry subscribes to. */
export interface HostObservable<T> {
  readonly getSnapshot: () => T
  readonly subscribe: (listener: () => void) => () => void
}

/** The notice on screen, keyed so showing the same sentence again restarts its fade. */
export interface NoticeState extends CheckNotice {
  readonly seq: number
  /** The channel this check asked about: what the sentence names and what the action must install. */
  readonly channel: string
  /**
   * What the banner's action does when the notice brought its own — undoing a mount switch, say —
   * rather than the install a version check offers.
   */
  readonly onAction?: () => void
}

/** What the panel publishes into and the overlay entry reads from. */
export interface NoticeSource {
  readonly hooks: {
    readonly notice: HostObservable<NoticeState | null>
    /** The element the banner's horizontal center follows, or null for the whole window. */
    readonly anchor: HostObservable<HTMLElement | null>
  }
  /** Show what one version check found. */
  readonly show: (plan: unknown) => void
  /** Show a check that never reached the host (a refused route, an offline host). */
  readonly fail: (reason: unknown) => void
  /**
   * Show a notice this panel composed itself, with the action it carries.
   *
   * The result of a mount switch has no plan behind it — the sentence is the panel's own — and its
   * action is the undo, so the handler travels with the notice.
   * @param notice - the sentence, treatment and action label to show.
   * @param onAction - what the action does; omitted, the banner offers no action.
   */
  readonly say: (notice: CheckNotice, onAction?: () => void) => void
  /** Clear the banner; also the banner's own `onDone`. */
  readonly dismiss: () => void
  /**
   * Run what the banner's action offers, and retire the banner: the notice's own handler when it
   * brought one, else the install for the channel the sentence named.
   *
   * The channel travels with the notice, not from the panel's current setting: a standing banner can
   * outlive a change of channel, and the button must install what the sentence said.
   */
  readonly requestAction: () => void
  /**
   * Keep the install run current. The panel owns it (it holds the request and the busy state) and
   * re-registers after every render, because the banner outlives the render that raised it.
   * @param run - the run to invoke with the channel the notice named, or null while no panel is up.
   */
  readonly setInstallRunner: (run: ((channel: string) => void) | null) => void
  /**
   * Publish the element the banner should center over: the panel that asked for the check, so the
   * answer lands on that column instead of the middle of the window. The vertical position stays the
   * host's (the banner is fixed near the window top) — this only moves it sideways.
   * @param element - the panel's root node, or null once it goes away.
   */
  readonly setAnchor: (element: HTMLElement | null) => void
  /**
   * Claim the store for one panel instance. Both hosts can hold a panel for a moment during a switch,
   * and a retiring panel's cleanup must not clear what the arriving one published.
   * @param owner - the caller's instance token.
   */
  readonly own: (owner: object) => void
  /**
   * Give the store back: clears the runner, the anchor and the banner, but only while `owner` still
   * holds it, so a stale unmount cannot retire a live panel's notice.
   * @param owner - the caller's instance token, as passed to {@link NoticeSource.own}.
   */
  readonly release: (owner: object) => void
}

/** Which channel a plan named, as the sentence names it. */
function channelOf(plan: unknown): string {
  const channel = planChannel(plan)
  return channel === '' ? '该通道' : `${channel} 通道`
}

/** The bare channel a plan named, for the sentence and for the install it offers. */
function planChannel(plan: unknown): string {
  const value = (plan || {}) as { channel?: unknown }
  return typeof value.channel === 'string' ? value.channel : ''
}

/**
 * What sits between the sentence and its label. The host's banner gives the action only a 3px inline
 * margin, which leaves the label crowding the closing bracket, and its `prefix` seat is exactly the
 * place for what goes between the two — so the separator travels there rather than as a trailing
 * space on the sentence. Exported because notices this panel composes itself need the same separator.
 */
export const ACTION_PREFIX = ' '

/**
 * What one version check should say.
 *
 * It reports what the check found — the build the channel points at and the one in place — and
 * offers the install only when there is something to install. An answer the host could not get is
 * stated as such, with the install still offered: "could not check" is not "already current".
 * @param plan - the host's `deveco.plan` answer.
 * @returns the notice to show.
 */
export function checkNotice(plan: unknown): CheckNotice {
  const value = (plan || {}) as { target?: unknown; installed?: unknown; checked?: unknown }
  const where = channelOf(plan)
  const installed = typeof value.installed === 'string' ? value.installed : ''
  if (value.checked !== true || typeof value.target !== 'string' || value.target === '') {
    // The check failed, so the label stays bare: the button says what it does, not how new it is.
    return {
      text: `无法查询 ${where}的最新版本(可能离线或源不可用)`,
      tone: 'warning',
      action: { prefix: ACTION_PREFIX, label: '更新' },
      persist: true,
    }
  }
  if (installed !== '' && installed === value.target) {
    return { text: `${where}已是最新版本(${value.target})`, tone: 'success' }
  }
  return {
    // "The channel's newest build", not "a newer build": the channel can sit behind what is installed
    // (stable pointed at 1.3.0-stable while 1.3.4 was in place), and only the first phrasing is true
    // in both directions. No closing period either — the brackets end the sentence.
    text: `${where}最新版本 ${value.target}(当前 ${installed === '' ? '版本未知' : installed})`,
    action: { prefix: ACTION_PREFIX, label: '立即更新' },
    persist: true,
  }
}

/**
 * Create the notice store: one snapshot, one listener set, one anchor element, and one install run
 * kept current by whichever panel owns the store.
 * @returns the source the panel publishes into and the overlay entry reads from.
 */
export function createNoticeSource(): NoticeSource {
  let state: NoticeState | null = null
  let seq = 0
  let install: ((channel: string) => void) | null = null
  let anchor: HTMLElement | null = null
  let owner: object | null = null
  const listeners = new Set<() => void>()
  const anchorListeners = new Set<() => void>()
  const publish = (notice: CheckNotice | null, channel = '', onAction?: () => void): void => {
    state = notice === null
      ? null
      : { ...notice, seq: ++seq, channel, ...(onAction === undefined ? {} : { onAction }) }
    for (const listener of listeners) listener()
  }
  const clearAnchor = (): void => {
    if (anchor === null) return
    anchor = null
    for (const listener of anchorListeners) listener()
  }
  return {
    hooks: {
      notice: {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
      anchor: {
        getSnapshot: () => anchor,
        subscribe(listener) {
          anchorListeners.add(listener)
          return () => { anchorListeners.delete(listener) }
        },
      },
    },
    show: (plan) => { publish(checkNotice(plan), planChannel(plan)) },
    fail: (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason)
      publish({ text: `无法确认版本:${message}`, tone: 'warning' })
    },
    say: (notice, onAction) => { publish(notice, '', onAction) },
    dismiss: () => { publish(null) },
    requestAction: () => {
      const action = state?.onAction
      const channel = state?.channel ?? ''
      const run = install
      publish(null)
      if (action !== undefined) { action(); return }
      run?.(channel)
    },
    setInstallRunner: (run) => { install = run },
    setAnchor: (element) => {
      // The panel re-publishes after every render, so an unchanged node must not notify: a new
      // snapshot identity would remount the banner and restart its fade.
      if (anchor === element) return
      anchor = element
      for (const listener of anchorListeners) listener()
    },
    own: (token) => { owner = token },
    release: (token) => {
      // Only the panel that still holds the store may clear it: during a host switch the retiring
      // panel's cleanup can land after the arriving panel published its own runner and anchor.
      if (owner !== token) return
      owner = null
      install = null
      clearAnchor()
      publish(null)
    },
  }
}

/**
 * The one notice source of this client half: the panel publishes into it and the overlay entry reads
 * from it, and both halves ship in the same bundle.
 */
export const notices: NoticeSource = createNoticeSource()
