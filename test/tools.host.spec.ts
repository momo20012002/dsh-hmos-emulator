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
import { decodePng, encodePng } from '../lib/index.js'
import { mountPlugin } from './harness.js'

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
  const attachmentService = attachments
    ? {
        saveImage: async (input) => {
          savedImages.push(input)
          return { attachmentId: 'sha256:fake', mediaType: input.mediaType, bytes: input.data.length, width: 1320, height: 2856, name: input.name }
        },
      }
    : undefined
  return mountPlugin({ attachments: attachmentService }).tools
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
  for (const key of ['DSH_FAKE_INSTANCES', 'DSH_FAKE_STATE', 'DSH_FAKE_ARGV_LOG', 'DSH_FAKE_PNG_B64', 'DSH_FAKE_LOG', 'DSH_FAKE_LAYOUT_FIRST', 'DSH_FAKE_LAYOUT_LATER', 'DSH_FAKE_BUILD', 'DSH_FAKE_BUILD_CODE']) delete process.env[key]
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

  it('reads a module list whose trailing comma is followed by a comment', async () => {
    // Real project files carry both. The trailing-comma lookahead runs before comments are stripped, so it
    // has to skip them too — otherwise the whole configuration reads as unparsable and the list comes back
    // empty, which the panel shows as a project with no modules.
    mkdirSync(join(dir, 'proj3'), { recursive: true })
    writeFileSync(join(dir, 'proj3', 'build-profile.json5'), '{ "modules": [ { "name": "entry" }, /* added later */ ] }')
    const deploy = mountAll().find((def) => def.name === 'hmos_deploy')
    const accepted = await deploy.execute({ projectPath: 'proj3', buildOnly: true, module: 'entry' }, exec)
    expect(accepted.ok).toBe(true)
    expect(accepted.note ?? '').not.toContain('未能从 build-profile.json5 读出模块名')
    // The decisive half: a name the project does not have is refused, which is only possible if the list was
    // actually read.
    const rejected = await deploy.execute({ projectPath: 'proj3', buildOnly: true, module: 'nope' }, exec)
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toContain('不属于该工程')
  })
})

