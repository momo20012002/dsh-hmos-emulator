import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { capLines, diffLines, tailText } from '../text.js'
import { cropPng, decodePng, diffPng, encodePng } from '../png.js'
import { abortedError, firstRunningSerial, resolveDevecoCli, runCli, throwIfAborted } from '../toolchain.js'
import { LayoutLine, ancestorLabels, candidateList, cleanLayout, labelMatches, layoutJson, matchLayout, pageTitle, parseLayoutLine, pointOf, rawKeys, renderLayout, renderLines, selectLayoutLines } from '../parsers/layout.js'
import { relativeTo, sessionWorkspace } from '../workspace.js'
import { TOOL_OUT_SCHEMA, attachmentRefForImage, shotFields, toolRender } from '../shots.js'
import { DEVICE_SERIAL } from './schema.js'
import type { ToolDeps } from './deps.js'
/** Screen driving: layout queries, taps, gestures, waits, batched steps and screenshots. */

export function makeEmuUi(deps: ToolDeps) {
  const { api, ctx, lastLayout, lastRender, lastDump, lastShot, hmosLog } = deps
  return {
      name: 'emu_ui',
      description: 'Drive the emulator screen via devecocli ui. layout: tree lines (#id Type [x1,y1,x2,y2] "text" flags) + page title (window/allWindows reach system and UIExtension windows); click/longPress/doubleTap by label, id or x/y (results carry an ancestors breadcrumb, and matchCount/candidates when a label is ambiguous); waitFor/waitForChange/waitForIdle instead of sleeping; steps batches actions; drag/fling/dircfling/swipe/text/screenshot. Screenshots are static frames only; pinch/zoom (multi-finger) is unsupported.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['layout', 'observe', 'click', 'text', 'swipe', 'screenshot', 'waitFor', 'waitForChange', 'waitForIdle', 'longPress', 'doubleTap', 'drag', 'fling', 'dircfling', 'steps'], description: 'UI action' },
          steps: { type: 'array', items: { type: 'object' }, description: 'steps: [{action,...}] in order (see onFail)' },
          onFail: { type: 'string', enum: ['stop', 'continue'], description: 'steps: stop (default, returns stoppedAt) | continue (runs all, returns failedAt)' },
          changedOnly: { type: 'boolean', description: 'layout/thenLayout: only changed lines vs the previous render' },
          device: DEVICE_SERIAL,
          id: { type: 'integer', description: 'press: node id from the last layout' },
          label: { type: 'string', description: 'press: node text; exact first, else smallest clickable ancestor' },
          labelIndex: { type: 'integer', description: 'press: candidate index when label repeats (see matchCount)' },
          depth: { type: 'integer', description: 'layout/waitFor: depth (0=unlimited, 1=root)' },
          filter: { type: 'object', description: 'layout/thenLayout: node filter', properties: { type: { type: 'string' }, textRegex: { type: 'string' }, clickableOnly: { type: 'boolean' } } },
          full: { type: 'boolean', description: 'layout: include unlabeled/inert nodes (--mode full)' },
          asJson: { type: 'boolean', description: 'layout: flat JSON nodes (label: inherited text)' },
          window: { type: 'integer', description: 'layout: window id from `devecocli ui window list`' },
          allWindows: { type: 'boolean', description: 'layout: every window incl. system/UIExtension ones (--all-windows; for pickers, permission dialogs)' },
          textRegex: { type: 'string', description: 'waitFor: JS regex on node text' },
          clickableOnly: { type: 'boolean', description: 'waitFor: clickable only' },
          absent: { type: 'boolean', description: 'waitFor: succeed when the match is gone instead of present' },
          timeoutMs: { type: 'integer', description: 'wait: total ms (5000); one dump (1.5-3s) cannot be interrupted, so elapsed may exceed it by one dump' },
          pollMs: { type: 'integer', description: 'wait: poll ms (200)' },
          stablePolls: { type: 'integer', description: 'waitForIdle: stable dumps (2)' },
          thenLayout: { type: 'boolean', description: 'click: layout after the tap (honours filter/changedOnly)' },
          thenWaitFor: {
            type: 'object',
            additionalProperties: true,
            description: 'click: wait for this condition after the tap, then dump (same fields as waitFor; replaces the fixed waitMs guess)',
          },
          waitMs: { type: 'integer', description: 'thenLayout ms (600, max 5000); thenWaitFor timeout floor' },
          x: { type: 'integer', description: 'press/swipe/drag: start x' },
          y: { type: 'integer', description: 'press/swipe/drag: start y' },
          x2: { type: 'integer', description: 'swipe/drag: end x' },
          y2: { type: 'integer', description: 'swipe/drag: end y' },
          velocity: { type: 'integer', description: 'drag/swipe/fling: px/s; drag defaults to 400 (a speedless drag can be a silent no-op)' },
          direction: { type: 'string', description: 'dircfling: left|right|up|down' },
          text: { type: 'string', description: 'text: string to type, or the waitFor match' },
          root: { type: 'string', description: 'screenshot: dir for the PNG (default: workspace)' },
          baseline: { type: 'string', description: 'screenshot: PNG path or "last" to compare' },
          read: { type: 'boolean', description: 'attach the image; a failed click/wait also attaches its shot' },
          keep: { type: 'boolean', description: 'screenshot: keep the PNG on disk (default true); false deletes it once the image is attached; ignored with baseline' },
          clip: {
            type: 'object',
            properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } },
            required: ['x', 'y', 'w', 'h'],
            additionalProperties: false,
            description: 'screenshot/observe: crop to this device-pixel rect (layout coordinates) so the preview stays 1:1; not with baseline',
          },
          log: {
            type: 'object',
            properties: {
              level: { type: 'string' },
              keyword: { type: 'string' },
              tail: { type: 'integer' },
              crash: { type: 'boolean' },
            },
            additionalProperties: true,
            description: 'observe: also return device logs in the same call (hmos_log parameters)',
          },
        },
        required: ['action'],
      },
      output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
      async execute(args, exec) {
        throwIfAborted(exec?.signal)
        const cli = resolveDevecoCli()
        if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
        const device = (typeof args?.device === 'string' && args.device.trim() ? args.device.trim() : '') || await firstRunningSerial(cli)
        if (!device) return { ok: false, error: 'no running emulator; start one with emu {action:"start", name:"<instance>"}' }
        // One place threads the caller's signal, and one place turns an aborted run into the error
        // that stops every polling loop below instead of letting them spin to their deadline.
        const run = async (argv, timeoutMs) => {
          const r = await runCli([process.execPath, cli, ...argv], { timeoutMs, signal: exec?.signal })
          if (r.aborted) throw abortedError()
          return r
        }
        const depth = Number.isFinite(args?.depth) ? Math.max(0, Math.floor(args.depth)) : 0
        /**
         * The depth one call should dump at. A `steps` entry carries its own arguments ("same
         * parameters as a normal call" is what `steps` promises), so a per-step `depth` has to reach
         * `--depth`.
         */
        const depthOf = (step: any) => (Number.isFinite(step?.depth) ? Math.max(0, Math.floor(step.depth)) : depth)
        /** Where screenshots go: the session workspace, so the path it hands back can be read again. */
        const shotRoot = sessionWorkspace(exec)

        /** devecocli takes integer screen coordinates; a node centre lands on .5, so round on the way out. */
        const px = (n: number) => String(Math.round(Number(n)))

        /**
         * A step's own window selection wins, otherwise the call's — the same rule `depth` follows.
         * Returned as a scope object because the caller also needs it to report the depth override
         * `allWindows` forces.
         */
        const windowScope = (step?: Record<string, unknown>) => ({
          win: Number.isFinite(step?.window) ? Number(step?.window) : (Number.isFinite(args?.window) ? Number(args.window) : undefined),
          every: typeof step?.allWindows === 'boolean' ? step.allWindows : args?.allWindows === true,
        })

        /**
         * Dump the tree and remember it. A dump taken right after a navigation can come back with
         * only the progress line, so retry briefly before believing it. `full` switches devecocli to `--mode full`, the only mode that keeps
         * unlabeled and inert containers (much longer than the default mode for the same screen) — the
         * default prunes the very node that can be swallowing a tap.
         */
        const dumpLayout = async (full = false, atDepth = depth, step?: Record<string, unknown>): Promise<{ ok: boolean; lines: LayoutLine[]; error?: string }> => {
          const { win, every } = windowScope(step)
          // Any positive depth answers with the window roots alone, whose subtrees are empty — which
          // reads as "this screen has nothing on it". All windows means the content, so depth is 0.
          const at = every ? 0 : atDepth
          const argv = ['ui', 'layout', '--device', device, '--depth', String(at)]
          if (full) argv.push('--mode', 'full')
          // Other windows (system pickers, permission dialogs, UIExtension panels) are simply absent
          // from a focused-window dump; `--all-windows` is the only way to see them at all.
          if (every) argv.push('--all-windows')
          else if (win !== undefined) argv.push('--window', String(Math.floor(win)))
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const r = await run(argv, 30000)
            if (r.code !== 0) return { ok: false, lines: [], error: tailText(r.output, 6) }
            const lines = cleanLayout(r.output).split(/\r?\n/).map(parseLayoutLine).filter((l) => l.bounds)
            if (lines.length > 0) {
              lastLayout.set(device, lines)
              lastDump.set(device, lines.map((l) => l.raw.trim()))
              return { ok: true, lines }
            }
            if (attempt < 2) await new Promise((resolveWait) => setTimeout(resolveWait, 400))
          }
          return { ok: true, lines: [] }
        }

        /** Render rows, remembering what the caller saw so the next `changedOnly` has a baseline. */
        const renderFor = (rows: { index: number; line: LayoutLine }[], changedOnly: boolean): string => {
          const keys = rawKeys(rows)
          // A filter that matched nothing is NOT "nothing changed": answer `matched:0`, never an empty
          // tree or `changed:0`.
          if (keys.length === 0) return 'matched:0'
          const previous = lastRender.get(device)
          lastRender.set(device, keys)
          // The first call has nothing to compare against, so answering with a wall of `+` lines would
          // only hide the tree the caller asked for; a diff needs two renders by definition.
          return changedOnly && previous ? diffLines(previous, keys) : capLines(renderLines(rows)).join('\n')
        }

        /**
         * One action. A function rather than an inline chain, because `steps` runs exactly the same
         * code for each element — a batch must not be a second, subtly different implementation.
         * `a` is the step object when called from `steps`, the tool arguments otherwise.
         */
        const perform = async (a: any): Promise<any> => {
          const action = String(a?.action || '')
          if (action === 'steps') {
            const list = Array.isArray(a?.steps) ? a.steps : []
            if (list.length === 0) return { ok: false, error: 'steps 需要一个非空的 steps 数组(元素与普通调用同参)。' }
            const keepGoing = a?.onFail === 'continue'
            const done: any[] = []
            let last: any = null
            let stoppedAt = -1
            const failedAt: number[] = []
            for (let i = 0; i < list.length; i += 1) {
              const step = list[i] && typeof list[i] === 'object' ? list[i] : {}
              const stepAction = String(step.action || '')
              const at = Date.now()
              if (!stepAction || stepAction === 'steps') {
                last = { ok: false, error: stepAction === 'steps' ? 'steps 不能嵌套(每一步都必须是一个具体动作)' : '每一步都需要 action' }
              } else {
                try {
                  last = await perform(step)
                } catch (error) {
                  last = { ok: false, error: error instanceof Error ? error.message : String(error) }
                }
              }
              done.push({ action: stepAction || '?', ok: last?.ok === true, ms: Date.now() - at, summary: stepSummary(stepAction, last) })
              if (last?.ok !== true) {
                failedAt.push(i)
                if (!keepGoing) { stoppedAt = i; break }
              }
            }
            // `ok` reflects the batch, not the last step: a failure in the middle is still a failure.
            const failed = failedAt.length > 0
            return {
              ok: !failed,
              device,
              steps: done,
              last,
              // `stoppedAt` means the batch really stopped there — only `stop` can do that. A `continue`
              // batch ran every step, so it reports the failing indices instead of a stop position that
              // never happened.
              ...(stoppedAt >= 0 ? { stoppedAt } : {}),
              ...(keepGoing && failed ? { failedAt } : {}),
            }
          }
          if (action === 'layout') {
            const at = depthOf(a)
            const dump = await dumpLayout(a?.full === true, at, a)
            if (!dump.ok) return { ok: false, device, error: dump.error }
            const rows = selectLayoutLines(dump.lines, a?.filter)
            const page = pageTitle(dump.lines)
            // `depth` and `full` are measured differently — `--mode full` keeps the
            // `window`/`root` containers, so the same number denotes a shallower slice of the real
            // page. A caller that asked for a shallow full dump gets containers only and could read
            // that as "the page is empty"; say what happened instead of guessing a corrected depth.
            const textless = at > 0 && !dump.lines.some((line) => line.text)
            const overrode = windowScope(a).every && at > 0
            const note = overrode
              ? `allWindows 已按 depth:0 执行:depth=${at} 时 devecocli 只回窗口根、子树全空(容易被读成"这屏什么都没有");看到的这棵树是全部窗口的完整内容。`
              : textless
                ? `这次 dump 只有容器、没有任何文字:depth=${at} 只到第 ${at} 层${a?.full === true ? '(full 模式还会多出 window/root 两层)' : ''};要看内容请用 depth:0 或不传 depth。`
                : undefined
            return a?.asJson
              ? { ok: true, device, total: dump.lines.length, page: page || null, ...(note ? { note } : {}), nodes: layoutJson(rows, dump.lines) }
              : { ok: true, device, total: dump.lines.length, page: page || null, ...(note ? { note } : {}), tree: renderFor(rows, a?.changedOnly === true) }
          }
          if (action === 'click' || action === 'longPress' || action === 'doubleTap') {
            // All three are "point at a node and press it": only the devecocli verb differs.
            const verb = action === 'click' ? 'click' : action === 'longPress' ? 'longclick' : 'doubleclick'
            let point = null
            let usedId = null
            let ancestors: string[] = []
            let page = ''
            let matchCount = 0
            let pickedIndex = 0
            let candidates = null
            let inexact = false
            if (Number.isFinite(a?.x) && Number.isFinite(a?.y)) {
              point = { x: a.x, y: a.y }
            } else if (Number.isFinite(a?.id)) {
              // Ids come from the most recent layout, so no re-dump: the caller clicks what it read.
              const stored = lastLayout.get(device)
              if (!stored) return { ok: false, device, error: '尚无 layout 记录:id 来自最近一次 layout,请先调用 layout' }
              const found = pointOf(stored, Number(a.id))
              if (!found) return { ok: false, device, error: `id ${a.id} 在最近一次 layout 中不存在或没有坐标` }
              point = found
              usedId = Number(a.id)
              ancestors = ancestorLabels(stored, usedId)
              page = pageTitle(stored)
            } else if (typeof a?.label === 'string' && a.label.trim()) {
              // Resolve a label to its center in one call: avoids a layout round-trip before click.
              const dump = await dumpLayout()
              if (!dump.ok) return { ok: false, device, error: dump.error }
              const matches = labelMatches(dump.lines, a.label)
              if (!matches.length) {
                // A label that resolves to nothing is usually an overlay or a half-drawn page, which
                // is exactly the case where a picture answers what the tree cannot.
                const shot = await shotFields(api, device, shotRoot, 'click', ctx, a?.read === true)
                return { ok: false, device, error: `no layout node matching "${a.label}"`, page: pageTitle(dump.lines) || null, ...shot }
              }
              const want = Number.isFinite(a?.labelIndex) ? Math.max(0, Math.floor(a.labelIndex)) : 0
              matchCount = matches.length
              pickedIndex = want
              // Repeated labels are the norm on list pages. Answer with the whole candidate set instead
              // of pressing the first one: an unnoticed wrong press costs far more than these bytes.
              if (matchCount > 1) candidates = candidateList(dump.lines, matches)
              if (want >= matchCount) {
                return { ok: false, device, error: `"${a.label}" 匹配 ${matchCount} 个候选,labelIndex ${want} 越界(0..${matchCount - 1})`, matchCount, candidates }
              }
              const match = matches[want]
              point = pointOf(dump.lines, match.targetIndex)
              if (!point) return { ok: false, device, error: `匹配到的节点没有可用坐标:${match.target.raw.trim()}` }
              ancestors = ancestorLabels(dump.lines, match.targetIndex)
              page = pageTitle(dump.lines)
              inexact = !match.exact
            } else return { ok: false, error: `${action} needs id, label or x/y` }
            const r = await run(['ui', verb, px(point.x), px(point.y), '--device', device], 20000)
            if (r.code !== 0) return { ok: false, device, error: tailText(r.output, 4) }
            const result: any = { ok: true, device, x: Math.round(point.x), y: Math.round(point.y) }
            if (usedId !== null) result.id = usedId
            // `page` is always present, `null` when the tree carries no title — "no title" and
            // "the field is missing" looked the same to a caller, and only one of them is a signal.
            result.page = page || null
            // The breadcrumb replaces the old raw `matched`/`tapped` lines: `Row [928,2702,…] clickable`
            // only repeated the coordinates we already return, while the text of the ancestors is what
            // tells the caller which of several identical buttons it just pressed.
            if (ancestors.length) result.ancestors = ancestors
            if (matchCount > 1) { result.matchCount = matchCount; result.pickedIndex = pickedIndex; result.candidates = candidates }
            // A containment-only match tapped a node whose text merely held the label; say so,
            // so the caller can re-issue with exact x/y when that is not the intended node.
            if (inexact) result.matchedBy = 'contains'
            // thenLayout verifies the tap in the same call. `thenWaitFor` waits for a condition instead
            // of the fixed settle delay: a guess of 600 ms is either wasted or too short, and the
            // caller would otherwise spend its next round on the `waitFor` it already knows about.
            if (action === 'click' && (a?.thenLayout || a?.thenWaitFor)) {
              const condition = a?.thenWaitFor && typeof a.thenWaitFor === 'object' ? a.thenWaitFor : null
              if (condition) {
                const waited = await perform({
                  ...condition,
                  action: 'waitFor',
                  timeoutMs: Number.isFinite(condition.timeoutMs) ? condition.timeoutMs : (Number.isFinite(a?.waitMs) ? a.waitMs : 5000),
                  ...(Number.isFinite(condition.pollMs) ? { pollMs: condition.pollMs } : {}),
                })
                result.thenWaitFor = {
                  ok: waited?.ok === true,
                  elapsedMs: waited?.elapsedMs,
                  ...(condition.absent === true ? { absent: true } : { matched: Array.isArray(waited?.matched) ? waited.matched.length : 0 }),
                  ...(waited?.ok === true ? {} : { error: waited?.error ?? '等待条件未在超时内成立' }),
                }
              } else {
                const wait = Number.isFinite(a?.waitMs) ? Math.max(0, Math.min(5000, a.waitMs)) : 600
                if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait))
              }
              const after = await dumpLayout(false, depthOf(a))
              result.tree = after.ok
                ? renderFor(selectLayoutLines(after.lines, a?.filter), a?.changedOnly === true)
                : after.error
            }
            return result
          }
          if (action === 'text') {
            const value = typeof a?.text === 'string' ? a.text : ''
            if (!value) return { ok: false, error: 'text is required' }
            // `--` ends option parsing: without it a string starting with "-" is read as an option
            // ("--help" prints help and exits 0, which the tool would have reported as success).
            const r = await run(['ui', 'text', '--device', device, '--', value], 20000)
            return { ok: r.code === 0, device, error: r.code === 0 ? '' : tailText(r.output, 4) }
          }
          if (action === 'swipe') {
            if (![a?.x, a?.y, a?.x2, a?.y2].every((n) => Number.isFinite(n))) return { ok: false, error: 'swipe needs x, y, x2, y2' }
            const argv = ['ui', 'swipe', px(a.x), px(a.y), px(a.x2), px(a.y2), '--device', device]
            // devecocli's swipe takes a speed like drag/fling does; without it a slow, threshold-y
            // swipe cannot be reproduced at all.
            if (Number.isFinite(a?.velocity)) argv.push('--speed', String(Math.max(1, Math.floor(a.velocity))))
            const r = await run(argv, 20000)
            return { ok: r.code === 0, device, error: r.code === 0 ? '' : tailText(r.output, 4) }
          }
          if (action === 'screenshot') {
            const asked = typeof a?.root === 'string' && a.root.trim() ? a.root.trim() : shotRoot
            const wanted = typeof a?.baseline === 'string' ? a.baseline.trim() : ''
            const read = a?.read === true
            // devecocli cannot crop, so a region capture is cut here. Doing it before the
            // attachment is what makes the preview ~1:1 — the whole point of the option.
            const clipWanted = a?.clip && typeof a.clip === 'object' ? a.clip : null
            if (clipWanted && wanted) {
              return { ok: false, device, error: 'clip 与 baseline 互斥:基线比对的是一整屏,裁剪会让"变没变"的坐标语义变模糊。' }
            }
            if (clipWanted && ![clipWanted.x, clipWanted.y, clipWanted.w, clipWanted.h].every((n) => Number.isFinite(n))) {
              return { ok: false, device, error: 'clip 需要 {x, y, w, h}(设备像素,与 layout 的 [x1,y1,x2,y2] 同一坐标系)。' }
            }
            // `screenshots/` grew without bound because every `read:true` capture stayed
            // on disk after it had been delivered. `keep:false` deletes it again — the picture is in the
            // conversation, and a baseline comparison is the one case that still needs the file.
            const discard = a?.keep === false && !wanted && read
            // `origin` marks this file as one the tool wrote, so it may be pruned later; the panel
            // never sends it and its files therefore keep the never-pruned `hmos-shot-*` name.
            const value = await api.screenshot({ device, root: asked, origin: 'tool' })
            const rel = relativeTo(asked, value.path)
            let clipped = null
            if (clipWanted) {
              try {
                const region = cropPng(decodePng(readFileSync(value.path)), { x: clipWanted.x, y: clipWanted.y, w: clipWanted.w, h: clipWanted.h })
                writeFileSync(value.path, encodePng(region.image))
                clipped = {
                  ...region.rect,
                  ...(region.clamped ? { clamped: true, requested: { x: clipWanted.x, y: clipWanted.y, w: clipWanted.w, h: clipWanted.h } } : {}),
                }
              } catch (error) {
                return { ok: false, device, path: value.path, error: `裁剪失败:${error instanceof Error ? error.message : String(error)}` }
              }
            }
            if (!wanted) {
              // No baseline asked for: this shot is what a later call compares against.
              if (!discard) {
                lastShot.set(device, {
                  path: value.path,
                  ...(clipped ? { clip: { x: clipped.x, y: clipped.y, w: clipped.w, h: clipped.h } } : {}),
                })
              }
              // Absolute path for `read_image`, workspace-relative one for talking about it.
              const image = read ? await attachmentRefForImage(ctx, value.path) : undefined
              let gone = false
              // deleting without having delivered the picture leaves the caller with nothing.
              if (discard && image) {
                try { unlinkSync(value.path); gone = true } catch { /* a leftover file is harmless */ }
              }
              return {
                ok: true, ...(gone ? {} : { path: value.path }), ...(gone || rel === value.path ? {} : { rel }), device: value.device,
                ...(clipped ? { clip: clipped } : {}),
                ...(gone ? { discarded: true } : {}),
                ...(image ? { image } : {}),
                ...(read && !image ? { imageUnavailable: '附件服务不可用或该图超出部署限制,只回了路径' } : {}),
                ...(a?.keep === false && read && !gone ? { keepFailed: '图已留在盘上(附件没能生成,删了就没图可看)。' } : {}),
              }
            }
            const previous = wanted === 'last' ? lastShot.get(device) : undefined
            const baselinePath = wanted === 'last' ? previous?.path ?? '' : wanted
            /**
             * A refused comparison still has a real capture on disk, and it is the picture the caller
             * most wants next ("your baseline is a crop — so show me the screen"). Naming it costs
             * nothing and turns 2.4 MB of orphaned file into a usable path, exactly as the success
             * path does; without it the file was left behind unmentioned (found in the 2026-09-19
             * verification: an unreferenced capture). It is a `tool-*` file, so a
             * refused comparison can no longer be the thing that slowly fills the directory.
             */
            const capture = { diffPath: value.path, ...(rel !== value.path ? { rel } : {}) }
            if (!baselinePath) return { ok: false, device, error: '还没有基线:先不带 baseline 调一次 screenshot,或直接传 PNG 路径。', ...capture }
            // A crop is not a whole-screen baseline: comparing the two gave `diffRatio: 1` (the size
            // guard read "different dimensions" as "everything changed"), which looks like a real
            // answer. Say what happened instead.
            if (previous?.clip) {
              const { x, y, w, h } = previous.clip
              return {
                ok: false, device,
                error: `上一次截图是裁剪图(${x},${y},${w},${h}),不能当整屏基线;请先用不带 clip 的 screenshot 建立整屏基线,或直接传整屏 PNG 路径。`,
                ...capture,
              }
            }
            if (!existsSync(baselinePath)) return { ok: false, device, error: `基线文件不存在:${baselinePath}`, ...capture }
            const before = readFileSync(baselinePath)
            const after = readFileSync(value.path)
            // Unchanged screens are byte-identical, so the common case costs no decode at all.
            if (before.equals(after)) {
              // Nothing moved: drop the capture instead of keeping a second copy of the same screen.
              try { unlinkSync(value.path) } catch { /* a leftover duplicate is harmless */ }
              return { ok: true, device, same: true, diffRatio: 0 }
            }
            let verdict
            try {
              verdict = diffPng(decodePng(before), decodePng(after))
            } catch (error) {
              return { ok: false, device, error: `无法比对基线:${error instanceof Error ? error.message : String(error)}`, diffPath: value.path }
            }
            if (verdict.same) {
              try { unlinkSync(value.path) } catch { /* ignore */ }
              return { ok: true, device, same: true, diffRatio: 0 }
            }
            // It moved, so the new capture is worth looking at — the same `read` flag covers it.
            const movedImage = read ? await attachmentRefForImage(ctx, value.path) : undefined
            return {
              ok: true, device, same: false, diffRatio: verdict.diffRatio, changedPixels: verdict.changedPixels,
              // `diffRatio` without its denominator is hard to sanity-check; hand the total over too.
              totalPixels: verdict.totalPixels,
              diffPath: value.path, ...(rel !== value.path ? { rel } : {}),
              ...(movedImage ? { image: movedImage } : {}),
              ...(read && !movedImage ? { imageUnavailable: '附件服务不可用或该图超出部署限制,只回了路径' } : {}),
            }
          }
          if (action === 'drag' || action === 'fling') {
            if (![a?.x, a?.y, a?.x2, a?.y2].every((n) => Number.isFinite(n))) return { ok: false, error: `${action} needs x, y, x2, y2` }
            const argv = ['ui', action, px(a.x), px(a.y), px(a.x2), px(a.y2), '--device', device]
            // devecocli synthesizes the gesture from the speed: a speedless drag moves nothing and
            // still reports success, so a drag that did not ask for one gets a working default.
            const speed = Number.isFinite(a?.velocity) ? Math.max(1, Math.floor(a.velocity)) : (action === 'drag' ? DRAG_SPEED : null)
            if (speed !== null) argv.push('--speed', String(speed))
            const r = await run(argv, 20000)
            return { ok: r.code === 0, device, error: r.code === 0 ? '' : tailText(r.output, 4) }
          }
          if (action === 'dircfling') {
            // The accepted direction words are devecocli's business, so pass the value through.
            const dir = typeof a?.direction === 'string' ? a.direction.trim() : ''
            if (!dir) return { ok: false, error: 'dircfling needs direction' }
            const r = await run(['ui', 'dircfling', dir, '--device', device], 20000)
            return { ok: r.code === 0, device, error: r.code === 0 ? '' : tailText(r.output, 4) }
          }
          if (action === 'waitFor') {
            // Replaces the sleep-then-poll loop: the poll interval is the tool's business now.
            const timeout = Number.isFinite(a?.timeoutMs) ? Math.max(0, Math.min(60000, a.timeoutMs)) : 5000
            const poll = Number.isFinite(a?.pollMs) ? Math.max(50, Math.min(2000, a.pollMs)) : 200
            // `absent` waits for the match to be GONE — the only way to observe a drawer, dialog,
            // keyboard or toast closing, which `waitForChange`/`waitForIdle` can only approximate.
            const absent = a?.absent === true
            const started = Date.now()
            let last: LayoutLine[] = []
            for (;;) {
              const dump = await dumpLayout()
              if (!dump.ok) return { ok: false, device, error: dump.error }
              last = dump.lines
              const hits = matchLayout(last, {
                text: typeof a?.text === 'string' ? a.text : '',
                textRegex: a?.textRegex,
                clickableOnly: a?.clickableOnly,
              })
              if (absent ? hits.length === 0 : hits.length > 0) {
                // The dump that matched is already in memory, so the tree costs nothing and saves the
                // round-trip this action exists to avoid: "wait for X, then tap it" was two calls
                // because only the timeout branch answered with a tree (the ids in it are the ones
                // `click {id}` resolves against, since `dumpLayout` just refreshed `lastLayout`).
                const found = pageTitle(last)
                return {
                  ok: true, device, elapsedMs: Date.now() - started,
                  ...(absent ? { absent: true, matched: [] } : { matched: hits }),
                  page: found || null,
                  tree: renderLayout(last.map((line, index) => ({ index, line }))),
                }
              }
              if (Date.now() - started + poll > timeout) break
              await new Promise((resolveWait) => setTimeout(resolveWait, poll))
            }
            // A timeout hands back the tree it last saw (and a picture of it), so a miss is diagnosable
            // without another call. For `absent` the miss is the opposite one: the match is still there.
            const page = pageTitle(last)
            const shot = await shotFields(api, device, shotRoot, action, ctx, a?.read === true)
            const late = absent
              ? matchLayout(last, { text: typeof a?.text === 'string' ? a.text : '', textRegex: a?.textRegex, clickableOnly: a?.clickableOnly })
              : []
            return { ok: false, device, matched: late, elapsedMs: Date.now() - started, ...(absent ? { absent: true } : {}), page: page || null, ...shot, tree: renderLayout(last.map((line, index) => ({ index, line }))) }
          }
          if (action === 'waitForChange') {
            // The counterpart of waitForIdle: that one returns as soon as the layout is stable, which
            // is exactly wrong when a tap was swallowed by an overlay and nothing ever moves.
            const timeout = Number.isFinite(a?.timeoutMs) ? Math.max(0, Math.min(60000, a.timeoutMs)) : 5000
            const poll = Number.isFinite(a?.pollMs) ? Math.max(50, Math.min(2000, a.pollMs)) : 300
            const started = Date.now()
            // The baseline is the LAST DUMP, not a snapshot taken now: `click {label}` dumps to resolve
            // the label, so by the time this action starts the transition it is asked to observe may
            // already have happened — which is precisely the miss this action exists to prevent.
            let baseline = lastDump.get(device)
            if (!baseline) {
              const first = await dumpLayout()
              if (!first.ok) return { ok: false, device, error: first.error }
              baseline = first.lines.map((l) => l.raw.trim())
            }
            let polls = 0
            let last: LayoutLine[] = lastLayout.get(device) ?? []
            for (;;) {
              const dump = await dumpLayout()
              if (!dump.ok) return { ok: false, device, error: dump.error }
              polls += 1
              last = dump.lines
              const moved = diffLines(baseline, dump.lines.map((l) => l.raw.trim()))
              if (moved !== 'changed:0') {
                return { ok: true, device, polls, elapsedMs: Date.now() - started, changed: capLines(moved.split('\n')).join('\n') }
              }
              if (Date.now() - started + poll > timeout) break
              await new Promise((resolveWait) => setTimeout(resolveWait, poll))
            }
            const page = pageTitle(last)
            const shot = await shotFields(api, device, shotRoot, action, ctx, a?.read === true)
            return { ok: false, device, polls, elapsedMs: Date.now() - started, page: page || null, ...shot, tree: renderLayout(last.map((line, index) => ({ index, line }))) }
          }
          if (action === 'waitForIdle') {
            const timeout = Number.isFinite(a?.timeoutMs) ? Math.max(0, Math.min(60000, a.timeoutMs)) : 5000
            const poll = Number.isFinite(a?.pollMs) ? Math.max(50, Math.min(2000, a.pollMs)) : 300
            const need = Number.isFinite(a?.stablePolls) ? Math.max(2, Math.min(10, Math.floor(a.stablePolls))) : 2
            const started = Date.now()
            let previous = ''
            let stable = 0
            let polls = 0
            let last: LayoutLine[] = []
            for (;;) {
              const dump = await dumpLayout()
              if (!dump.ok) return { ok: false, device, error: dump.error }
              last = dump.lines
              polls += 1
              const now = dump.lines.map((l) => l.raw).join('\n')
              stable = now !== '' && now === previous ? stable + 1 : 1
              previous = now
              if (stable >= need) {
                // Same reason as `waitFor`: the stable dump is already here, and the tree it renders
                // is what the caller is about to act on — answering without it cost a `layout` round.
                const settled = pageTitle(last)
                return {
                  ok: true, device, polls, elapsedMs: Date.now() - started,
                  page: settled || null,
                  tree: renderLayout(last.map((line, index) => ({ index, line }))),
                }
              }
              if (Date.now() - started + poll > timeout) break
              await new Promise((resolveWait) => setTimeout(resolveWait, poll))
            }
            const idlePage = pageTitle(last)
            const idleShot = await shotFields(api, device, shotRoot, action, ctx, a?.read === true)
            return { ok: false, device, polls, elapsedMs: Date.now() - started, page: idlePage || null, ...idleShot, tree: renderLayout(last.map((line, index) => ({ index, line }))) }
          }
          if (action === 'observe') {
            // "What is on screen right now" in one call: the tree the caller needs in order to decide,
            // plus — with `read` — the picture that answers what the tree cannot (blank page, layout
            // bug). Composing layout with screenshot keeps exactly one implementation of each, and the
            // tree still arrives when the capture fails.
            const seen = await perform({ ...a, action: 'layout' })
            if (seen?.ok !== true) return seen
            const extra: any = {}
            // debugging an odd screen was `act → observe → hmos_log`; the log that always comes
            // next can ride along, through the same implementation `hmos_log` uses.
            if (a?.log && typeof a.log === 'object') {
              const logs = await hmosLog.execute({ ...a.log, ...(device ? { device } : {}) }, exec)
              extra.log = logs?.ok === true
                ? { count: logs.count, lines: logs.lines }
                : { error: logs?.error ?? '日志读取失败' }
            }
            if (a?.read !== true) return { ...seen, ...extra }
            const shot = await perform({ ...a, action: 'screenshot' })
            if (shot?.ok === true) return { ...seen, ...extra, ...shot, ok: true }
            return { ...seen, ...extra, shotError: shot?.error ?? '截图失败' }
          }
          return { ok: false, error: `unknown action ${action}` }
        }

        return perform(args)
      },
  }
}

