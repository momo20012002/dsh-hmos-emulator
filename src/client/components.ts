import { IC } from './icons.js'
/** Style atoms and the shared UI pieces: Icon, Btn, Segmented, Card, Dropdown. */
export const { createElement: h, useEffect, useRef, useState } = require('react')
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
/**
 * Capsule choice for a preference with two named states: both labels live inside the pill, the
 * chosen half carries the accent, and an unavailable half greys out on its own. A half may carry a
 * longer tooltip so a short on-screen label can still name its full subject on hover.
 */
export function Segmented({ value, options, onChange }: {
  value?: string
  options: { value: string; label: string; title?: string; disabled?: boolean }[]
  onChange?: (value: string) => void
}) {
  return h('div', {
    style: {
      display: 'inline-flex', alignItems: 'center', flex: '0 0 auto', padding: 2, gap: 2,
      borderRadius: 999, border: `1px solid ${s.border}`, background: s.bg2,
    },
  }, options.map((option) => {
    const active = option.value === value
    return h('button', {
      key: option.value,
      type: 'button',
      disabled: option.disabled,
      'aria-pressed': active,
      title: option.title === undefined ? option.label : option.title,
      onClick: () => { if (!option.disabled && !active && onChange) onChange(option.value) },
      style: {
        // The shell's own control size in a settings row: 13 at weight 500 (see ui-permission-presets'
        // selector). It sits under a 14px label and above a 12px description, which is what gives the
        // popover a level of its own instead of one flat size.
        border: 'none', borderRadius: 999, padding: '4px 10px', fontSize: 13, fontWeight: 500, lineHeight: 1.4,
        font: 'inherit', whiteSpace: 'nowrap', transition: 'background .15s, color .15s',
        background: active ? ACTION_PRIMARY : 'transparent',
        color: active ? '#fff' : s.muted,
        cursor: option.disabled || active ? 'default' : 'pointer',
        opacity: option.disabled ? .5 : 1,
      },
    }, option.label)
  }))
}

/**
 * An anchored floating panel: the shell's surface for a set-once preference, hung off the button that
 * opens it (the header's gear) and sized for its rows. `onClose` adds the scrim — clicking outside
 * calls it — while the panel itself stays interactive above the scrim.
 *
 * The width is the one the widest row needs (a 14px label beside a 13px two-half capsule) and it is
 * capped at whatever the column offers, so a narrow column shrinks the panel instead of letting a row
 * hang out of it.
 */
export function Popover({ onClose, children }: { onClose?: () => void; children?: any }) {
  return h('div', null,
    onClose ? h('div', { style: { position: 'fixed', inset: 0, zIndex: 20 }, onClick: onClose }) : null,
    h('div', {
      style: {
        position: 'absolute', right: 0, top: '100%', marginTop: -6, width: 'min(322px, 100%)', zIndex: 21,
        boxSizing: 'border-box',
        background: s.solid, border: `1px solid ${s.border}`, borderRadius: 10, padding: 10,
        boxShadow: 'var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.45))',
      },
    }, children))
}

/** Card block. action renders at the right of the title row; style overrides the card. */
/**
 * Card block. action renders at the right of the title row; style overrides the card.
 *
 * The title is the level between the panel's own name (15) and its row labels (12): 13 at weight 600 in
 * the foreground colour. It used to be smaller than those labels — 11, muted, with tracking meant for
 * Latin small caps — which inverted the hierarchy on every card.
 */
export function Card({ title, action, style, children }: { title?: string; action?: any; style?: any; children?: any }) {
  return h('div', { style: { ...card, ...style } },
    (title || action) ? h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 8 } },
      title ? h('span', { style: { fontSize: 13, fontWeight: 600, color: s.fg } }, title) : null,
      h('div', { style: { flex: 1 } }),
      action || null) : null,
    children)
}

