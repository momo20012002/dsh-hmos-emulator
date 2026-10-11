import { Ctx } from './ctx.js'
import { IC } from './icons.js'
import { Icon } from './components.js'
import { Panel } from './panel.js'
import { applyMount, retainNativeTab } from './mount.js'
import { notices } from './notice.js'
import { CheckNoticeToast } from './notice-toast.js'
import type { CheckNoticeInjected } from './notice-toast.js'
import { clientLoggerOf } from './log.js'
const { createElement: h, useEffect } = require('react')

function apply(ctx: Ctx) {
  const log = clientLoggerOf(ctx)
  // Isolation: never throw from client apply; log only, so the DSH client loader is unaffected.
  try {
    // The version check's answer is a transient result, so it is reported through the shell's own
    // overlay seat and banner rather than a popover this plugin would have to place and dismiss.
    // Registered on its own effect: it belongs to the shell, not to whichever host mounts the panel.
    ctx.inject(['slots'], (scoped) => {
      const slots = scoped.get('slots')
      if (slots === undefined || typeof slots.inject !== 'function') return
      const seat = slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'hmos-emulator.check-notice',
        inject: (): CheckNoticeInjected => ({
          hooks: { notice: notices.hooks.notice, anchor: notices.hooks.anchor },
          dismiss: notices.dismiss,
          runAction: notices.requestAction,
        }),
      }, CheckNoticeToast))
      // A plain disposer, never the inject fiber itself: Cordis rejects a thenable effect and tears
      // the registration down with it.
      return () => {
        if (typeof seat === 'function') seat()
        else if (seat !== null && typeof seat === 'object' && typeof seat.dispose === 'function') seat.dispose()
      }
    })
    // The panel's host is a user preference: DSH's native right Sidebar by default, or the
    // optional dsh-better-sidebar workbench when the switch is on. Exactly one is ever registered,
    // and a host this deployment cannot provide is reported rather than half-mounted.
    applyMount(ctx, {
      view: Panel,
      icon: (size) => h(Icon, { src: IC.emulator, size: size || 16 }),
      // Only a tab's own body can close it, so the body lends its close action to the mount module:
      // moving the panel to better-sidebar retires the open native tab instead of orphaning its
      // chip on the right Sidebar's "nothing can view this" notice.
      nativeBody: (props, render) => {
        const useTabInfo = props && props.useTabInfo
        const close = typeof useTabInfo === 'function' ? useTabInfo().tab.actions.close : undefined
        useEffect(() => (typeof close === 'function' ? retainNativeTab(close) : undefined), [close])
        return render({ sessionId: props && props.sessionId })
      },
    })
  } catch (error) {
    log.error('[dsh-hmos-emulator] 客户端注册异常(已隔离,不影响 DSH):', error)
  }
}
module.exports = { apply }
