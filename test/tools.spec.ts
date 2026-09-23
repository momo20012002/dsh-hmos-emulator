/**
 * The tools a model calls, driven end to end through `execute()` with a stand-in devecocli
 * (`fake-devecocli.js`) — the behaviour that only exists inside a tool call.
 *
 * The unit specs cover the pure parsers; these cover what only exists inside `execute`: waiting for
 * a match to disappear, attaching a captured screenshot to the same call, and degrading to a path
 * when the harness has no image store. Checking those by hand on the emulator is exactly the kind
 * of check that quietly rots. A new case belongs here when it invokes a tool and asserts what the
 * caller gets back.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, decodePng, encodePng } from '../lib/index.js'

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), 'fake-devecocli.js')

/**
 * This spec drives a real child process, and a confined sandbox refuses one with piped stdio
 * (EPERM) — the plugin's own `runCli` could not work there either, so the spec skips instead of
 * reporting a failure that is really an environment limit (same rule as the git-backed cases).
 */
const CAN_SPAWN = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' }).status === 0

/** Two layout captures of the same shape: the second is the first without its drawer row. */
const WITH_DRAWER = [
  '[0,0,1320,2856]',
  '  Column [0,137,1320,2856]',
  '    Row [0,137,1320,318] clickable',
  '      Text [140,190,1096,264] "Page title"',
  '    Text [56,360,519,409] "Drawer"',
].join('\n')

const WITHOUT_DRAWER = [
  '[0,0,1320,2856]',
  '  Column [0,137,1320,2856]',
  '    Row [0,137,1320,318] clickable',
  '      Text [140,190,1096,264] "Page title"',
].join('\n')

const INSTANCES = JSON.stringify([{ serial: '127.0.0.1:5555', status: 'running' }])

let dir
let stateFile
let savedCli
/** Arguments each call handed to the harness attachment store, proving the image really went in. */
let savedImages

/** Mount the plugin with an attachment service (or without one); every registered tool by name. */
function mountAll({ attachments = true } = {}) {
  const registered = []
  const ctx = {
    get: (name) => {
      if (name === 'tools') return { register: (def) => { registered.push(def); return () => {} } }
      if (name === 'webServer') return { host: '127.0.0.1', register: () => () => {} }
      if (name === 'systemPrompt') return { context: () => () => {} }
      if (name === 'attachments' && attachments) {
        return {
          saveImage: async (input) => {
            savedImages.push(input)
            return { attachmentId: 'sha256:fake', mediaType: input.mediaType, bytes: input.data.length, width: 1320, height: 2856, name: input.name }
          },
        }
      }
      return undefined
    },
    effect: (fn) => fn(),
  }
  apply(ctx, {})
  return registered
}

const mountTools = (options = {}) => mountAll(options).find((def) => def.name === 'emu_ui')

/** The tool-call context the host passes: it names the session workspace, which is where auto-shots go. */
const exec = { agent: { session: { header: { cwd: '' } } } }

const textOf = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')

beforeAll(() => {
  savedCli = process.env.DSH_HMOS_DEVECO_CLI
  process.env.DSH_HMOS_DEVECO_CLI = FAKE_CLI
  process.env.DSH_FAKE_INSTANCES = INSTANCES
})

afterAll(() => {
  if (savedCli === undefined) delete process.env.DSH_HMOS_DEVECO_CLI
  else process.env.DSH_HMOS_DEVECO_CLI = savedCli
  for (const key of ['DSH_FAKE_INSTANCES', 'DSH_FAKE_STATE', 'DSH_FAKE_ARGV_LOG', 'DSH_FAKE_PNG_B64', 'DSH_FAKE_LOG', 'DSH_FAKE_LAYOUT_FIRST', 'DSH_FAKE_LAYOUT_LATER']) delete process.env[key]
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-emu-ui-'))
  exec.agent.session.header.cwd = dir
  stateFile = join(dir, 'layout-calls')
  savedImages = []
  process.env.DSH_FAKE_STATE = stateFile
  process.env.DSH_FAKE_ARGV_LOG = join(dir, 'argv.log')
  process.env.DSH_FAKE_LAYOUT_FIRST = WITH_DRAWER
  process.env.DSH_FAKE_LAYOUT_LATER = WITHOUT_DRAWER
})

