import { capLines } from '../text.js'
/**
 * Parse and query `ui layout` dumps: node lines, label matching and disambiguation,
 * tap targets, subtrees, and the JSON/step renderings the tools return.
 */
/** Drop the spinner line and blank lines from a devecocli `ui layout` dump. */
export function cleanLayout(text: string): string {
  return String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '' && !/Dumping layout/i.test(l)).join('\n')
}

/**
 * One compact layout line: `Type [x1,y1,x2,y2] "text" [clickable] [scrollable] …`.
 * In practice: devecocli prints no node id in any mode (`--mode full` and
 * `--format json` included), so `emu_ui` assigns ids by position in the dump it just returned.
 */
export interface LayoutLine {
  /** Leading widget type; empty for the bare root bounds line. */
  type: string
  /** Unescaped node text; empty for nodes that carry none. */
  text: string
  /** Node rectangle, or null when the line carries no bounds. */
  bounds: [number, number, number, number] | null
  /** Node rectangle area in px, used to prefer the innermost match. */
  area: number
  clickable: boolean
  /** Leading-space count; the dump nests children two spaces deeper than their parent. */
  indent: number
  raw: string
}

export function parseLayoutLine(raw: string): LayoutLine {
  const text = raw.match(/"((?:[^"\\]|\\.)*)"/)
  let decoded = ''
  if (text) {
    try { decoded = JSON.parse(`"${text[1]}"`) } catch { decoded = text[1] }
  }
  const box = raw.match(/\[(-?\d+),(-?\d+),(-?\d+),(-?\d+)\]/)
  const bounds: [number, number, number, number] | null = box
    ? [Number(box[1]), Number(box[2]), Number(box[3]), Number(box[4])]
    : null
  // The leading widget type, e.g. `Column` in `Column [0,0,10,10] clickable`. Real dumps also
  // carry inspector suffixes (`GridItem#SwiperPage_GridItem_[…]`), so stop at the first character
  // that cannot be part of a type name rather than requiring the bounds bracket to follow.
  const head = raw.trim().match(/^([A-Za-z_][\w.]*)/)
  return {
    type: head ? head[1] : '',
    text: decoded,
    bounds,
    area: bounds ? Math.abs((bounds[2] - bounds[0]) * (bounds[3] - bounds[1])) : Number.MAX_SAFE_INTEGER,
    clickable: /\bclickable\b/.test(raw),
    indent: raw.length - raw.trimStart().length,
    raw,
  }
}

/**
 * The node whose center should be tapped for a match. In practice: a tab label
 * flush with the screen edge has its own center in the system gesture area, where the tap is
 * swallowed, while its clickable parent is one level up. So an inert match climbs to its
 * nearest clickable ancestor — unless that ancestor dwarfs the label, which makes it a
 * container (a whole clickable page) rather than the control.
 */
export function tapTarget(lines: LayoutLine[], index: number): LayoutLine {
  const hit = lines[index]
  if (hit.clickable) return hit
  let depth = hit.indent
  for (let i = index - 1; i >= 0; i--) {
    if (lines[i].indent >= depth) continue
    if (lines[i].clickable) {
      // A zero-area match has no visible point of its own, so it climbs whatever it finds
      // inside; otherwise an ancestor far larger than the label is a container, not the control.
      return hit.area === 0 || lines[i].area <= hit.area * 64 ? lines[i] : hit
    }
    depth = lines[i].indent
  }
  return hit
}

/**
 * Center of a node, moved out of the screen's bottom edge when it would land there.
 * Measured on a 1320x2856 emulator: a bottom tab bar spanning y 2688..2856 answers at
 * 2716-2730 (icon) but not at 2772-2832 (label), where the tap is swallowed by the system
 * gesture area — or read as a back gesture, which navigates away instead of failing loudly.
 * The bottom ~96px (3.4%) is dead, so a center inside the outermost 5% is replaced by the
 * center of the node's upper third, which stays inside the node.
 */
export function tapPoint(target: LayoutLine, screenBottom: number): { x: number; y: number } {
  const [x1, y1, x2, y2] = target.bounds
  const x = Math.round((x1 + x2) / 2)
  const y = Math.round((y1 + y2) / 2)
  return screenBottom > 0 && y > screenBottom * 0.95 ? { x, y: Math.round(y1 + (y2 - y1) / 6) } : { x, y }
}

/** One tappable candidate for a label: the matched text node and the control actually pressed. */
export interface LabelMatch {
  /** Id (dump position) of the node whose text matched. */
  id: number
  line: LayoutLine
  /** The node whose center is pressed; its own id is what a later `click {id}` would use. */
  target: LayoutLine
  targetIndex: number
  /** Whether the match was the whole node text rather than a substring of it. */
  exact: boolean
}

/**
 * Every distinct control a label can mean, best first.
 * Rank rather than take the first `includes` hit: a tap meant for a short label must not land on a
 * container whose text merely contains it. Exact text before mere containment, clickable nodes
 * before inert ones, then the smallest area so an inner node
 * wins over the outer container that holds it. Hits sharing one tap target (a label and the
 * container it climbed to) collapse into a single candidate, so the count is a control count.
 */
