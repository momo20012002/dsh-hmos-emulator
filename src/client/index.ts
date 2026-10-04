import { Ctx } from './ctx.js'
import { IC } from './icons.js'
import { Icon } from './components.js'
import { Panel } from './panel.js'
import { clientLoggerOf } from './log.js'
const { createElement: h } = require('react')

function apply(ctx: Ctx) {
  const log = clientLoggerOf(ctx)
  // Isolation: never throw from client apply; log only, so the DSH client loader is unaffected.
  try {
    // The sidebar service is an optional capability, never a hard dependency: a host without it must
    // still load this bundle. `inject` scopes the registration to a fiber that lives exactly while
    // the service does, so a live reload of better-sidebar re-registers the tab — the one-shot
    // registration this replaced would have left the panel gone for the rest of the session.
    ctx.inject(['betterSidebar'], (scoped) => {
      const better = scoped.get('betterSidebar')
      if (better === undefined || typeof better.registerTab !== 'function') {
        log.warn('[dsh-hmos-emulator] betterSidebar 服务没有 registerTab,已跳过页签注册。')
        return
      }
      scoped.effect(() => better.registerTab({
        id: 'hmos:emulator',
        title: () => '鸿蒙模拟器',
        icon: (size) => h(Icon, { src: IC.emulator, size: size || 16 }),
        order: 55,
        single: true,
        // The panel outlives the injected scope, so it gets the root context: its own service reads
        // must not depend on a fiber that is disposed when better-sidebar reloads.
        component: (props) => h(Panel, { scope: props.scope, ctx }),
      }), 'dsh-hmos-emulator: register tab')
    })
  } catch (error) {
    log.error('[dsh-hmos-emulator] 客户端注册异常(已隔离,不影响 DSH):', error)
  }
}
module.exports = { apply };