// Per test, not per file: every case gets its own workspace, so removing only the last one in
// afterAll left one temp directory behind for each case that ran before it.
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!CAN_SPAWN)('emu_ui waitFor absent', () => {
  it('succeeds once the match is gone, polling past the first dump', async () => {
    const emuUi = mountTools()
    const result = await emuUi.execute({ action: 'waitFor', text: 'Drawer', absent: true, timeoutMs: 5000, pollMs: 50 }, exec)
    expect(result.ok).toBe(true)
    expect(result.absent).toBe(true)
    expect(result.matched).toEqual([])
    // The first dump still had the drawer, so a second one must have been taken.
    expect(existsSync(stateFile)).toBe(true)
  })

  it('fails with the node it could not lose, so the caller sees what is still there', async () => {
    process.env.DSH_FAKE_LAYOUT_FIRST = WITH_DRAWER
    process.env.DSH_FAKE_LAYOUT_LATER = WITH_DRAWER
    const emuUi = mountTools()
    const result = await emuUi.execute({ action: 'waitFor', text: 'Drawer', absent: true, timeoutMs: 300, pollMs: 50 }, exec)
    expect(result.ok).toBe(false)
    expect(result.absent).toBe(true)
    expect(result.matched).toHaveLength(1)
    expect(result.tree).toContain('Drawer')
  })

  // the dump that matched is already in memory, so answering without its tree cost a
  // second call ("wait for X" → "lay out X" → "tap X").
  it('answers a successful wait with the tree it matched in', async () => {
    const emuUi = mountTools()
    const result = await emuUi.execute({ action: 'waitFor', textRegex: 'Page title', timeoutMs: 5000, pollMs: 50 }, exec)
    expect(result.ok).toBe(true)
    expect(result.tree).toContain('Page title')
    // The ids in it are the ones `click {id}` resolves against: the matching dump refreshed them.
    expect(result.tree).toMatch(/#\d+ Text \[140,190,1096,264\] "Page title"/)
  })

})

describe.skipIf(!CAN_SPAWN)('emu_ui screenshot read', () => {
  it('attaches the capture to the same call as a durable image block', async () => {
    const emuUi = mountTools()
    const args = { action: 'screenshot', root: dir, read: true }
    const value = await emuUi.execute(args, exec)
    expect(value.ok).toBe(true)
    expect(value.image).toMatchObject({ attachmentId: 'sha256:fake', mediaType: 'image/png', width: 1320, height: 2856 })
    // The bytes of the file that was just written are what the store received.
    expect(savedImages).toHaveLength(1)
    expect(savedImages[0].mediaType).toBe('image/png')

    // The block shape the harness projects: `attachment`, not the `{data, mimeType}` wire form.
    const blocks = emuUi.output.render(args, value)
    expect(blocks[0].type).toBe('text')
    expect(JSON.parse(textOf(blocks)).path).toBe(value.path)
    expect(blocks[1]).toEqual({ type: 'image', attachment: value.image })
  })

  it('degrades to the path alone when no image store is mounted', async () => {
    const emuUi = mountTools({ attachments: false })
    const args = { action: 'screenshot', root: dir, read: true }
    const value = await emuUi.execute(args, exec)
    expect(value.ok).toBe(true)
    expect(value.image).toBeUndefined()
    expect(value.imageUnavailable).toContain('路径')
    expect(emuUi.output.render(args, value).map((b) => b.type)).toEqual(['text'])
  })

  it('does not attach anything unless read is asked for', async () => {
    const emuUi = mountTools()
    const args = { action: 'screenshot', root: dir }
    const value = await emuUi.execute(args, exec)
    expect(value.ok).toBe(true)
    expect(value.image).toBeUndefined()
    expect(savedImages).toEqual([])
    expect(emuUi.output.render(args, value).map((b) => b.type)).toEqual(['text'])
  })

  // inside `steps` the image lives under `last`, and the renderer only looked at the top
  // level — the attachment was stored and then dropped, so a batch could never show a screen.
  it('keeps an image requested inside steps', async () => {
    const emuUi = mountTools()
    const args = { action: 'steps', steps: [{ action: 'layout' }, { action: 'screenshot', root: dir, read: true }] }
    const value = await emuUi.execute(args, exec)
    expect(value.last.image).toMatchObject({ attachmentId: 'sha256:fake' })
    const blocks = emuUi.output.render(args, value)
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image'])
    expect(blocks[1].attachment.attachmentId).toBe('sha256:fake')
  })

})

// "what is on screen right now" was always two calls — a tree you can act on and, when the
// tree cannot answer (blank page, layout bug), a picture.
describe.skipIf(!CAN_SPAWN)('emu_ui observe', () => {
  it('adds the picture when read is asked for, in the same call', async () => {
    const emuUi = mountTools()
    const args = { action: 'observe', read: true, root: dir }
    const value = await emuUi.execute(args, exec)
    expect(value.ok).toBe(true)
    expect(value.tree).toContain('Page title')
    expect(value.path).toContain('screenshots')
    const blocks = emuUi.output.render(args, value)
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image'])
  })
})

// a tap was checked by guessing 600 ms and then dumping; the caller's next round was the
// `waitFor` it already knew it wanted.
describe.skipIf(!CAN_SPAWN)('emu_ui thenWaitFor', () => {
  it('waits for the condition after the tap, then dumps, and reports the wait', async () => {
    const emuUi = mountTools()
    // The first dump is WITH_DRAWER, later ones are not — so "the drawer is gone" is reached by
    // polling, and the tree that comes back is the settled one.
    const result = await emuUi.execute({
      action: 'click', x: 100, y: 200, thenWaitFor: { text: 'Drawer', absent: true, timeoutMs: 8000, pollMs: 50 },
    }, exec)
    expect(result.ok).toBe(true)
    expect(result.thenWaitFor).toMatchObject({ ok: true, absent: true })
    expect(result.tree).not.toContain('Drawer')
  })

  it('keeps the tree even when the condition never holds, and says so', async () => {
    process.env.DSH_FAKE_LAYOUT_FIRST = WITH_DRAWER
    process.env.DSH_FAKE_LAYOUT_LATER = WITH_DRAWER
    const emuUi = mountTools()
    const result = await emuUi.execute({
      action: 'click', x: 100, y: 200, thenWaitFor: { text: 'Drawer', absent: true, timeoutMs: 300, pollMs: 50 }, thenLayout: true,
    }, exec)
    expect(result.ok).toBe(true)          // the tap itself worked
    expect(result.thenWaitFor.ok).toBe(false)
    expect(result.thenWaitFor.error).toBeTruthy()
    expect(result.tree).toContain('Drawer')
  })

})

// `steps` promises "the same parameters as a normal call", but every batched layout dumped
// at the outer `depth` — a batch quietly got fatter instead of failing.
describe.skipIf(!CAN_SPAWN)('emu_ui per-step depth', () => {
  const layoutDepths = () => readFileSync(process.env.DSH_FAKE_ARGV_LOG, 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line))
    .filter((a) => a[0] === 'ui' && a[1] === 'layout')
    .map((a) => a[a.indexOf('--depth') + 1])

  it('passes each step own depth through to devecocli', async () => {
    const emuUi = mountTools()
    await emuUi.execute({ action: 'steps', steps: [{ action: 'layout', depth: 1 }, { action: 'layout', depth: 2 }] }, exec)
    expect(layoutDepths()).toEqual(['1', '2'])
  })

  it('falls back to the outer depth when a step has none', async () => {
    const emuUi = mountTools()
    await emuUi.execute({ action: 'steps', depth: 3, steps: [{ action: 'layout' }, { action: 'layout', depth: 1 }] }, exec)
    expect(layoutDepths()).toEqual(['3', '1'])
  })

  it('uses the click step own depth for its follow-up dump', async () => {
    const emuUi = mountTools()
    await emuUi.execute({ action: 'click', x: 10, y: 20, thenLayout: true, waitMs: 0, depth: 1 }, exec)
    expect(layoutDepths()).toEqual(['1'])
  })
})