export function labelMatches(lines: LayoutLine[], label: string): LabelMatch[] {
  const wanted = String(label ?? '')
  if (!wanted) return []
  const hits = lines.map((_, i) => i).filter((i) => lines[i].bounds && lines[i].text.includes(wanted))
  if (!hits.length) return []
  const rank = (i: number) => (lines[i].text === wanted ? 0 : 1) * 2 + (lines[i].clickable ? 0 : 1)
  hits.sort((a, b) => rank(a) - rank(b) || lines[a].area - lines[b].area)
  const seen = new Set<number>()
  const out: LabelMatch[] = []
  for (const i of hits) {
    const target = tapTarget(lines, i)
    const targetIndex = lines.indexOf(target)
    if (seen.has(targetIndex)) continue
    seen.add(targetIndex)
    out.push({ id: i, line: lines[i], target, targetIndex, exact: lines[i].text === wanted })
  }
  return out
}

/**
 * Compact candidate list for an ambiguous match, capped so it stays cheap. Beyond `bounds`, a
 * candidate carries `at` — the outermost ancestor text that is not the candidate's own label —
 * because on a list page the repeated label is the *only* thing that identifies nothing (three
 * cards all reading "Start" differ solely by the card title above them).
 */
export function candidateList(lines: LayoutLine[], matches: LabelMatch[], cap = 5) {
  return matches.slice(0, cap).map((m, index) => {
    const label = nodeLabel(lines, m.id) || nodeLabel(lines, m.targetIndex)
    const at = ancestorLabels(lines, m.targetIndex).find((text) => text !== label) ?? ''
    return { index, label, ...(at ? { at } : {}), bounds: m.target.bounds }
  })
}

// ── Layout ids and filtering ───────────────────────────────────────

/** Optional narrowing of a dump. `type` matches case-insensitively; `textRegex` is a JS regex. */
export interface LayoutQuery { type?: string; textRegex?: string; clickableOnly?: boolean }

/** Lines matching the query, each paired with its dump-wide id. */
export function selectLayoutLines(lines: LayoutLine[], query: LayoutQuery = {}): { index: number; line: LayoutLine }[] {
  let re: RegExp | null = null
  if (typeof query?.textRegex === 'string' && query.textRegex) {
    try { re = new RegExp(query.textRegex) } catch { re = null }
  }
  const wanted = typeof query?.type === 'string' ? query.type.toLowerCase() : ''
  const picked = lines.map((line, index) => ({ index, line })).filter(({ line }) => {
    if (wanted && line.type.toLowerCase() !== wanted) return false
    if (re && !re.test(line.text)) return false
    return true
  })
  if (!query?.clickableOnly) return picked
  // A label usually sits in an inert child while the node carrying the action is its clickable
  // parent, so `clickableOnly` reports the tap target of each match — the same node `click {id}`
  // will press. Filtering on "text AND clickable" alone would return nothing for such labels.
  const seen = new Set<number>()
  const out: { index: number; line: LayoutLine }[] = []
  for (const { index, line } of picked) {
    if (line.clickable) {
      if (!seen.has(index)) { seen.add(index); out.push({ index, line }) }
      continue
    }
    const target = tapTarget(lines, index)
    const targetIndex = target && target.clickable ? lines.indexOf(target) : -1
    if (targetIndex < 0 || seen.has(targetIndex)) continue
    seen.add(targetIndex)
    out.push({ index: targetIndex, line: lines[targetIndex] })
  }
  return out
}

/**
 * Render rows as one line per node, ids first (`#12 Column [..] clickable`) so a later `click {id}`
 * references the exact node that was read, including icon nodes with no text.
 */
export function renderLines(rows: { index: number; line: LayoutLine }[]): string[] {
  return rows.map(({ index, line }) => `${' '.repeat(line.indent)}#${index} ${line.raw.trim()}`)
}

/** A rendered dump for the model, capped. */
export function renderLayout(rows: { index: number; line: LayoutLine }[]): string {
  return capLines(renderLines(rows)).join('\n')
}

/**
 * The diffable identity of a set of nodes: the raw dump line, without our `#id` decoration. Ids are
 * assigned by position, so a single node appearing above would rewrite every id below it and bury
 * the one real change in noise.
 */
export function rawKeys(rows: { index: number; line: LayoutLine }[]): string[] {
  return rows.map(({ line }) => line.raw.trim())
}

/**
 * Human-readable name of a node: its own text, or — for a container matched through a child's
 * label (the clickable tab that owns the text) — the first text inside it. Why:
 * `filter{clickableOnly}` reports the clickable Column, which carries no text of its own.
 */
export function nodeLabel(lines: LayoutLine[], index: number): string {
  const own = lines[index] ? lines[index].text : ''
  if (own) return own
  const indent = lines[index] ? lines[index].indent : 0
  for (let i = index + 1; i < lines.length; i += 1) {
    if (lines[i].indent <= indent) break
    if (lines[i].text) return lines[i].text
  }
  return ''
}

