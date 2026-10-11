/**
 * The `shell.overlay` entry that shows one version check's result.
 *
 * The banner itself is the host's shared `Toast` from `@deepseek-ai/dsh-client-ui-primitives`, which
 * the shell resolves for us — the same way `react` arrives — so this entry owns no position, no
 * scrim and no fade. Official plugins report their transient outcomes exactly this way (ui-schedule's
 * deletion notice, ui-plugin-manager's refresh notice), which is why the source carries a sequence:
 * the `key` restarts the banner when the same sentence is shown twice.
 */
import type { HostObservable, NoticeState } from './notice.js'

const { createElement: h, useEffect } = require('react')

/**
 * How long a notice that needs an action is held. The host's banner takes one hold value and drives
 * both its unmount timer and its stylesheet's fade delay, so this is "long enough to be standing":
 * the next check replaces it, the install or `关闭` retires it, a click elsewhere retires it, and
 * closing the panel drops it.
 */
const PERSIST_MS = 24 * 60 * 60 * 1000

/**
 * The host's banner marks its surface `role="alert"`, and a standing notice's own actions live inside
 * it: a click that lands in any such surface is the banner being used, not the user moving on.
 */
const BANNER_SELECTOR = '[role="alert"]'

/** What the seat is registered with: the observables, its dismissal, and the action runner. */
export interface CheckNoticeInjected {
  readonly hooks: {
    readonly notice: HostObservable<NoticeState | null>
    readonly anchor: HostObservable<HTMLElement | null>
  }
  readonly dismiss: () => void
  readonly runAction: () => void
}

/**
 * Props the seat renders with. The runtime turns each `hooks` entry into a `use<Name>` hook, which is
 * why this is not the object the registration injects.
 */
export interface CheckNoticeProps {
  readonly useNotice: (select: (current: NoticeState | null) => NoticeState | null) => NoticeState | null
  readonly useAnchor: (select: (current: HTMLElement | null) => HTMLElement | null) => HTMLElement | null
  readonly dismiss: () => void
  readonly runAction: () => void
}

/** The host's banner, as this plugin uses it; the shell provides the real component. */
interface HostToastProps {
  readonly key?: string
  readonly text: string
  readonly icon?: unknown
  readonly tone?: 'success'
  /** The element whose horizontal center the banner follows; null centers it on the window. */
  readonly anchor?: HTMLElement | null
  /** Full-opacity hold before the fade; the host's own default applies when omitted. */
  readonly holdMs?: number
  readonly actions?: readonly { readonly label: string; readonly prefix?: string; readonly onClick: () => void }[]
  readonly onDone: () => void
}

/** The host's banner module, as this plugin uses it. */
interface HostBanner {
  readonly Toast: (props: HostToastProps) => unknown
  readonly IconWarningOutlineRegular: unknown
}

/**
 * Resolve the host's banner module, lazily and defensively.
 *
 * A module-scope `require` here would run while the client bundle is being evaluated — before
 * `apply`'s try/catch — so a host whose module table lacks these primitives would lose the whole
 * client half (the panel included) rather than just this banner. Asking at render time keeps the
 * failure to what it costs: no banner, everything else intact.
 * @returns the banner module, or null when this host does not publish it.
 */
function hostBanner(): HostBanner | null {
  try {
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives') as Partial<HostBanner> | undefined
    return typeof primitives?.Toast === 'function' ? primitives as HostBanner : null
  } catch {
    return null
  }
}

/**
 * Render the current notice as the shell's banner: the success treatment for a check that found the
 * installed build, the warning glyph for one that could not complete, and the install as the
 * sentence's own continuation. The banner stays where the shell puts it (fixed near the window top);
 * the anchor only moves it sideways, onto the panel that asked.
 *
 * A notice the user has to act on is held open (`holdMs`), and a click outside it retires it: the
 * host's banner fades on its own after a few seconds and offers no close button, so a standing notice
 * needs its own way out. It carries only the action that matters (the install); dismissing it is the
 * click elsewhere, the same gesture that closes a popover. An informational notice keeps the host's
 * default fade.
 * @param props - the injected face; `useNotice` and `useAnchor` are the seat's observable hooks.
 * @returns the banner, or null while there is nothing to report.
 */
export function CheckNoticeToast({ useNotice, useAnchor, dismiss, runAction }: CheckNoticeProps): unknown {
  const notice = useNotice((current) => current)
  const anchor = useAnchor((current) => current)
  const held = notice !== null && notice.persist === true
  // A standing banner has no close button of its own — the host's surface is click-through — so a
  // click anywhere outside it retires it, the way a popover is dismissed. A click inside is the
  // banner being used (its own action) and must not dismiss it first.
  //
  // Bubble phase on purpose: React listens on its root container, so the banner's own action has
  // already run by the time this fires. In the capture phase a selector that stopped matching — the
  // host renamed the surface, say — would dismiss the banner out from under the pointer and swallow
  // the press; here the worst case is one extra click.
  useEffect(() => {
    if (!held) return
    const onPointerDown = (event: Event): void => {
      const target = event.target
      if (target instanceof Element && target.closest(BANNER_SELECTOR) !== null) return
      dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [held, dismiss])
  const banner = hostBanner()
  if (notice === null || banner === null) return null
  // The action is labelled like a button and stands on its own; a connective only travels with it
  // when the sentence continues into it (the official "…，可 撤销 或 …" shape).
  const actions = notice.action === undefined
    ? []
    : [{
        ...(notice.action.prefix === undefined ? {} : { prefix: notice.action.prefix }),
        label: notice.action.label,
        onClick: runAction,
      }]
  return h(banner.Toast, {
    key: `hmos-check-${String(notice.seq)}`,
    text: notice.text,
    anchor,
    ...(notice.persist === true ? { holdMs: PERSIST_MS } : {}),
    ...(notice.tone === 'success' ? { tone: 'success' as const } : {}),
    ...(notice.tone === 'warning' ? { icon: h(banner.IconWarningOutlineRegular, null) } : {}),
    ...(actions.length === 0 ? {} : { actions }),
    onDone: dismiss,
  })
}