// A focused-window dump omits every other window: system pickers, permission dialogs and
// UIExtension panels are not in it at all, so the window selection has to reach devecocli as-is.
describe.skipIf(!CAN_SPAWN)('emu_ui window scope', () => {
  const windowFlags = () => readFileSync(process.env.DSH_FAKE_ARGV_LOG, 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line))
    .filter((a) => a[0] === 'ui' && a[1] === 'layout')
    .map((a) => {
      if (a.includes('--all-windows')) return ['--all-windows']
      const at = a.indexOf('--window')
      return at >= 0 ? ['--window', a[at + 1]] : []
    })

  it('passes --all-windows through, and --window when one id is asked for', async () => {
    const emuUi = mountTools()
    await emuUi.execute({ action: 'layout', allWindows: true }, exec)
    await emuUi.execute({ action: 'layout', window: 31 }, exec)
    expect(windowFlags()).toEqual([['--all-windows'], ['--window', '31']])
  })

  it('inherits the call window scope in a step, and lets a step override it', async () => {
    const emuUi = mountTools()
    await emuUi.execute({
      action: 'steps', window: 31,
      steps: [{ action: 'layout' }, { action: 'layout', window: 7 }, { action: 'layout', allWindows: true }],
    }, exec)
    expect(windowFlags()).toEqual([['--window', '31'], ['--window', '7'], ['--all-windows']])
  })

  it('pins the depth to 0 for allWindows, which answers with empty subtrees otherwise', async () => {
    const emuUi = mountTools()
    // Any positive depth returns the window roots alone, so `allWindows` + `depth:3` reads as
    // "this screen has nothing on it" — the depth is dropped and the result says so.
    const result = await emuUi.execute({ action: 'layout', depth: 3, allWindows: true }, exec)
    const argv = readFileSync(process.env.DSH_FAKE_ARGV_LOG, 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line))
      .filter((a) => a[0] === 'ui' && a[1] === 'layout').pop()
    expect(argv[argv.indexOf('--depth') + 1]).toBe('0')
    expect(result.note).toContain('allWindows')
  })
})

