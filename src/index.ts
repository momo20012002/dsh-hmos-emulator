import { API_PREFIX, createApiRoute } from './http.js'
import { hostService, isolate } from './services.js'
import { createApi, lintDeliveries, lintNotice, lintNoticeSession, markLintDelivered } from './api.js'
import { createToolDefs } from './tools/index.js'
import { loggerOf } from './log.js'
/**
 * dsh-hmos-emulator — host half.
 *
 * Turns better-sidebar tab actions into real local work: toolchain discovery,
 * emulator start/stop, device listing, project browsing, build+deploy, screenshots,
 * and one compact set of model tools (emu, emu_ui, hmos_deploy, hmos_log, hmos_docs) so an
 * agent can drive the emulator, deploy, read logs and consult the DevEco docs directly.
 *
 * The client calls this module over same-origin HTTP JSON (prefix /dsh-hmos-emulator/api)
 * with the envelope { ok: true, value } / { ok: false, error: { code, message } }.
 *
 * Imports no cordis/dsh runtime package: only the ctx API and Node builtins, so it shares
 * the host runtime instance and can mount in any host context.
 */

// This module defines the bundle's public surface: keep re-exporting what tests and callers import.
export { capLines, diffLines, sliceText } from './text.js'
export { cropPng, decodePng, diffPng, encodePng } from './png.js'
export type { DecodedPng } from './png.js'
export { deployPhase, pageMissingHint, parseBuildErrors, parseLogLines, stripAnsi } from './parsers/devecocli.js'
export type { BuildError, LogLine } from './parsers/devecocli.js'
export { fixStats, lintOutcome, parseLintTable } from './parsers/lint.js'
export type { LintFinding, LintSummary } from './parsers/lint.js'
export { ancestorLabels, labelMatches, layoutJson, nodeLabel, pageTitle, parseLayoutLine } from './parsers/layout.js'
export type { LabelMatch, LayoutLine } from './parsers/layout.js'
export { fenceAuthorities, isTrustedRequest } from './http.js'
export { stepSummary } from './tools/emu-ui.js'
export { cliFromWrapper, devecoCliHint } from './toolchain.js'
export { sessionWorkspace } from './workspace.js'
export { changedCodeFiles, lintScope, untrackedCodeFiles } from './git.js'
export { AUTO_SHOT_PREFIX, SHOT_KEEP, TOOL_SHOT_PREFIX, attachmentRefForImage, pruneAutoShots, pruneToolShots } from './shots.js'

/** Minimal cordis context: only the members used here, avoiding the full DSH type graph. */
/** The Cordis core logger handle a context carries; present at runtime, optional here. */
export interface CtxLogger { error(...args: any[]): void; warn(...args: any[]): void }

export interface Ctx {
  get(name: string): any
  effect(callback: () => any, label?: string): void
  /** Run `callback` in a fiber that lives only while every named service is published. */
  inject(names: string[], callback: (scoped: Ctx) => void): void
  logger?: CtxLogger
}

export const name = 'dsh-hmos-emulator'

// Do NOT declare `inject: ['webServer']` here: the loader would treat webServer as a hard
// dependency and abort the whole composition load (this once left other host plugins such as
// dsh-mneme unmounted). Registration below polls for readiness instead, which never blocks.

/**
 * Tool names this process already registered, keyed by the registry instance: a live patch reload
 * reuses that object, and a second registration of a name already held would throw and strand every
 * tool after it.
 */
const toolNamesByRegistry = new WeakMap<object, Set<string>>()

function ownedToolNames(registry: object): Set<string> {
  let names = toolNamesByRegistry.get(registry)
  if (names === undefined) {
    names = new Set()
    toolNamesByRegistry.set(registry, names)
  }
  return names
}


export function apply(ctx: Ctx, _config?: any) {
  const log = loggerOf(ctx)
  // Isolation: never throw from host apply; log only, so the DSH composition keeps loading.
  try {
    const api = createApi()
    // Each registration below is scoped to a fiber that lives exactly while its service is
    // published: a service replaced by a live patch re-registers instead of leaving a dead route, a
    // missing tool or a silent prompt hook behind. A module-level `inject` would instead abort the
    // whole composition load when the service is absent, which is why nothing here declares one.
    ctx.inject(['webServer'], (scoped) => isolate('宿主路由', scoped, () => {
      const ws = hostService(scoped, 'webServer')
      if (typeof ws?.register !== 'function') {
        log.warn('[dsh-hmos-emulator] webServer 没有 register,已跳过路由注册。')
        return
      }
      scoped.effect(() => ws.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: createApiRoute({ api, ctx, host: ws.host }),
      }), 'dsh-hmos-emulator: http api')
    }))
    const defs = createToolDefs(api, ctx)
    ctx.inject(['tools'], (scoped) => isolate('Model Tool ', scoped, () => {
      const tools = hostService(scoped, 'tools')
      if (typeof tools?.register !== 'function') {
        log.warn('[dsh-hmos-emulator] tools 没有 register,已跳过工具注册。')
        return
      }
      const names = ownedToolNames(tools)
      const disposers = []
      for (const def of defs) {
        // Skip what this process already holds in that registry, and keep the remaining tools
        // coming when one name is taken instead of stranding every tool after it.
        if (names.has(def.name)) continue
        try {
          const disposer = tools.register(def)
          names.add(def.name)
          disposers.push(disposer)
        } catch (error) {
          log.error('[dsh-hmos-emulator] 工具 ' + def.name + ' 注册失败(其余继续):', error)
        }
      }
      scoped.effect(() => () => {
        for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* ignore */ } }
      }, 'dsh-hmos-emulator: model tools')
    }))
    // Runtime-context provider: hands the latest code-check result to the model on its next
    // prompt assembly, so the user never has to copy it out of the panel. The text function is
    // evaluated per assembly.
    ctx.inject(['systemPrompt'], (scoped) => isolate('检查结果上下文', scoped, () => {
      const sp = hostService(scoped, 'systemPrompt')
      if (typeof sp?.context !== 'function') {
        log.warn('[dsh-hmos-emulator] systemPrompt 没有 context,已跳过检查结果上下文注册。')
        return
      }
      scoped.effect(() => sp.context({
        name: 'hmos-emulator-code-check',
        order: 990,
        text: (assemble) => {
          if (!lintNotice || lintDeliveries >= 1) return ''
          // assemble.scope is the asking session Agent object, and ctx.agents.get(id) hands
          // back that same object, so identity is the exact test. Only filter when the owner can
          // actually be identified: an older client sends no session id, and a host without the
          // agents service must keep delivering instead of stranding the notice forever.
          const agents = hostService(ctx, 'agents')
          if (lintNoticeSession && agents && typeof agents.get === 'function') {
            const owner = agents.get(lintNoticeSession)
            if (owner !== undefined && assemble?.scope !== owner) return ''
          }
          markLintDelivered()
          return lintNotice
        },
      }), 'dsh-hmos-emulator: code-check context')
    }))
  } catch (error) {
    log.error('[dsh-hmos-emulator] 宿主 apply 异常(已隔离,不影响 DSH 启动):', error)
  }
}