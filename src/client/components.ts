import { IC } from './icons.js'
/** Style atoms and the four shared UI pieces: Icon, Btn, Card, Dropdown. */
export const { createElement: h, useState } = require('react')
/**
 * Brand and action colors are deliberately fixed, not themed: the primary and destructive button
 * fills and the panel's accent icon must read the same in light and dark. Every other color
 * (surfaces, text, borders, status) follows the theme.
 */
const ACTION_PRIMARY = '#4f6ef7'
const ACTION_DANGER = '#e5484d'
export const s = {
  fg: 'var(--dsw-alias-label-primary, #e6e6e6)',
  muted: 'var(--dsw-alias-label-secondary, rgba(148,148,160,.9))',
  faint: 'var(--dsw-alias-label-tertiary, rgba(148,148,160,.7))',
  border: 'var(--dsw-alias-border-l1, rgba(148,148,160,.18))',
  bg: 'var(--dsw-alias-bg-layer-2, rgba(148,148,160,.05))',
  bg2: 'var(--dsw-alias-bg-layer-1, rgba(148,148,160,.03))',
  accent: ACTION_PRIMARY,
  accentSoft: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6ef7) 16%, transparent)',
  ok: 'var(--dsw-alias-state-success-primary, #2f9e44)',
  danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
  solid: 'var(--dsw-alias-bg-layer-3, #1d1f28)',
}
export const row = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }
export const label = { fontSize: 12, color: s.muted, width: 64, flex: '0 0 64px' }
export const field = {
  flex: 1, minWidth: 0, background: s.bg2, color: s.fg,
  border: `1px solid ${s.border}`, borderRadius: 8, padding: '6px 10px', fontSize: 12,
  fontFamily: 'ui-monospace, Consolas, "Courier New", monospace',
}
export const card = { background: s.bg, border: `1px solid ${s.border}`, borderRadius: 10, padding: 10, marginBottom: 12 }
export const btnBase = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  borderRadius: 8, padding: '6px 12px', fontSize: 12, lineHeight: 1, cursor: 'pointer',
  border: `1px solid transparent`, whiteSpace: 'nowrap',
}
export const btnPrimary = { ...btnBase, background: ACTION_PRIMARY, color: '#fff' }
export const btnSecondary = { ...btnBase, border: `1px solid ${s.border}`, color: s.fg, background: 'transparent' }
export const btnGhost = { ...btnBase, color: s.muted, background: 'transparent' }
export const btnDanger = { ...btnBase, border: `1px solid ${ACTION_DANGER}`, color: ACTION_DANGER, background: 'transparent' }
export const btnDangerSolid = { ...btnBase, background: ACTION_DANGER, color: '#fff' }
/** Inline SVG icon forced to currentColor so it follows the theme. */
export function Icon({ src, size = 16 }: { src: string; size?: number }) {
  const body = String(src).replace(/fill="[^"]*"/g, 'fill="currentColor"')
  return h('span', {
    style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flex: '0 0 auto' },
    dangerouslySetInnerHTML: { __html: body },
  })
}
/** Button with an optional leading icon. */
export function Btn({ children, icon, primary, secondary, danger, dangerSolid, ghost, disabled, onClick, style, title }: {
  children?: any; icon?: string; primary?: boolean; secondary?: boolean; danger?: boolean; dangerSolid?: boolean; ghost?: boolean; disabled?: boolean; onClick?: any; style?: any; title?: string
}) {
  const base = primary ? btnPrimary : secondary ? btnSecondary : dangerSolid ? btnDangerSolid : danger ? btnDanger : ghost ? btnGhost : btnSecondary
  return h('button', {
    style: { ...base, ...style, ...(disabled ? { opacity: .5, cursor: 'not-allowed' } : undefined) },
    disabled, onClick, title,
  }, icon ? h(Icon, { src: icon, size: 15 }) : null, children)
}
/** Card block. action renders at the right of the title row; style overrides the card. */
export function Card({ title, action, style, children }: { title?: string; action?: any; style?: any; children?: any }) {
  return h('div', { style: { ...card, ...style } },
    (title || action) ? h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 8 } },
      title ? h('span', { style: { fontSize: 11, color: s.muted, letterSpacing: '.06em', textTransform: 'uppercase' } }, title) : null,
      h('div', { style: { flex: 1 } }),
      action || null) : null,
    children)
}

/** Themed dropdown: closed by default, opens on click; the list uses the dark surface. */
export function Dropdown({ value, placeholder, options, onChange }: {
  value?: string; placeholder?: string; options?: { value: string; label: string; status?: string }[]; onChange?: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return h('div', { style: { position: 'relative', flex: 1, minWidth: 0 } },
    h('div', { style: { position: 'relative' } },
      h('button', {
        style: { ...field, display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', color: s.fg, cursor: 'pointer', width: '100%' },
        onClick: () => setOpen((o) => !o),
      },
        h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: current ? s.fg : s.faint } }, current ? current.label : (placeholder || '选择…')),
        h('span', { style: { display: 'inline-flex', color: s.faint, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .12s' } }, h(Icon, { src: IC.chevron, size: 14 }))),
      open ? h('div', { style: {
        position: 'absolute', zIndex: 10, left: 0, right: 0, top: 'calc(100% + 4px)',
        background: s.solid, border: `1px solid ${s.border}`, borderRadius: 8, padding: 4,
        boxShadow: 'var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.45))', maxHeight: 220, overflowY: 'auto',
      } },
        options.length === 0
          ? h('div', { style: { padding: '7px 8px', fontSize: 12, color: s.faint } }, '无可选项')
          : options.map((o) => h('div', {
            key: o.value, style: {
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
              background: o.value === value ? s.accentSoft : 'transparent', color: s.fg,
            },
            onClick: () => { onChange(o.value); setOpen(false) },
            onMouseEnter: (e) => { e.currentTarget.style.background = s.accentSoft },
            onMouseLeave: (e) => { e.currentTarget.style.background = o.value === value ? s.accentSoft : 'transparent' },
          },
            o.status ? h('span', { style: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto', background: o.status === 'running' ? s.ok : s.faint, boxShadow: '0 0 0 1px var(--dsw-alias-border-l2, rgba(0,0,0,.25))' }, title: o.status }) : null,
            h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 } }, o.label))))
        : null),
    open ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 9 }, onClick: () => setOpen(false) }) : null,
  )
}