// devecocli synthesizes a gesture from `--speed`, and reports success either way: `swipe`/`fling`
// never forwarded the speed at all, while a drag without one moved nothing.
describe.skipIf(!CAN_SPAWN)('emu_ui gesture speed', () => {
  const speedOf = (cmd) => readFileSync(process.env.DSH_FAKE_ARGV_LOG, 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line))
    .filter((a) => a[0] === 'ui' && a[1] === cmd)
    .map((a) => {
      const at = a.indexOf('--speed')
      return at >= 0 ? a[at + 1] : null
    })

  it('forwards an explicit speed for swipe and fling', async () => {
    const emuUi = mountTools()
    await emuUi.execute({ action: 'swipe', x: 1, y: 2, x2: 3, y2: 4, velocity: 250 }, exec)
    await emuUi.execute({ action: 'fling', x: 1, y: 2, x2: 3, y2: 4, velocity: 900 }, exec)
    expect(speedOf('swipe')).toEqual(['250'])
    expect(speedOf('fling')).toEqual(['900'])
  })

  it('gives a drag the speed it needs to move anything, and keeps an explicit one', async () => {
    const emuUi = mountTools()
    await emuUi.execute({ action: 'drag', x: 1, y: 2, x2: 3, y2: 4 }, exec)
    await emuUi.execute({ action: 'drag', x: 1, y: 2, x2: 3, y2: 4, velocity: 120 }, exec)
    expect(speedOf('drag')).toEqual(['400', '120'])
  })

  it('rounds fractional coordinates, which devecocli refuses outright', async () => {
    const emuUi = mountTools()
    // A node centre is (x1+x2)/2, so .5 coordinates are the norm rather than the exception.
    const press = await emuUi.execute({ action: 'click', x: 10.4, y: 20.6 }, exec)
    await emuUi.execute({ action: 'swipe', x: 1.4, y: 2.6, x2: 3.5, y2: 4.4 }, exec)
    const argv = readFileSync(process.env.DSH_FAKE_ARGV_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(argv.find((a) => a[1] === 'click').slice(2, 4)).toEqual(['10', '21'])
    expect(argv.find((a) => a[1] === 'swipe').slice(2, 6)).toEqual(['1', '3', '4', '4'])
    expect([press.x, press.y]).toEqual([10, 21])
  })
})

