import { resolveDevecoCli, runCli } from '../toolchain.js'
import { sliceText, tailText } from '../text.js'
import { TOOL_OUT_SCHEMA, toolRender } from '../shots.js'
import type { ToolDeps } from './deps.js'
/** Offline DevEco documentation search and read. */

export function makeHmosDocs(_deps: ToolDeps) {
  return {
      name: 'hmos_docs',
      description: 'Search/read the official HarmonyOS docs via devecocli docs (offline local set). search: compact id/title/snippet; read: one document, pageable.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'read'] },
          keywords: { type: 'string', description: 'search: phrase, as-is' },
          open: { type: 'integer', description: 'search: also read the first N hits in full (1-3), saving the follow-up read' },
          documentId: { type: 'string', description: 'read: id from a search result' },
          limit: { type: 'integer', description: 'search: max results (5, max 20); read: max chars (8000, max 20000)' },
          offset: { type: 'integer', description: 'read: start at this char (0); continue from nextOffset' },
        },
        required: ['action'],
      },
      output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
      async execute(args) {
        const cli = resolveDevecoCli()
        if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
        const action = String(args?.action || '')
        if (action === 'search') {
          const keywords = typeof args?.keywords === 'string' ? args.keywords.trim() : ''
          if (!keywords) return { ok: false, error: 'keywords is required' }
          const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(20, args.limit)) : 5
          const argv = [process.execPath, cli, 'docs', 'search', keywords, '--limit', String(limit)]
          const r = await runCli(argv, { timeoutMs: 60000 })
          if (r.code !== 0) return { ok: false, error: tailText(r.output, 6) }
          // Entries look like "<documentId>\n  Title: ...\n  Content: ...", separated by blank lines.
          const entries = r.output.split(/\n\s*\n/).map((chunk) => {
            const lines = chunk.split(/\r?\n/).filter((line) => line.trim() !== '')
            if (lines.length === 0) return null
            const id = lines[0].trim()
            if (id.startsWith('Title:') || id.startsWith('Content:')) return null
            const title = (chunk.match(/Title:\s*(.+)/) || [])[1] || ''
            const content = (chunk.match(/Content:\s*([\s\S]*)/) || [])[1] || ''
            return { id, title: title.trim(), snippet: content.replace(/\s+/g, ' ').trim().slice(0, 140) }
          }).filter(Boolean)
          // a doc lookup is almost always search-then-read, so `open` fetches the body of the
          // first N hits in the same call — the ids and titles in the list are what makes that safe.
          const open = Number.isFinite(args?.open) ? Math.max(0, Math.min(3, Math.floor(args.open))) : 0
          if (open === 0 || entries.length === 0) return { ok: true, count: entries.length, entries }
          const opened: any[] = []
          for (const entry of entries.slice(0, open)) {
            const read = await runCli([process.execPath, cli, 'docs', 'read', entry.id], { timeoutMs: 60000 })
            if (read.code !== 0) { opened.push({ id: entry.id, error: tailText(read.output, 3) }); continue }
            const slice = sliceText(read.output.trim(), 0, 8000)
            opened.push({
              id: entry.id, title: entry.title, total: slice.total,
              ...(slice.nextOffset === null ? {} : { nextOffset: slice.nextOffset }),
              text: slice.text,
            })
          }
          return { ok: true, count: entries.length, entries, opened }
        }
        if (action === 'read') {
          const documentId = typeof args?.documentId === 'string' ? args.documentId.trim() : ''
          if (!documentId) return { ok: false, error: 'documentId is required' }
          const r = await runCli([process.execPath, cli, 'docs', 'read', documentId], { timeoutMs: 60000 })
          if (r.code !== 0) return { ok: false, error: tailText(r.output, 6) }
          const offset = Number.isFinite(args?.offset) ? Math.max(0, Math.floor(args.offset)) : 0
          const limit = Number.isFinite(args?.limit) ? Math.max(500, Math.min(20000, Math.floor(args.limit))) : 8000
          const slice = sliceText(r.output.trim(), offset, limit)
          return {
            ok: true,
            documentId,
            total: slice.total,
            offset: slice.offset,
            // Say where to continue instead of dropping the tail silently.
            ...(slice.nextOffset === null ? {} : { nextOffset: slice.nextOffset }),
            text: slice.text,
          }
        }
        return { ok: false, error: `unknown action ${action}` }
      },
  }
}