/**
 * Text breadcrumb of a node, outermost first, capped at `limit` entries — the identity of what is
 * about to be pressed. `nodeLabel` alone cannot answer this: the three cards each end in a
 * "Start" button, and only the card title tells them apart, so each ancestor contributes its
 * own label (own text, else the first text inside it — which for a card container IS its title).
 * Empty levels are skipped and repeats collapsed, so the tail is normally the pressed control.
 */
export function ancestorLabels(lines: LayoutLine[], index: number, limit = 3): string[] {
  const chain: string[] = []
  const own = nodeLabel(lines, index)
  if (own) chain.push(own)
  const refArea = lines[index] ? lines[index].area : 0
  let indent = lines[index] ? lines[index].indent : 0
  for (let i = index - 1; i >= 0 && chain.length < limit; i -= 1) {
    if (lines[i].indent >= indent) continue
    // Same "a much larger ancestor is a container, not the label" guard tapTarget uses, and the
    // same reason: a page-level Column inherits the FIRST text under it, which on a list page is
    // another item's title — a breadcrumb must not name a sibling item as this one's parent.
    if (refArea > 0 && lines[i].area > refArea * 64) break
    indent = lines[i].indent
    const label = nodeLabel(lines, i)
    if (label && label !== chain[chain.length - 1]) chain.push(label)
  }
  return chain.reverse()
}

/**
 * Text that identifies the page currently showing, used to answer "which page am I on" after a
 * tap. Prefers the shallowest text inside a `NavDestination` subtree (the page's own header), then
 * accepts the dump's first text only when it sits at the very top and is not a bare number —
 * shape of that failure: a page whose title area holds no words produced `"0"`, a stat
 * number, which names nothing. Returns '' rather than a guess, since callers confirm navigation
 * with it.
 */
export function pageTitle(lines: LayoutLine[]): string {
  const navIndex = lines.findIndex((l) => l.type.toLowerCase() === 'navdestination')
  if (navIndex >= 0) {
    const indent = lines[navIndex].indent
    let shallowest = Number.MAX_SAFE_INTEGER
    let found = ''
    for (let i = navIndex + 1; i < lines.length; i += 1) {
      if (lines[i].indent <= indent) break
      if (lines[i].text && lines[i].indent < shallowest) { shallowest = lines[i].indent; found = lines[i].text }
    }
    if (found) return found
  }
  // Otherwise accept a top-level text only from the header band. On a typical screen the only
  // top-level texts are the statistics — a big counter and its small label, well below the header
  // — so both "first text" and "first non-numeric text" named the wrong page. A page name
  // that is wrong is worse than none, so anything lower than the band is refused and the caller
  // gets `page: null`.
  const bottom = lines.reduce((max, l) => (l.bounds ? Math.max(max, l.bounds[3]) : max), 0)
  const band = bottom * 0.2
  const first = lines.find((l) => l.text && l.bounds && l.bounds[1] < band && !/^\d+$/.test(l.text.trim()))
  return first && first.indent <= 2 ? first.text : ''
}

/** Flat JSON view. Cheaper than devecocli's nested `--format json` and it carries our ids. */
export function layoutJson(rows: { index: number; line: LayoutLine }[], lines: LayoutLine[] = []): any[] {
  return rows.map(({ index, line }) => {
    const label = lines.length > 0 ? nodeLabel(lines, index) : line.text
    return {
      id: index,
      type: line.type,
      bounds: line.bounds,
      depth: Math.floor(line.indent / 2),
      clickable: line.clickable,
      ...(line.text ? { text: line.text } : {}),
      // An inherited label (the text lives in a child) is what tells the caller what it matched.
      ...(label && label !== line.text ? { label } : {}),
    }
  })
}

/** Tap point of a stored node, so a later `click {id}` lands where the dump said it was. */
export function pointOf(lines: LayoutLine[], index: number): { x: number; y: number } | null {
  const line = lines[index]
  if (!line || !line.bounds) return null
  const screenBottom = Math.max(...lines.map((l) => (l.bounds ? l.bounds[3] : 0)))
  return tapPoint(tapTarget(lines, index), screenBottom)
}

/** Nodes matching a text/regex query, with their ids and tap points (used by waitFor). */
export function matchLayout(lines: LayoutLine[], { text, textRegex, clickableOnly }: { text?: string; textRegex?: string; clickableOnly?: boolean } = {}) {
  const wanted = typeof text === 'string' ? text : ''
  let re: RegExp | null = null
  if (typeof textRegex === 'string' && textRegex) {
    try { re = new RegExp(textRegex) } catch { re = null }
  }
  if (!wanted && !re) return []
  const hits: { id: number; x: number; y: number; text: string }[] = []
  lines.forEach((line, index) => {
    if (!line.bounds) return
    if (clickableOnly && !line.clickable) return
    const hit = (wanted && line.text.includes(wanted)) || (re ? re.test(line.text) : false)
    if (!hit) return
    const point = pointOf(lines, index)
    if (point) hits.push({ id: index, x: point.x, y: point.y, text: line.text })
  })
  return hits
}