// `stoppedAt` was reported for every failing step, so a `continue` batch — which runs all of
// them — answered `stoppedAt: 40` for a 41-step batch in which nothing was stopped. The field now
// means what it says, and the mode that does not stop reports the failing indices instead.
describe.skipIf(!CAN_SPAWN)('steps failure reporting', () => {
  const MISS = { action: 'click', label: '绝不存在的按钮ZZZ' }

  it('names the step the batch actually stopped at, and nothing else', async () => {
    const emuUi = mountTools()
    const result = await emuUi.execute({ action: 'steps', steps: [{ action: 'layout' }, MISS, { action: 'layout' }] }, exec)
    expect(result.ok).toBe(false)
    expect(result.stoppedAt).toBe(1)
    expect(result.failedAt).toBeUndefined()
    // Stopping at step 1 is the point: step 2 never ran.
    expect(result.steps).toHaveLength(2)
  })

  it('lists the failing indices of a continue batch instead of claiming it stopped', async () => {
    const emuUi = mountTools()
    const result = await emuUi.execute({ action: 'steps', onFail: 'continue', steps: [MISS, { action: 'layout' }, MISS] }, exec)
    expect(result.ok).toBe(false)
    expect(result.failedAt).toEqual([0, 2])
    expect(result.stoppedAt).toBeUndefined()
    expect(result.steps).toHaveLength(3)

    // Nothing failed: neither field is emitted (it never stopped and has nothing to report).
    const clean = await emuUi.execute({ action: 'steps', onFail: 'continue', steps: [{ action: 'layout' }, { action: 'layout' }] }, exec)
    expect(clean.ok).toBe(true)
    expect(clean.stoppedAt).toBeUndefined()
    expect(clean.failedAt).toBeUndefined()
  })
})

// the automatic failure shot was stored and only its path returned, so every failure cost
// one more call to look at it.
describe.skipIf(!CAN_SPAWN)('failure shots', () => {
  it('attaches the automatic shot of a missed click when read is set', async () => {
    const emuUi = mountTools()
    const args = { action: 'click', label: 'Nothing like this', read: true }
    const value = await emuUi.execute(args, exec)
    expect(value.ok).toBe(false)
    expect(value.shot).toContain('auto-click')
    expect(value.image).toMatchObject({ attachmentId: 'sha256:fake' })
    expect(emuUi.output.render(args, value).map((b) => b.type)).toEqual(['text', 'image'])
  })

  it('attaches the shot of a timed-out wait when read is set', async () => {
    process.env.DSH_FAKE_LAYOUT_FIRST = WITH_DRAWER
    process.env.DSH_FAKE_LAYOUT_LATER = WITH_DRAWER
    const emuUi = mountTools()
    const args = { action: 'waitFor', text: 'Nowhere', read: true, timeoutMs: 300, pollMs: 50 }
    const value = await emuUi.execute(args, exec)
    expect(value.ok).toBe(false)
    expect(value.shot).toContain('auto-waitFor')
    expect(value.image).toMatchObject({ attachmentId: 'sha256:fake' })
  })
})

// a doc lookup is search-then-read, so `open` brings the body along.
describe.skipIf(!CAN_SPAWN)('hmos_docs search open', () => {
  const docsOf = () => mountAll().find((def) => def.name === 'hmos_docs')

  it('brings the first hit back in full when open is asked for', async () => {
    const result = await docsOf().execute({ action: 'search', keywords: 'anything', open: 1 })
    expect(result.opened).toHaveLength(1)
    expect(result.opened[0]).toMatchObject({ id: 'sample/doc-1', title: 'Sample doc' })
    expect(result.opened[0].text).toContain('line one')
  })
})

// devecocli cannot crop, so a region capture is cut locally — which needs a PNG encoder to
// mirror the decoder the baseline diff already had.