// A failed build reaches the caller twice — the parsed errors and the tail — and hvigor writes
// both inside colour frames. Its entry-list check also stops the build with a message that hides
// the page's own diagnostics, so the message has to carry that warning itself.
describe.skipIf(!CAN_SPAWN)('deploy failure output', () => {
  it('strips the colour frames and explains the page-missing message', async () => {
    mkdirSync(join(dir, 'proj3'), { recursive: true })
    writeFileSync(join(dir, 'proj3', 'build-profile.json5'), '{ "modules": [{ "name": "entry" }] }')
    process.env.DSH_FAKE_BUILD = [
      '\u001b[31m10906403 ArkTS Compiler Error',
      "Error Message: Page 'C:/Temp/proj3/entry/src/main/ets/pages/Gone.ets' does not exist. \u001b[39m",
      '\u001b[32mBUILD FAILED\u001b[39m',
    ].join('\r\n')
    process.env.DSH_FAKE_BUILD_CODE = '1'
    const deploy = mountAll().find((def) => def.name === 'hmos_deploy')
    const result = await deploy.execute({ projectPath: 'proj3', buildOnly: true, module: 'entry' }, exec)
    delete process.env.DSH_FAKE_BUILD
    delete process.env.DSH_FAKE_BUILD_CODE
    expect(result.ok).toBe(false)
    expect(result.tail).not.toContain('\u001b')
    expect(result.tail).toContain('does not exist')
    expect(result.note).toContain('页面开始编译之前')
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

  it('does not call a check clean when the run produced no verdict', async () => {
    // This CLI uses a nonzero exit code to report findings as well, so `ok` cannot be read off the exit code
    // alone: a run that exited without parsing anything is stated as a failure, with its own message.
    mkdirSync(join(dir, 'proj'), { recursive: true })
    writeFileSync(join(dir, 'proj', 'build-profile.json5'), '{ "modules": [{ "name": "entry" }] }')
    process.env.DSH_FAKE_CHECK = 'linter: cannot start\n'
    process.env.DSH_FAKE_CHECK_CODE = '2'
    try {
      const lint = mountAll().find((def) => def.name === 'hmos_lint')
      const failed = await lint.execute({ projectPath: 'proj' }, exec)
      expect(failed.ok).toBe(false)
      expect(failed.error).toContain('代码检查未能完成')
    } finally {
      delete process.env.DSH_FAKE_CHECK
      delete process.env.DSH_FAKE_CHECK_CODE
    }
  })

  it('runs the other two project checks through the same tool', async () => {
    // kind=arkts / kind=compat are the checks `check` also offers on the same subject, so they ride this
    // tool rather than becoming tools of their own: a caller already holds this one.
    mkdirSync(join(dir, 'proj'), { recursive: true })
    writeFileSync(join(dir, 'proj', 'build-profile.json5'), '{ "modules": [{ "name": "entry" }] }')
    const argvLog = join(dir, 'check-argv.log')
    process.env.DSH_FAKE_ARGV_LOG = argvLog
    const lint = mountAll().find((def) => def.name === 'hmos_lint')
    const arkts = await lint.execute({ projectPath: 'proj', kind: 'arkts', fix: true }, exec)
    expect(arkts.ok).toBe(true)
    expect(arkts.kind).toBe('arkts')
    expect(readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      ['check', 'arkts', '--project', join(dir, 'proj'), '--fix'],
    ])
    // `--fix` is the linter's own repair pass too — the same one the panel's "代码修复" button runs.
    const fixed = await lint.execute({ projectPath: 'proj', fix: true }, exec)
    expect(fixed.ok).toBe(true)
    const fixedLines = readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    // The fixture is not a git project, so `scope: changed` escalates to a full check — hence no
    // `--incremental`. That escalation is the documented answer to "incremental would inspect nothing".
    expect(fixedLines[fixedLines.length - 1]).toEqual(['check', 'lint', join(dir, 'proj'), '--fix'])
    // An unknown kind is refused instead of quietly becoming a lint run — with `fix:true` that would have
    // rewritten the project's files before anyone could tell. No spawn at all is the proof.
    const typo = await lint.execute({ projectPath: 'proj', kind: 'nonsense', fix: true }, exec)
    expect(typo.ok).toBe(false)
    expect(typo.error).toContain('lint, arkts or compat')
    expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toHaveLength(fixedLines.length)
    // The lint branch names itself too, so a caller can tell which check answered. `scope` has the same
    // shape: an unknown value is refused rather than quietly becoming `changed`.
    expect((await lint.execute({ projectPath: 'proj' }, exec)).kind).toBe('lint')
    expect((await lint.execute({ projectPath: 'proj', scope: 'nonsense' }, exec)).error).toContain('changed or all')
    // A compat call without the two versions answers with the list the CLI accepts, not a complaint.
    const missing = await lint.execute({ projectPath: 'proj', kind: 'compat' }, exec)
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('sourceVersion')
    expect(missing.versions).toContain('6.1.1(24)')
    const compat = await lint.execute({ projectPath: 'proj', kind: 'compat', sourceVersion: '5.0.0(12)', targetVersion: '6.1.1(24)' }, exec)
    expect(compat.ok).toBe(true)
    expect(compat.targetVersion).toBe('6.1.1(24)')
    delete process.env.DSH_FAKE_ARGV_LOG
  })
})

// The once-per-project jobs: scaffolding, signing and the two instance verbs. They are rare enough to
// live in a tool of their own, so the argv each one builds is the thing worth pinning down.
describe.skipIf(!CAN_SPAWN)('hmos_log', () => {
  const logTool = () => mountAll().find((def) => def.name === 'hmos_log')

  /**
   * Set fakes for one case and put the previous values back afterwards. The harness seeds some of these for
   * the whole file (DSH_FAKE_INSTANCES among them), so deleting them would starve every case that follows.
   */
  const withFakes = async (vars: Record<string, string | undefined>, run: () => Promise<void>) => {
    const saved = Object.keys(vars).map((key) => [key, process.env[key]] as const)
    for (const [key, value] of Object.entries(vars)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    try { await run() } finally {
      for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }

  it('reads from the start of the buffer when asked for the earliest lines', async () => {
    // `--tail` means the newest N of whatever window it is given, so the start of the buffer is only
    // reachable by asking for no window at all and keeping the head of the answer. The filler is what proves
    // the tail was not what came back.
    const filler = Array.from({ length: 4000 }, (_, i) => `10-13 00:00:0${i % 10}.000     1     1 I A/B: filler line ${i} ................`)
    await withFakes({
      DSH_FAKE_ARGV_LOG: join(dir, 'log-early-argv.log'),
      DSH_FAKE_INSTANCES: '[{"name":"Pura 90","status":"running","serial":"127.0.0.1:5555"}]',
      DSH_FAKE_LOG: [
        '10-12 23:11:57.392     0     0 I I00000/HiLog: ========Zeroth log of type: init',
        ...filler,
      ].join('\n'),
    }, async () => {
      const r = await logTool().execute({ since: 'earliest', tail: 2 }, exec)
      expect(r.ok).toBe(true)
      expect(r.fromStart).toBe(true)
      expect(r.lines).toHaveLength(2)
      expect(String(r.lines[0].message)).toContain('Zeroth log of type: init')
      expect(String(r.lines[1].message)).toContain('filler line 0')
      expect(JSON.stringify(r.lines)).not.toContain('filler line 3999')
      // No `--tail` and no `--from`: the CLI is asked for the buffer itself.
      const argvLines = readFileSync(process.env.DSH_FAKE_ARGV_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(argvLines[argvLines.length - 1]).toEqual(['log', '--device', '127.0.0.1:5555'])
    })
  })

  it('keeps the newest lines of a window, as it did before', async () => {
    // The ordinary read is unchanged: a window, `--tail`, and the newest N of that window.
    await withFakes({
      DSH_FAKE_ARGV_LOG: join(dir, 'log-window-argv.log'),
      DSH_FAKE_INSTANCES: '[{"name":"Pura 90","status":"running","serial":"127.0.0.1:5555"}]',
      DSH_FAKE_LOG: '10-13 00:00:01.000     1     1 I A/B: one\n10-13 00:00:02.000     1     1 I A/B: two',
    }, async () => {
      const r = await logTool().execute({ since: '5m', tail: 10 }, exec)
      expect(r.ok).toBe(true)
      expect(r.fromStart).toBeUndefined()
      expect(String(r.lines[r.lines.length - 1].message)).toContain('two')
      const argvLines = readFileSync(process.env.DSH_FAKE_ARGV_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(argvLines[argvLines.length - 1]).toEqual(['log', '--device', '127.0.0.1:5555', '--tail', '10', '--from', '5m'])
    })
  })
  it('strips the CLI colour from what it hands back', async () => {
    // Measured: the CLI wraps its own banner and error text in ANSI escapes (`No active devices found` comes
    // back red). This output goes to a model, so the escapes are stripped here the way `emu` strips its own.
    await withFakes({
      DSH_FAKE_INSTANCES: '[{"name":"Pura 90","status":"running","serial":"127.0.0.1:5555"}]',
      DSH_FAKE_LOG: '\u001b[31mred banner\u001b[39m\n10-13 00:00:02.000     1     1 I A/B: two',
    }, async () => {
      const r = await logTool().execute({ raw: true, tail: 5 }, exec)
      expect(r.ok).toBe(true)
      expect(JSON.stringify(r)).not.toContain('\u001b')
    })
  })
})

describe.skipIf(!CAN_SPAWN)('hmos_setup', () => {
  const setup = () => mountAll().find((def) => def.name === 'hmos_setup')
  const argvLines = () => readFileSync(process.env.DSH_FAKE_ARGV_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line))

  it('scaffolds an app, signs a project, and creates an instance', async () => {
    const argvLog = join(dir, 'setup-argv.log')
    process.env.DSH_FAKE_ARGV_LOG = argvLog
    try {
      const scaffolded = await setup().execute({ action: 'app', appName: 'Demo', apiLevel: 21 }, exec)
      expect(scaffolded.ok).toBe(true)
      expect(argvLines()[0]).toEqual(['create', '--app-name', 'Demo', '--api-level', '21'])
      // `signature generate` has no --project: it signs the project it is standing in.
      mkdirSync(join(dir, 'signme'), { recursive: true })
      writeFileSync(join(dir, 'signme', 'build-profile.json5'), '{}')
      const signed = await setup().execute({ action: 'sign', projectPath: 'signme', force: true }, exec)
      expect(signed.ok).toBe(true)
      expect(argvLines()[1]).toEqual(['signature', 'generate', '--force'])
      const created = await setup().execute({ action: 'create-instance', name: 'Pura X View', deviceType: 'foldable', osVersion: 'HarmonyOS 6.0.1(21)' }, exec)
      expect(created.ok).toBe(true)
      expect(argvLines()[2]).toEqual([
        'emulator', 'create', 'Pura X View', '--device-type', 'foldable', '--os-version', 'HarmonyOS 6.0.1(21)',
      ])
    } finally {
      delete process.env.DSH_FAKE_ARGV_LOG
    }
  })

  it('names the missing login when a signature fails without an account', async () => {
    // Without an account `signature generate` cannot write signing materials, and its own output does not say
    // so. The failure carries the login state and the command that fixes it, so the caller needs no second
    // question — and the account is asked about only after the failure, never on the happy path.
    mkdirSync(join(dir, 'nosign'), { recursive: true })
    writeFileSync(join(dir, 'nosign', 'build-profile.json5'), '{}')
    const argvLog = join(dir, 'nosign-argv.log')
    process.env.DSH_FAKE_ARGV_LOG = argvLog
    process.env.DSH_FAKE_SIGN = 'Error: no certificate available\n'
    process.env.DSH_FAKE_SIGN_CODE = '1'
    // The CLI prints this and still exits 0, which is exactly why the exit code is not the signal.
    process.env.DSH_FAKE_AUTH = 'Not logged in\n'
    try {
      const failed = await setup().execute({ action: 'sign', projectPath: 'nosign' }, exec)
      expect(failed.ok).toBe(false)
      expect(failed.signedIn).toBe(false)
      expect(failed.error).toContain('devecocli auth login')
      expect(argvLines().map((line) => line.slice(0, 2))).toEqual([['signature', 'generate'], ['auth', 'status']])
    } finally {
      delete process.env.DSH_FAKE_ARGV_LOG
      delete process.env.DSH_FAKE_SIGN
      delete process.env.DSH_FAKE_SIGN_CODE
      delete process.env.DSH_FAKE_AUTH
      delete process.env.DSH_FAKE_AUTH_CODE
    }
  })

  it('does not blame the account when the login state could not be read', async () => {
    // The extra read is what turns a bare "signature failed" into a diagnosis; when that read itself fails the
    // cause stays open, so neither the account nor its fix may be named.
    mkdirSync(join(dir, 'nosign2'), { recursive: true })
    writeFileSync(join(dir, 'nosign2', 'build-profile.json5'), '{}')
    process.env.DSH_FAKE_SIGN = 'Error: no certificate available\n'
    process.env.DSH_FAKE_SIGN_CODE = '1'
    process.env.DSH_FAKE_AUTH_CODE = '1'
    try {
      const failed = await setup().execute({ action: 'sign', projectPath: 'nosign2' }, exec)
      expect(failed.ok).toBe(false)
      expect(failed.signedIn).toBe(null)
      expect(failed.error).not.toContain('未登录华为开发者账号')
      expect(failed.error).toContain('未能确认登录状态')
    } finally {
      delete process.env.DSH_FAKE_SIGN
      delete process.env.DSH_FAKE_SIGN_CODE
      delete process.env.DSH_FAKE_AUTH_CODE
    }
  })

  it('asks for a release build, a named ability and a fresh install when told to', async () => {
    // Three flags the CLI has: they are the difference between a debug artifact and a shipped one, and
    // between launching the entry ability and a named one.
    mkdirSync(join(dir, 'rel'), { recursive: true })
    writeFileSync(join(dir, 'rel', 'build-profile.json5'), '{"modules":[{"name":"entry"}]}')
    const argvLog = join(dir, 'rel-argv.log')
    process.env.DSH_FAKE_ARGV_LOG = argvLog
    try {
      const deploy = mountAll().find((def) => def.name === 'hmos_deploy')
      const built = await deploy.execute({ projectPath: 'rel', buildOnly: true, buildMode: 'release' }, exec)
      expect(built.ok).toBe(true)
      const ran = await deploy.execute({ projectPath: 'rel', device: 'emulator-5554', skipBuild: true, ability: 'EntryAbility', uninstall: true }, exec)
      expect(ran.ok).toBe(true)
      const lines = readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      // The flags are echoed back: without that a release build and a debug one look identical.
      expect(built.buildMode).toBe('release')
      expect(ran.buildMode).toBe('debug')
      expect(ran.ability).toBe('EntryAbility')
      expect(ran.uninstall).toBe(true)
      expect(lines[0]).toEqual(['build', '--build-mode', 'release', '--modules', 'entry'])
      expect(lines[1]).toEqual([
        'run', '--device', 'emulator-5554', '--module', 'entry', '--ability', 'EntryAbility', '--uninstall', '--skip-build',
      ])
      // A mode the CLI does not have is refused here rather than after a build.
      expect((await deploy.execute({ projectPath: 'rel', buildOnly: true, buildMode: 'fast' }, exec)).error)
        .toContain('debug or release')
    } finally {
      delete process.env.DSH_FAKE_ARGV_LOG
    }
  })

  it('answers a missing name or app name before spawning anything', async () => {
    const noApp = await setup().execute({ action: 'app' }, exec)
    expect(noApp.ok).toBe(false)
    expect(noApp.error).toContain('appName')
    const noName = await setup().execute({ action: 'delete-instance' }, exec)
    expect(noName.ok).toBe(false)
    expect(noName.error).toContain('name')
    expect((await setup().execute({ action: 'nonsense' }, exec)).error).toContain('unknown action')
  })
})

// The window list is what every window-scoped action needs before it can name a window.
describe.skipIf(!CAN_SPAWN)('emu_ui windows', () => {
  it('lists the device windows, so a window id never has to be guessed', async () => {
    process.env.DSH_FAKE_WINDOWS = '[{"id":1,"name":"EntryAbility"},{"id":2,"name":"GlobalSearch"}]'
    try {
      const ui = mountAll().find((def) => def.name === 'emu_ui')
      const result = await ui.execute({ action: 'windows', device: 'emulator-5554' }, exec)
      expect(result.ok).toBe(true)
      expect(result.action).toBe('windows')
      expect(result.windows).toHaveLength(2)
      expect(result.windows[1].name).toBe('GlobalSearch')
    } finally {
      delete process.env.DSH_FAKE_WINDOWS
    }
  })
})

// The emulator controls are one verb each, and the only thing the caller can check without a device
// is the argv: which verb, which target, which injected value. Every case asserts that, because the
// failure mode worth catching is not "the CLI is broken" but "we asked it for the wrong thing".
describe.skipIf(!CAN_SPAWN)('emu controls', () => {
  const argvLines = () => readFileSync(process.env.DSH_FAKE_ARGV_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const lastArgv = () => argvLines()[argvLines().length - 1]
  const emu = () => mountAll().find((def) => def.name === 'emu')

  afterEach(() => {
    delete process.env.DSH_FAKE_EMU
    delete process.env.DSH_FAKE_EMU_CODE
  })

  it('lists the instances the CLI reports alongside its own notices', async () => {
    // Measured: the CLI appends a version notice after its JSON (`New version 1.3.5 available` on 1.3.4), and
    // that trailing line made the whole output unparseable — so this list came back empty on a real machine
    // while the clean-JSON fixture kept the tests green.
    const saved = process.env.DSH_FAKE_INSTANCES
    process.env.DSH_FAKE_INSTANCES = '[\n  {"name":"Pura 90","status":"running","serial":"127.0.0.1:5555","deviceType":"phone","osVersion":"HarmonyOS 6.1.1(24)"}\n]\n\nNew version 1.3.5 available, run `devecocli update` to upgrade\n'
    try {
      const result = await emu().execute({ action: 'list' }, exec)
      expect(result.ok).toBe(true)
      expect(result.instances).toEqual([
        { name: 'Pura 90', status: 'running', serial: '127.0.0.1:5555', osVersion: 'HarmonyOS 6.1.1(24)' },
      ])
    } finally {
      if (saved === undefined) delete process.env.DSH_FAKE_INSTANCES
      else process.env.DSH_FAKE_INSTANCES = saved
    }
  })

  it('rotates a running instance with the direction it was given', async () => {
    const result = await emu().execute({ action: 'rotate', name: 'Pixel', direction: 'left' }, exec)
    expect(result.ok).toBe(true)
    expect(lastArgv()).toEqual(['emulator', 'rotate', '--target', 'Pixel', 'left'])
  })

  it('sets a folded shape and a motion scene as the verbs name them', async () => {
    // Both take a value, so the value is the last argv entry. `fold`'s accepted shapes depend on the
    // device model — the CLI prints its own mapping on a bad one — while `scene`'s three are fixed.
    const folded = await emu().execute({ action: 'fold', name: 'Pixel', state: 'half-open' }, exec)
    expect(folded.ok).toBe(true)
    expect(lastArgv()).toEqual(['emulator', 'fold', '--target', 'Pixel', 'half-open'])
    const moving = await emu().execute({ action: 'scene', name: 'Pixel', type: 'drivingNavigation' }, exec)
    expect(moving.ok).toBe(true)
    expect(lastArgv()).toEqual(['emulator', 'scene', '--target', 'Pixel', 'drivingNavigation'])
    // The value is the action's whole meaning, so a missing one is answered here, before a spawn.
    const empty = await emu().execute({ action: 'fold', name: 'Pixel' }, exec)
    expect(empty.ok).toBe(false)
    expect(empty.error).toContain('state')
  })

  it('refuses a control without the value that gives it meaning, before spawning anything', async () => {
    const noDirection = await emu().execute({ action: 'volume', name: 'Pixel' }, exec)
    expect(noDirection.ok).toBe(false)
    expect(noDirection.error).toContain('direction is required')
    // Each verb accepts its own two choices, not the union: `volume left` is a CLI error otherwise.
    const crossed = await emu().execute({ action: 'volume', name: 'Pixel', direction: 'left' }, exec)
    expect(crossed.ok).toBe(false)
    expect(crossed.error).toContain('up|down')
    const emptyBattery = await emu().execute({ action: 'battery', name: 'Pixel' }, exec)
    expect(emptyBattery.ok).toBe(false)
    expect(emptyBattery.error).toContain('level')
    const emptyGeo = await emu().execute({ action: 'geolocation', name: 'Pixel' }, exec)
    expect(emptyGeo.ok).toBe(false)
    expect(emptyGeo.error).toContain('longitude')
    // Nothing was asked of the CLI: the log file was never created.
    expect(existsSync(process.env.DSH_FAKE_ARGV_LOG)).toBe(false)
  })

  it('maps a partial geolocation onto the flags the CLI names, heading included', async () => {
    const result = await emu().execute({ action: 'geolocation', name: 'Pixel', latitude: 31.23, longitude: 121.47, heading: 90 }, exec)
    expect(result.ok).toBe(true)
    expect(lastArgv()).toEqual([
      'emulator', 'geolocation', '--target', 'Pixel',
      '--longitude', '121.47', '--latitude', '31.23', '--direction', '90',
    ])
  })

  it('targets the running instance when a control is given no name', async () => {
    // `name` is optional in the schema and both sibling tools already default to the running instance.
    const result = await emu().execute({ action: 'rotate', direction: 'left' }, exec)
    expect(result.ok).toBe(true)
    expect(lastArgv()[0]).toBe('emulator')
    expect(lastArgv().slice(0, 4)).toEqual(['emulator', 'rotate', '--target', lastArgv()[3]])
    expect(lastArgv()[4]).toBe('left')
  })

  it('fails a stop whose instance does not exist instead of reporting success', async () => {
    // `emulator stop <unknown>` exits 0 without touching anything: the list is what decides.
    const saved = process.env.DSH_FAKE_INSTANCES
    process.env.DSH_FAKE_INSTANCES = '[]'
    try {
      const result = await emu().execute({ action: 'stop', name: 'NoSuchInst' }, exec)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('NoSuchInst')
    } finally {
      process.env.DSH_FAKE_INSTANCES = saved
    }
  })

  it('strips colour frames from what a failing control reports', async () => {
    process.env.DSH_FAKE_EMU = '\u001b[31m--level must be in [0, 100].\u001b[39m'
    process.env.DSH_FAKE_EMU_CODE = '1'
    const result = await emu().execute({ action: 'battery', name: 'Pixel', level: 50 }, exec)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('--level must be in [0, 100].')
    expect(result.error).not.toContain('\u001b')
  })

  it('rejects a number it cannot read instead of injecting half a position', async () => {
    // `latitude: 'abc'` used to look like "latitude not given", so the call injected only longitude
    // and reported success: a wrong position with a green result.
    const result = await emu().execute({ action: 'geolocation', name: 'Pixel', longitude: 121.4, latitude: 'abc' }, exec)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('latitude')
    expect(existsSync(process.env.DSH_FAKE_ARGV_LOG)).toBe(false)
  })

  it('presses power without needing a value', async () => {
    const result = await emu().execute({ action: 'power', name: 'Pixel' }, exec)
    expect(result.ok).toBe(true)
    expect(lastArgv()).toEqual(['emulator', 'power', '--target', 'Pixel'])
  })

  it('answers an unknown action before asking for a name', async () => {
    const result = await emu().execute({ action: 'rotatee' }, exec)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('unknown action')
  })

  it('passes the version gate through in the CLI words rather than inventing one', async () => {
    process.env.DSH_FAKE_EMU = 'Emulator scene control commands require Emulator 7.0 or later.'
    process.env.DSH_FAKE_EMU_CODE = '1'
    const result = await emu().execute({ action: 'shake', name: 'Pixel' }, exec)
    expect(result.ok).toBe(false)
    expect(result.code).toBe(1)
    expect(result.error).toContain('Emulator 7.0 or later')
  })
})

// `build clean` and a narrowed `--modules` are the two build options whose value is entirely in the
// argv: clean must not touch a device, and a narrowed build must name every module it was given.
describe.skipIf(!CAN_SPAWN)('deploy clean and module selection', () => {
  const argvLines = () => readFileSync(process.env.DSH_FAKE_ARGV_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const lastArgv = () => argvLines()[argvLines().length - 1]
  const project = (name, modules = 'entry') => {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, 'build-profile.json5'), `{ "modules": [${modules.split(',').map((m) => `{ "name": "${m}" }`).join(', ')}] }`)
    return name
  }

  it('cleans build outputs without needing a running device', async () => {
    // No DSH_FAKE_DEVICES is set in this file, so a device check would fail — clean has to skip it.
    const result = await mountAll().find((def) => def.name === 'hmos_deploy')
      .execute({ projectPath: project('clean-proj'), action: 'clean' }, exec)
    expect(result.ok).toBe(true)
    expect(result.phase).toBe('clean')
    expect(lastArgv()).toEqual(['build', 'clean'])
  })

  it('builds every module it was given, in the order given', async () => {
    const result = await mountAll().find((def) => def.name === 'hmos_deploy')
      .execute({ projectPath: project('multi', 'entry,feature'), modules: ['feature', 'entry'], buildOnly: true }, exec)
    expect(result.ok).toBe(true)
    expect(result.modules).toEqual(['feature', 'entry'])
    const build = argvLines().find((a) => a[0] === 'build')
    expect(build).toEqual(['build', '--modules', 'feature', 'entry'])
  })

  it('still accepts the single module name older prompts send', async () => {
    const result = await mountAll().find((def) => def.name === 'hmos_deploy')
      .execute({ projectPath: project('legacy'), module: 'entry', buildOnly: true }, exec)
    expect(result.ok).toBe(true)
    expect(result.modules).toEqual(['entry'])
  })

  it('says which module a full deploy narrowed a multi-module request to', async () => {
    // The full deploy path goes through the host API, which checks the device is online first — so
    // this case needs one, unlike `clean`.
    process.env.DSH_FAKE_DEVICES = '["127.0.0.1:5555"]'
    try {
      const result = await mountAll().find((def) => def.name === 'hmos_deploy')
        .execute({ projectPath: project('narrow', 'entry,feature'), modules: ['entry', 'feature'], device: '127.0.0.1:5555' }, exec)
      expect(result.modules).toEqual(['entry', 'feature'])
      expect(result.note).toContain('只构建第一个模块')
    } finally {
      delete process.env.DSH_FAKE_DEVICES
    }
  })

  it('does not name the hap a failed build left behind', async () => {
    // A failure leaves the previous build's hap in the standard output directory, so a path would read
    // as "this call produced that file". The stale file is planted here, or the case proves nothing.
    project('nohap')
    const stale = join(dir, 'nohap', 'entry', 'build', 'default', 'outputs', 'default')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'entry-default-unsigned.hap'), 'stale-hap')
    process.env.DSH_FAKE_BUILD = 'COMPILE RESULT:FAIL\n> hvigor ERROR: BUILD FAILED'
    process.env.DSH_FAKE_BUILD_CODE = '1'
    const result = await mountAll().find((def) => def.name === 'hmos_deploy')
      .execute({ projectPath: 'nohap', modules: ['entry'], buildOnly: true }, exec)
    delete process.env.DSH_FAKE_BUILD
    delete process.env.DSH_FAKE_BUILD_CODE
    expect(result.ok).toBe(false)
    expect(result.error).toContain('BUILD FAILED')
    expect(result.hapPath).toBeUndefined()
  })

  it('rejects an action it does not have instead of deploying anyway', async () => {
    // A misspelt action used to fall through to the deploy branch, which builds and installs for
    // real: an unknown word must not have a side effect.
    const result = await mountAll().find((def) => def.name === 'hmos_deploy')
      .execute({ projectPath: project('typo'), action: 'cleen', buildOnly: true }, exec)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('unknown action')
    expect(existsSync(process.env.DSH_FAKE_ARGV_LOG)).toBe(false)
  })

  it('rejects a module the project really lacks, naming the ones it has', async () => {
    const result = await mountAll().find((def) => def.name === 'hmos_deploy')
      .execute({ projectPath: project('bad'), modules: ['entry', 'nope'], buildOnly: true }, exec)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('nope')
    expect(result.error).toContain('entry')
  })

  it('accepts the module@target form as the module it names', async () => {
    // The CLI documents `module@target` for targeting a build, so the guard judges the module the spec names
    // while the whole spec is what travels to the CLI.
    const result = await mountAll().find((def) => def.name === 'hmos_deploy')
      .execute({ projectPath: project('targeted'), modules: ['entry@phone'], buildOnly: true }, exec)
    expect(result.error ?? '').not.toContain('不属于该工程')
  })
})

// The device verbs take no project: a device, and for a transfer the two ends of it. The local end
// resolves against the session workspace for the same reason `projectPath` does — that is the
// directory the caller can see — and a download makes its own directory while an upload refuses a
// path that is not there.
describe.skipIf(!CAN_SPAWN)('hmos_device', () => {
  const argvLines = () => readFileSync(process.env.DSH_FAKE_ARGV_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const lastArgv = () => argvLines()[argvLines().length - 1]
  const device = () => mountAll().find((def) => def.name === 'hmos_device')
  const DEVICES = '["127.0.0.1:5555"]'

  beforeEach(() => { process.env.DSH_FAKE_DEVICES = DEVICES })
  afterEach(() => {
    delete process.env.DSH_FAKE_DEVICES
    delete process.env.DSH_FAKE_DEVICE_VIEW
    delete process.env.DSH_FAKE_DEVICE_VIEW_CODE
    delete process.env.DSH_FAKE_DEVICE_OUT
    delete process.env.DSH_FAKE_DEVICE_CODE
  })

  it('answers the device detail as JSON, from the device it was told to use', async () => {
    process.env.DSH_FAKE_DEVICE_VIEW = JSON.stringify({ name: 'Pixel', serial: '127.0.0.1:5555', kind: 'emulator', deviceType: 'phone', osVersion: 'HarmonyOS 6.0.1' })
    const result = await device().execute({ action: 'view' }, exec)
    expect(result.ok).toBe(true)
    expect(result.info).toMatchObject({ serial: '127.0.0.1:5555', kind: 'emulator' })
    expect(lastArgv()).toEqual(['device', 'view', '-t', '127.0.0.1:5555', '--format', 'json'])
  })

  it('keeps a prose answer from view instead of reporting an empty success', async () => {
    // A view that did not print JSON is still an answer; an empty body would read as "nothing to say".
    process.env.DSH_FAKE_DEVICE_VIEW = 'No connected device found.'
    const result = await device().execute({ action: 'view' }, exec)
    expect(result.info).toBeUndefined()
    expect(result.output).toContain('No connected device found')
  })

  it('refuses an upload whose local file is not there, before asking the device', async () => {
    const result = await device().execute({ action: 'send', remote: '/data/local/tmp/x.db', local: 'missing.db' }, exec)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('local file not found')
    // The device lookup itself is a CLI call, so the assertion is that no transfer was asked for.
    expect(argvLines().some((a) => a[0] === 'device' && a[1] === 'file')).toBe(false)
  })

  it('sends a workspace-relative file as an absolute path, and receives into a directory it makes', async () => {
    writeFileSync(join(dir, 'app.db'), 'bytes')
    const sent = await device().execute({ action: 'send', remote: '/data/local/tmp/app.db', local: 'app.db' }, exec)
    expect(sent.ok).toBe(true)
    expect(lastArgv()).toEqual(['device', 'file', 'send', '--device', '127.0.0.1:5555', join(dir, 'app.db'), '/data/local/tmp/app.db'])

    // `nested/` does not exist yet: a download is allowed to be the thing that creates it.
    const got = await device().execute({ action: 'recv', remote: '/data/local/tmp/app.db', local: 'nested/app.db' }, exec)
    expect(got.ok).toBe(true)
    expect(got.local).toBe(join(dir, 'nested', 'app.db'))
    expect(existsSync(join(dir, 'nested'))).toBe(true)
    expect(lastArgv()).toEqual(['device', 'file', 'recv', '--device', '127.0.0.1:5555', '/data/local/tmp/app.db', join(dir, 'nested', 'app.db')])
  })

  it('runs a query as the words a shell would hand over, defaulting to a table list', async () => {
    process.env.DSH_FAKE_DEVICE_OUT = 'users\norders\n'
    const listed = await device().execute({ action: 'sqlite3', remote: '/data/app/db/base.db' }, exec)
    expect(listed.ok).toBe(true)
    expect(listed.output).toContain('users')
    expect(lastArgv()).toEqual(['device', 'sqlite3', '--device', '127.0.0.1:5555', '/data/app/db/base.db', '.tables'])

    const queried = await device().execute({ action: 'sqlite3', remote: '/data/app/db/base.db', sql: 'select count(*) from users' }, exec)
    expect(queried.ok).toBe(true)
    expect(lastArgv()).toEqual(['device', 'sqlite3', '--device', '127.0.0.1:5555', '/data/app/db/base.db', 'select', 'count(*)', 'from', 'users'])
  })

  it('normalizes a forward-slash drive path before the CLI joins it with its own cwd', async () => {
    // devecocli reads `E:/x` as relative and lands under `<cwd>\E:/x`; native separators are expected.
    if (process.platform !== 'win32') return
    const real = join(process.cwd(), 'package.json')
    const sent = await device().execute({ action: 'send', local: real.replace(/\\/g, '/'), remote: '/data/local/tmp/package.json' }, exec)
    expect(sent.ok).toBe(true)
    expect(lastArgv()).toEqual(['device', 'file', 'send', '--device', '127.0.0.1:5555', real, '/data/local/tmp/package.json'])
  })

  it('fails a database the device could not run, and strips colour from a failed transfer', async () => {
    // The transport exits 0 while the device-side shell rejects the words it was handed.
    process.env.DSH_FAKE_DEVICE_OUT = '/bin/sh: syntax error: unexpected ('
    const shell = await device().execute({ action: 'sqlite3', remote: '/data/app/db/base.db', sql: 'select count(*) from users' }, exec)
    expect(shell.ok).toBe(false)
    expect(shell.error).toContain('/bin/sh:')
    process.env.DSH_FAKE_DEVICE_OUT = 'Error: unable to open database "/data/app/db/base.db"'
    const missing = await device().execute({ action: 'sqlite3', remote: '/data/app/db/base.db' }, exec)
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('unable to open database')
    process.env.DSH_FAKE_DEVICE_OUT = '\u001b[31mno such file\u001b[39m'
    process.env.DSH_FAKE_DEVICE_CODE = '1'
    const failed = await device().execute({ action: 'recv', remote: '/data/local/tmp/x', local: 'x' }, exec)
    expect(failed.ok).toBe(false)
    expect(failed.error).not.toContain('\u001b')
    delete process.env.DSH_FAKE_DEVICE_OUT
    delete process.env.DSH_FAKE_DEVICE_CODE
  })

  it('keeps a device-shaped local path inside the workspace instead of the drive root', async () => {
    // On Windows a leading slash is absolute and `resolve` reads it against the current drive's root:
    // `recv` would write to `C:\data\x.db`. On POSIX the same string really is absolute, so the
    // assertion splits rather than pretending the two platforms agree.
    const got = await device().execute({ action: 'recv', remote: '/data/local/tmp/x.db', local: '/data/x.db' }, exec)
    expect(got.ok).toBe(true)
    expect(got.local).toBe(process.platform === 'win32' ? join(dir, 'data', 'x.db') : '/data/x.db')
  })

  it('reports a failed transfer with the fields a caller reads', async () => {
    process.env.DSH_FAKE_DEVICE_OUT = 'adb: device offline'
    process.env.DSH_FAKE_DEVICE_CODE = '1'
    const result = await device().execute({ action: 'sqlite3', remote: '/data/app/db/base.db', sql: '.tables' }, exec)
    expect(result.ok).toBe(false)
    expect(result.code).toBe(1)
    expect(result.timedOut).toBe(false)
    expect(result.error).toContain('device offline')
  })

  it('answers an unknown action before probing for a device', async () => {
    // No instance is running here, so a check that ran second would report "no running emulator" to a
    // caller whose mistake was the action — and would spend a spawn doing it.
    process.env.DSH_FAKE_INSTANCES = '[]'
    try {
      const result = await device().execute({ action: 'shell' }, exec)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('unknown action')
      expect(existsSync(process.env.DSH_FAKE_ARGV_LOG)).toBe(false)
    } finally {
      process.env.DSH_FAKE_INSTANCES = INSTANCES
    }
  })

  it('says there is no device instead of letting the CLI report one', async () => {
    // The running-serial lookup reads `emulator list`, so an empty instance list is what "no device"
    // means here — the device list is a different question.
    process.env.DSH_FAKE_INSTANCES = '[]'
    try {
      const result = await device().execute({ action: 'view' }, exec)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('no running emulator')
    } finally {
      process.env.DSH_FAKE_INSTANCES = INSTANCES
    }
  })
})

