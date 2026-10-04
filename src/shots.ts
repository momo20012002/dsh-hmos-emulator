import { basename, join } from 'node:path'
import { hostService } from './services.js'
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
/**
 * Screenshot ownership and retention (auto/tool/user prefixes) plus the attachment plumbing
 * that turns a capture on disk into a tool result: output schema, image block, render hook.
 */
/** Read a PNG as a data URL (panel preview); null on failure. */
export function readDataUrl(file) {
  try {
    return `data:image/png;base64,${readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}

/** Tool output is compact JSON (no indentation) to save tokens. */
export const TOOL_OUT_SCHEMA = { type: 'object', additionalProperties: true }

/**
 * One durable image block from a value's attachment reference, or undefined when that value
 * carries no image. The ref shape is checked rather than trusted: a half-built reference must not
 * produce a block the harness cannot resolve.
 */
export function imageBlockOf(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image)) return undefined
  if (typeof image.attachmentId !== 'string' || typeof image.mediaType !== 'string') return undefined
  return { type: 'image', attachment: { ...image } }
}

/**
 * Render a tool value as one text block, plus an image block when the call asked for the picture
 * itself (a screenshot that is only a path costs a second `read_image` round-trip per capture).
 * The block shape is the durable one the harness projects: `{type:'image', attachment: <ref>}` —
 * the `{data, mimeType}` form is the wire shape the harness builds from it, not a tool result.
 *
 * `steps` keeps its last step's result under `last`, so an image requested inside a batch has to be
 * found there too.
 */
export const toolRender = (_args, value) => {
  const blocks: any[] = [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  const block = imageBlockOf(record?.image) ?? imageBlockOf(record?.last?.image)
  if (block) blocks.push(block)
  return blocks
}

/**
 * Store a captured PNG through the harness attachment service so it can ride the same call as an
 * image block. Every failure (no attachment service, an image the deployment refuses) degrades to
 * the text-only answer: a picture is an optimization here, never the result of the call.
 */
export async function attachmentRefForImage(ctx, filePath) {
  try {
    const attachments = ctx && typeof ctx.get === 'function' ? hostService(ctx, 'attachments') : undefined
    if (!attachments || typeof attachments.saveImage !== 'function') return undefined
    const ref = await attachments.saveImage({ data: readFileSync(filePath), mediaType: 'image/png', name: basename(filePath) })
    if (!ref || typeof ref.attachmentId !== 'string') return undefined
    return {
      attachmentId: String(ref.attachmentId),
      mediaType: String(ref.mediaType || 'image/png'),
      bytes: Number(ref.bytes) || 0,
      width: Number(ref.width) || 0,
      height: Number(ref.height) || 0,
      ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
    }
  } catch {
    return undefined
  }
}

/** Prefix of every screenshot this plugin writes on its own initiative. */
export const AUTO_SHOT_PREFIX = 'auto-'
/**
 * Prefix of the captures the **model tools** write on their own initiative (`emu_ui screenshot`).
 * They are named apart from `hmos-shot-*` for one reason: only a file the plugin knows it created
 * may ever be pruned. The user's own shots go through the panel and keep the `hmos-shot-*` name, so
 * "never auto-delete a hand-taken shot" is enforced by the name, not by a heuristic.
 */
export const TOOL_SHOT_PREFIX = 'tool-'

/**
 * How many captures of one owned prefix are kept — both pruned prefixes share this number.
 *
 * A capture is a full-screen PNG (1320x2856, ~2.4 MB on this emulator), so the count *is* the disk
 * bound: 40 ≈ 96 MB per prefix, ~192 MB for the two together. A fixed count is what keeps the
 * directory from growing without bound.
 *
 * One capture costs ~1.6 s, so a burst of 20 screenshots (~35 s) would evict a deliberate shot taken
 * a minute earlier; 40 keeps a usable window. Raising it costs only disk, because a delivered image
 * is already durable in the attachment store — the PNG here is the original, not the record.
 */
export const SHOT_KEEP = 40

/** Keep only the newest `keep` files carrying one prefix; returns how many were removed. */
export function pruneByPrefix(dir: string, prefix: string, keep: number): number {
  try {
    const shots = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.png'))
      .map((f) => ({ f, ms: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.ms - a.ms)
    let removed = 0
    for (const { f } of shots.slice(keep)) {
      try { unlinkSync(join(dir, f)); removed += 1 } catch { /* keep the rest */ }
    }
    return removed
  } catch {
    return 0
  }
}

/**
 * Keep only the newest `keep` automatic screenshots. Automatic shots exist for the failure that
 * just happened, so they are disposable — but only `auto-*` is ever deleted: the directory is
 * shared with hand-taken shots, and a tool that prunes user files is worse than a full disk.
 */
export function pruneAutoShots(dir: string, keep = SHOT_KEEP): number {
  return pruneByPrefix(dir, AUTO_SHOT_PREFIX, keep)
}

/**
 * Keep only the newest `keep` captures the model tools took. Safe for the same reason
 * `pruneAutoShots` is: the prefix proves the plugin wrote the file (`hmos-shot-*`, the panel's and
 * the user's, is never matched here).
 */
export function pruneToolShots(dir: string, keep = SHOT_KEEP): number {
  return pruneByPrefix(dir, TOOL_SHOT_PREFIX, keep)
}

/**
 * Take a screenshot because something just failed — the next question after "the tap did nothing"
 * is always "what did it look like". Only the path is returned by default: the image would cost
 * context, and for locating a node the tree is more precise than a scaled 1320x2856 PNG.
 *
 * `read` attaches the picture as well. The attachment store normalizes and downscales before the
 * request (`attachment-local`), the same path `screenshot {read:true}` uses. Failures here are
 * swallowed on purpose: a
 * screenshot that cannot be taken must not turn one failure into two.
 */
export async function autoShot(api, device: string, root: string, label: string): Promise<string> {
  try {
    const value = await api.screenshot({ device, root, auto: true, label })
    return typeof value?.path === 'string' ? value.path : ''
  } catch {
    return ''
  }
}

/** The failure-shot fields to spread into a result: the path, plus the image when one was asked for. */
export async function shotFields(api, device: string, root: string, label: string, ctx, read: boolean) {
  const path = await autoShot(api, device, root, label)
  if (!path) return {}
  const image = read ? await attachmentRefForImage(ctx, path) : undefined
  return image ? { shot: path, image } : { shot: path }
}