/**
 * One line describing a step result. A batch answers with summaries plus the last step in full:
 * the point of `steps` is fewer round trips, so a step-by-step copy of every payload would undo it.
 */
export function stepSummary(action: string, value: any): string {
  if (value === null || typeof value !== 'object') return String(value ?? '')
  if (value.ok !== true) return String(value.error ?? value.reason ?? '失败').replace(/\s+/g, ' ').slice(0, 160)
  const bits: string[] = []
  if (value.page) bits.push(`page=${value.page}`)
  if (Number.isFinite(value.total)) bits.push(`${value.total} 节点`)
  if (Array.isArray(value.ancestors) && value.ancestors.length > 0) bits.push(value.ancestors.join('/'))
  if (Number.isFinite(value.matchCount) && value.matchCount > 1) bits.push(`match=${value.matchCount}`)
  if (Number.isFinite(value.x)) bits.push(`(${value.x},${value.y})`)
  if (Array.isArray(value.matched)) bits.push(`matched=${value.matched.length}`)
  if (typeof value.tree === 'string' && value.tree) bits.push(value.tree.replace(/\s*\n\s*/g, ' | ').slice(0, 160))
  return bits.join(' ') || `${action} ok`
}

/** Speed (px/s) for a drag that did not ask for one: devecocli synthesizes the gesture from it. */
  const DRAG_SPEED = 400