// the point of `clip` is that the attachment preview stays ~1:1 (a full 1320x2856 screen is
// downscaled to 874x1890 before the model sees it).
describe.skipIf(!CAN_SPAWN)('emu_ui clip', () => {
  /** A fake capture: a real 8x6 RGBA PNG written where devecocli would write it. */
  const CAPTURE = (() => {
    const px = Buffer.alloc(8 * 6 * 4)
    for (let i = 0; i < px.length; i += 4) { px[i] = 10; px[i + 1] = 20; px[i + 2] = 30; px[i + 3] = 255 }
    return encodePng({ width: 8, height: 6, channels: 4, pixels: px })
  })()

  it('writes the crop to disk, so the attached image is the region', async () => {
    process.env.DSH_FAKE_PNG_B64 = CAPTURE.toString('base64')
    const emuUi = mountTools()
    const args = { action: 'screenshot', root: dir, read: true, clip: { x: 2, y: 1, w: 3, h: 4 } }
    const value = await emuUi.execute(args, exec)
    expect(value.ok).toBe(true)
    expect(value.clip).toEqual({ x: 2, y: 1, w: 3, h: 4 })
    const onDisk = decodePng(readFileSync(value.path))
    expect([onDisk.width, onDisk.height]).toEqual([3, 4])
    expect(savedImages).toHaveLength(1)
    expect(emuUi.output.render(args, value).map((b) => b.type)).toEqual(['text', 'image'])
  })

  it('reports a clamped rectangle instead of silently returning a different picture', async () => {
    process.env.DSH_FAKE_PNG_B64 = CAPTURE.toString('base64')
    const emuUi = mountTools()
    const value = await emuUi.execute({ action: 'screenshot', root: dir, read: true, clip: { x: 6, y: 5, w: 10, h: 10 } }, exec)
    expect(value.clip).toEqual({ x: 6, y: 5, w: 2, h: 1, clamped: true, requested: { x: 6, y: 5, w: 10, h: 10 } })
  })

  it('refuses clip together with baseline, and an incomplete rect', async () => {
    const emuUi = mountTools()
    const both = await emuUi.execute({ action: 'screenshot', root: dir, clip: { x: 1, y: 1, w: 2, h: 2 }, baseline: 'last' }, exec)
    expect(both.ok).toBe(false)
    expect(both.error).toContain('互斥')
    const partial = await emuUi.execute({ action: 'screenshot', root: dir, clip: { x: 1, y: 1 } }, exec)
    expect(partial.ok).toBe(false)
    expect(partial.error).toContain('x, y, w, h')
  })

  // a crop was registered as `last`, and comparing against it answered "everything
  // changed" — the size guard turning "different dimensions" into `diffRatio: 1`.
  it('refuses to use a cropped capture as the whole-screen baseline', async () => {
    process.env.DSH_FAKE_PNG_B64 = CAPTURE.toString('base64')
    const emuUi = mountTools()
    const first = await emuUi.execute({ action: 'screenshot', root: dir, clip: { x: 0, y: 0, w: 4, h: 2 } }, exec)
    expect(first.ok).toBe(true)
    const compared = await emuUi.execute({ action: 'screenshot', root: dir, baseline: 'last' }, exec)
    expect(compared.ok).toBe(false)
    expect(compared.error).toContain('裁剪图')
    expect(compared.diffRatio).toBeUndefined()
    // The refused comparison already took a capture; naming it beats leaving 2.4 MB orphaned (found
    // in the 2026-09-19 verification: an unreferenced `hmos-shot-…` file).
    expect(compared.diffPath).toContain('screenshots')
    expect(existsSync(compared.diffPath)).toBe(true)
  })

  it('names the capture a refusal took, for every refusal path', async () => {
    process.env.DSH_FAKE_PNG_B64 = CAPTURE.toString('base64')
    const emuUi = mountTools()
    // No baseline yet.
    const none = await emuUi.execute({ action: 'screenshot', root: dir, baseline: 'last' }, exec)
    expect(none.ok).toBe(false)
    expect(existsSync(none.diffPath)).toBe(true)
    // A baseline path that does not exist.
    const missing = await emuUi.execute({ action: 'screenshot', root: dir, baseline: join(dir, 'nope.png') }, exec)
    expect(missing.ok).toBe(false)
    expect(existsSync(missing.diffPath)).toBe(true)
  })

})