/** Themed dropdown: closed by default, opens on click; the list uses the dark surface. */
export function Dropdown({ value, placeholder, options, onChange, align = 'center', caption, title, editable }: {
  value?: string; placeholder?: string; options: { value: string; label: string; status?: string; title?: string; onRemove?: () => void }[]; onChange?: (v: string) => void
  align?: 'center' | 'left'
  /** Fixed text for the trigger instead of the selected value; the menu still marks the value it holds. */
  caption?: string
  /** Hover text; defaults to the current option's own label. */
  title?: string
  /**
   * Text-field trigger. The list still picks, but the value can also be typed or pasted — a free-form
   * path has no enumerable set, and a menu alone would take that away. The chevron turns into its own
   * click target so typing and opening stay separate gestures.
   */
  editable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  const left = align === 'left'
  // Only a menu that can remove rows needs full-width ones: that is what gives the trailing × a right edge
  // to sit on. Menus without a remove action keep hugging their labels, as before.
  const removable = options.some((o) => o.onRemove)
  const boxRef = useRef(null)
  // Closing on an outside press instead of with a scrim: this panel's root carries a backdrop-filter, which
  // makes it the containing block for position:fixed descendants — a "full-screen" scrim would cover only
  // the panel, so a press in the chat column beside it would leave the menu open.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      const box = boxRef.current
      if (box && !box.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return h('div', { ref: boxRef, style: { position: 'relative', flex: 1, minWidth: 0 } },
    h('div', { style: { position: 'relative' } },
      editable
        ? h('input', {
          // border-box explicitly, and block rather than the inline-block default: with content-box the width
          // plus this padding and border pushed the field past the card's right edge, and an inline-block
          // input also drags the line box down by its descender.
          // Plain block-level field: border-box for the width plus the padding, block so an inline-block
          // input cannot drag the line box down by its descender.
          style: { ...field, display: 'block', boxSizing: 'border-box', paddingRight: 26, color: s.fg, width: '100%', textAlign: left ? 'left' : 'center' },
          value: value ?? '', placeholder: placeholder || '选择…', title: title || placeholder,
          onChange: (e) => { if (onChange) onChange(e.target.value) }, spellCheck: false,
        })
        : h('button', {
          style: { ...field, boxSizing: 'border-box', position: 'relative', display: 'flex', alignItems: 'center', textAlign: left ? 'left' : 'center', color: s.fg, cursor: 'pointer', width: '100%' },
          title: title || (current ? current.label : placeholder),
          onClick: () => setOpen((o) => !o),
        },
          h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: (caption || current) ? s.fg : s.faint } },
            caption || (current ? current.label : (placeholder || '选择…'))),
          // Out of flow, so the label centres against the whole control instead of the space left of it.
          h('span', { style: { position: 'absolute', right: 8, display: 'inline-flex', pointerEvents: 'none', color: s.faint, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .12s' } }, h(Icon, { src: IC.chevron, size: 14 }))),
      // The editable trigger's own chevron: a click target of its own, so a press opens the list instead of
      // putting a caret in the field.
      editable
        ? h('span', {
          style: { position: 'absolute', right: 4, top: 0, bottom: 0, display: 'inline-flex', alignItems: 'center', padding: '0 4px', cursor: 'pointer', color: s.faint, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .12s' },
          onClick: () => setOpen((o) => !o),
        }, h(Icon, { src: IC.chevron, size: 14 }))
        : null,
      open ? h('div', { style: {
        // At least as wide as the trigger, then as wide as the widest option. Inheriting the trigger's
        // width alone made long options ellipsize and left short ones swimming in empty space. The cap
        // leaves room for a full device path, so a menu row never has to abbreviate what it fills in.
        position: 'absolute', zIndex: 10, left: 0, top: 'calc(100% + 3px)', boxSizing: 'border-box',
        minWidth: '100%', width: 'max-content', maxWidth: 420, overflowX: 'hidden',
        background: s.solid, border: `1px solid ${s.border}`, borderRadius: 8, padding: 3,
        boxShadow: 'var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.45))', maxHeight: 220, overflowY: 'auto',
      } },
        options.length === 0
          ? h('div', { style: { padding: '2px 8px', fontSize: 12, color: s.faint, textAlign: left ? 'left' : 'center' } }, '无可选项')
          : options.map((o) => h('div', {
            key: o.value, style: {
              // Centred, so the space around a short label is even rather than all on one side, however
              // narrow the menu ends up being.
              display: 'flex', alignItems: 'center', justifyContent: left ? 'flex-start' : 'center', gap: 8,
              // Every row of a removable menu spans it, so the hover highlight and the × line up down the list.
              // border-box goes with that width: without it the row is 100% plus its own padding, and the ×
              // ends up under the menu's clip instead of inside it.
              ...(removable ? { width: '100%', boxSizing: 'border-box' } : undefined),
              padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
              lineHeight: 1.15,
              background: o.value === value ? s.accentSoft : 'transparent', color: s.fg,
            },
            // A clipped label can hide what the row really holds, so the option may carry its full text.
            title: o.title,
            onClick: () => { onChange(o.value); setOpen(false) },
            onMouseEnter: (e) => { e.currentTarget.style.background = s.accentSoft },
            onMouseLeave: (e) => { e.currentTarget.style.background = o.value === value ? s.accentSoft : 'transparent' },
          },
            o.status ? h('span', { style: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto', background: o.status === 'running' ? s.ok : s.faint, boxShadow: '0 0 0 1px var(--dsw-alias-border-l2, rgba(0,0,0,.25))' }, title: o.status }) : null,
            // Shrinkable: an over-long label ellipsises instead of pushing the × out to the clipped edge,
            // which is what made it look flush against the menu's border.
            h('span', { style: { flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 } }, o.label),
            // Removal keeps the menu open and does not pick the row: dropping several stale paths is one visit.
            o.onRemove ? h('span', {
              style: { flex: '0 0 auto', marginLeft: 'auto', padding: '0 4px', color: s.faint, cursor: 'pointer', lineHeight: 1 },
              title: '从列表移除',
              onClick: (e) => { e.stopPropagation(); if (o.onRemove) o.onRemove() },
            }, '×') : null)))
        : null),
  )
}