// an unreadable module list must not reject an explicit
// `module` with "模块 X 不属于该工程(可选:无)" — that is a confident answer we cannot support.
describe.skipIf(!CAN_SPAWN)('deploy module list', () => {
  it('passes an explicit module through and says the list was unreadable', async () => {
    mkdirSync(join(dir, 'proj'), { recursive: true })
    // Legal JSON5 (single-quoted keys) that `stripJson5` does not cover, so the list cannot be read.
    writeFileSync(join(dir, 'proj', 'build-profile.json5'), "{ 'modules': [ { 'name': 'entry' } ] }")
    const deploy = mountAll().find((def) => def.name === 'hmos_deploy')
    const result = await deploy.execute({ projectPath: 'proj', buildOnly: true, module: 'entry' }, exec)
    expect(result.ok).toBe(true)
    expect(result.note).toContain('未能从 build-profile.json5 读出模块名')
    const argv = readFileSync(process.env.DSH_FAKE_ARGV_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const build = argv.find((a) => a[0] === 'build')
    expect(build).toContain('entry')
  })

  it('still rejects a module the project really lacks', async () => {
    mkdirSync(join(dir, 'proj2'), { recursive: true })
    writeFileSync(join(dir, 'proj2', 'build-profile.json5'), '{ "modules": [{ "name": "entry" }] }')
    const deploy = mountAll().find((def) => def.name === 'hmos_deploy')
    const result = await deploy.execute({ projectPath: 'proj2', buildOnly: true, module: 'nope' }, exec)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不属于该工程')
    expect(result.error).toContain('entry')
  })
})

// `depth` and `full` are measured differently (`--mode full` keeps window/root), so a
// small depth on a full dump can show containers only — which reads as "the page is empty".
describe.skipIf(!CAN_SPAWN)('layout depth note', () => {
  const CONTAINERS_ONLY = [
    '[0,0,1320,2856]',
    '  root [0,137,1320,2856]',
    '    window [0,137,1320,2856]',
  ].join('\n')

  it('explains a textless shallow dump instead of letting it read as empty', async () => {
    process.env.DSH_FAKE_LAYOUT_FIRST = CONTAINERS_ONLY
    process.env.DSH_FAKE_LAYOUT_LATER = CONTAINERS_ONLY
    const emuUi = mountTools()
    const result = await emuUi.execute({ action: 'layout', full: true, depth: 3 }, exec)
    expect(result.total).toBe(3)
    expect(result.page).toBeNull()
    expect(result.note).toContain('depth:0')
    expect(result.note).toContain('full')
  })

  it('stays quiet when the dump has text, and when depth is unlimited', async () => {
    const withText = await mountTools().execute({ action: 'layout', depth: 3 }, exec)
    expect(withText.note).toBeUndefined()

    process.env.DSH_FAKE_LAYOUT_FIRST = CONTAINERS_ONLY
    process.env.DSH_FAKE_LAYOUT_LATER = CONTAINERS_ONLY
    const unlimited = await mountTools().execute({ action: 'layout', depth: 0 }, exec)
    expect(unlimited.note).toBeUndefined()
  })
})

// `keep:false` without `read` has nothing to hand over: the file is deleted and no path returned.

// "no title on this screen" and "the field is not there" must not look identical.
describe.skipIf(!CAN_SPAWN)('page field', () => {
  it('is always present, null when the tree has no title', async () => {
    // The only text sits deep in the tree — exactly the shape `pageTitle` refuses to guess from.
    process.env.DSH_FAKE_LAYOUT_FIRST = [
      '[0,0,1320,2856]',
      '  Column [0,0,1320,2856]',
      '    Row [0,0,1320,2856]',
      '      Text [10,10,90,90] "zzz"',
    ].join('\n')
    process.env.DSH_FAKE_LAYOUT_LATER = process.env.DSH_FAKE_LAYOUT_FIRST
    const emuUi = mountTools()
    const bare = await emuUi.execute({ action: 'layout' }, exec)
    expect(bare.page).toBeNull()
    const clicked = await emuUi.execute({ action: 'click', x: 5, y: 5 }, exec)
    expect(clicked.page).toBeNull()
  })

  it('still reports the title when there is one', async () => {
    // The title comes from the `NavDestination` subtree (the shape the real dumps have).
    process.env.DSH_FAKE_LAYOUT_FIRST = [
      '[0,0,1320,2856]',
      '  Navigation [0,137,1320,2856]',
      '    NavDestination [0,137,1320,2856]',
      '      Text [140,190,1096,264] "Sample title"',
    ].join('\n')
    process.env.DSH_FAKE_LAYOUT_LATER = process.env.DSH_FAKE_LAYOUT_FIRST
    const emuUi = mountTools()
    const result = await emuUi.execute({ action: 'layout' }, exec)
    expect(result.page).toBe('Sample title')
  })
})

// debugging an odd screen was `act → observe → hmos_log`.
describe.skipIf(!CAN_SPAWN)('observe with logs', () => {
  it('brings the log along when asked for', async () => {
    process.env.DSH_FAKE_LOG = '09-19 10:00:00.000  1000  1000 I A00000/TAG: hello'
    const emuUi = mountTools()
    const result = await emuUi.execute({ action: 'observe', log: { keyword: 'TAG' } }, exec)
    expect(result.ok).toBe(true)
    expect(result.tree).toContain('Page title')
    expect(result.log.count).toBe(1)
    expect(result.log.lines[0]).toMatchObject({ level: 'I', tag: 'TAG', message: 'hello' })
  })

})

// A delivered capture is not deleted by itself: only `keep:false` removes it.
describe.skipIf(!CAN_SPAWN)('emu_ui screenshot keep', () => {
  const shotDir = () => join(dir, 'screenshots')
  const shots = () => (existsSync(shotDir()) ? readdirSync(shotDir()).length : 0)

  it('deletes a plain capture again once it has been delivered', async () => {
    const emuUi = mountTools()
    const args = { action: 'screenshot', root: dir, read: true, keep: false }
    const value = await emuUi.execute(args, exec)
    expect(value.ok).toBe(true)
    expect(value.discarded).toBe(true)
    expect(value.path).toBeUndefined()
    expect(value.image).toMatchObject({ attachmentId: 'sha256:fake' })
    expect(shots()).toBe(0)
  })

  it('keeps the file by default, and keeps it when the image could not be attached', async () => {
    const emuUi = mountTools()
    const kept = await emuUi.execute({ action: 'screenshot', root: dir }, exec)
    expect(kept.path).toBeTruthy()
    expect(shots()).toBe(1)

    const noStore = mountTools({ attachments: false })
    const value = await noStore.execute({ action: 'screenshot', root: dir, read: true, keep: false }, exec)
    expect(value.path).toBeTruthy()
    expect(value.imageUnavailable).toBeTruthy()
    expect(value.keepFailed).toBeTruthy()
    expect(shots()).toBe(2)
  })
})

// Hand-taken shots must never be auto-deleted. The tool takes far more captures than the
// failure paths do, so it needs a cap of its own — and that cap is only defensible because the file
// name records who wrote it: `tool-*` is the tool's, `hmos-shot-*` is the panel's, i.e. the user's.
describe.skipIf(!CAN_SPAWN)('emu_ui screenshot ownership', () => {
  it('names its captures tool-*, and never the panel\'s hmos-shot-*', async () => {
    const emuUi = mountTools()
    const value = await emuUi.execute({ action: 'screenshot', root: dir }, exec)
    expect(value.ok).toBe(true)
    expect(basename(value.path).startsWith('tool-')).toBe(true)
    // `observe {read:true}` composes the same action, so it must be owned the same way.
    const seen = await emuUi.execute({ action: 'observe', read: true, root: dir }, exec)
    expect(basename(seen.path).startsWith('tool-')).toBe(true)
  })
})

// a relative `projectPath` resolves against the session workspace, never the host process cwd
// (wherever `dsh web` started): resolving it there points nowhere and surfaces as a message about
describe.skipIf(!CAN_SPAWN)('projectPath resolution', () => {
  it('resolves a relative path against the session workspace and says where it looked', async () => {
    // It exists but is not a project root: the answer must name the directory it searched, instead
    // of leaving the caller to guess where a relative path was resolved.
    mkdirSync(join(dir, 'not-a-project'), { recursive: true })
    const lint = mountAll().find((def) => def.name === 'hmos_lint')
    const result = await lint.execute({ projectPath: 'not-a-project' }, exec)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('build-profile.json5')
    expect(result.error).toContain(join(dir, 'not-a-project'))
  })

  it('accepts a project directory that really has build-profile.json5', async () => {
    mkdirSync(join(dir, 'proj'), { recursive: true })
    writeFileSync(join(dir, 'proj', 'build-profile.json5'), '{ "modules": [{ "name": "entry" }] }')
    const lint = mountAll().find((def) => def.name === 'hmos_lint')
    const result = await lint.execute({ projectPath: 'proj' }, exec)
    expect(result.error ?? '').not.toContain('未找到')
  })
})

