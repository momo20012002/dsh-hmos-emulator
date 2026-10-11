/**
 * The version check's notice: the sentence the shell's banner is given, and how the store keys it.
 * React-free, so both can be asserted without a renderer — the banner's own placement and fade
 * belong to the host, not to this plugin.
 */
import { describe, it, expect, vi } from 'vitest'
import { checkNotice, createNoticeSource } from '../src/client/notice.js'

describe('version check notice', () => {
  it('reports what the check found, and offers the install only when there is one', () => {
    expect(checkNotice({ channel: 'latest', target: '1.3.4', installed: '1.3.0-stable', checked: true })).toEqual({
      // The brackets close the sentence, so the label after it reads as a button on its own; no
      // closing period is used anywhere on the banner.
      // "The channel's newest build", not "a newer build": the channel can sit behind what is
      // installed, and only this phrasing is true in both directions.
      text: 'latest 通道最新版本 1.3.4(当前 1.3.0-stable)',
      // The prefix carries the separating space: the host gives the label only a 3px inline margin,
      // which crowds the closing bracket.
      action: { prefix: ' ', label: '立即更新' },
      // An answer the user has to act on is held open; a click elsewhere closes it.
      persist: true,
    })
    // The channel's build is the one in place: nothing to install, so the sentence just says so —
    // and it takes no closing period, unlike the two answers that end in a button.
    expect(checkNotice({ channel: 'latest', target: '1.3.4', installed: '1.3.4', checked: true }))
      .toEqual({ text: 'latest 通道已是最新版本(1.3.4)', tone: 'success' })
    // "Could not check" is not "already current", so the install stays on offer and the banner stays.
    // Its label is bare: the check failed, so the button cannot claim to be installing anything new.
    expect(checkNotice({ channel: 'stable', target: null, installed: '1.3.4', checked: false })).toEqual({
      text: '无法查询 stable 通道的最新版本(可能离线或源不可用)',
      tone: 'warning',
      action: { prefix: ' ', label: '更新' },
      persist: true,
    })
    expect(checkNotice({}).text).toContain('无法查询')
    expect(checkNotice(null).text).toContain('无法查询')
  })

  it('keys every showing so a repeated sentence restarts, and lets the owner dismiss it', () => {
    const source = createNoticeSource()
    const seen: unknown[] = []
    const unsubscribe = source.hooks.notice.subscribe(() => seen.push(source.hooks.notice.getSnapshot()))
    expect(source.hooks.notice.getSnapshot()).toBeNull()
    const plan = { channel: 'latest', target: '1.3.4', installed: '1.3.0-stable', checked: true }
    source.show(plan)
    source.show(plan)
    expect(seen.map((state) => (state as { seq: number }).seq)).toEqual([1, 2])
    // The channel travels with the notice: the sentence names it and the action must install it.
    expect(source.hooks.notice.getSnapshot()).toMatchObject({ channel: 'latest' })
    source.dismiss()
    expect(source.hooks.notice.getSnapshot()).toBeNull()
    unsubscribe()
    // A check that never reached the host is reported with the reason the host gave.
    source.fail(new Error('unknown method deveco.plan'))
    expect(source.hooks.notice.getSnapshot()).toMatchObject({
      tone: 'warning', text: '无法确认版本:unknown method deveco.plan',
    })
  })

  it('prefers a notice that brought its own action over the panel install', () => {
    const source = createNoticeSource()
    const install = vi.fn()
    const undo = vi.fn()
    source.setInstallRunner(install)
    // A notice this panel composed itself — the mount switch's confirmation — carries what its action
    // does, so the one button serves it and the install runner is left alone.
    source.say({ text: '切换到 better-sidebar', action: { prefix: ' ', label: '切换' }, persist: true }, undo)
    const shown = source.hooks.notice.getSnapshot()
    expect(shown).toMatchObject({ text: '切换到 better-sidebar', persist: true, channel: '' })
    expect(typeof (shown as { onAction?: () => void }).onAction).toBe('function')
    source.requestAction()
    expect(undo).toHaveBeenCalledTimes(1)
    expect(install).not.toHaveBeenCalled()
    // Using the action retires the banner, like the install action does.
    expect(source.hooks.notice.getSnapshot()).toBeNull()
    // A refusal carries no action at all, and keeps the host's own fade.
    source.say({ text: '未检测到 dsh-better-sidebar(或未启用),已保持内置右侧栏。', tone: 'warning' })
    expect(source.hooks.notice.getSnapshot()).toMatchObject({ tone: 'warning' })
    expect((source.hooks.notice.getSnapshot() as { onAction?: unknown }).onAction).toBeUndefined()
    expect((source.hooks.notice.getSnapshot() as { persist?: unknown }).persist).toBeUndefined()
  })

  it('runs the latest install the panel registered, with the channel the notice named', () => {
    const source = createNoticeSource()
    const stale = vi.fn()
    const current = vi.fn()
    source.setInstallRunner(stale)
    source.setInstallRunner(current)
    source.show({ channel: 'stable', target: '1.3.0-stable', installed: '1.3.4', checked: true })
    // The panel re-registers after every render, so the newest run is the one that fires — and the
    // setting may change while a standing banner is up, so the install follows its sentence.
    source.requestAction()
    expect(stale).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledWith('stable')
    expect(source.hooks.notice.getSnapshot()).toBeNull()
    // With no panel mounted there is no run to invoke, and that must stay silent.
    source.setInstallRunner(null)
    expect(() => source.requestAction()).not.toThrow()
  })

  it('lets only the panel that still holds the store clear it', () => {
    const source = createNoticeSource()
    const retiring = {}
    const arriving = {}
    const run = vi.fn()
    source.own(retiring)
    source.setInstallRunner(run)
    source.setAnchor({} as HTMLElement)
    source.show({ channel: 'latest', target: '1.3.4', installed: '1.3.0-stable', checked: true })
    // A host switch holds both panels for a moment: the arriving one takes the store over...
    source.own(arriving)
    source.setInstallRunner(run)
    source.setAnchor({} as HTMLElement)
    // ...and the retiring one's cleanup, landing late, must not wipe what it published.
    source.release(retiring)
    expect(source.hooks.notice.getSnapshot()).not.toBeNull()
    expect(source.hooks.anchor.getSnapshot()).not.toBeNull()
    source.requestAction()
    expect(run).toHaveBeenCalledTimes(1)
    // The holder itself does clear everything.
    source.release(arriving)
    expect(source.hooks.notice.getSnapshot()).toBeNull()
    expect(source.hooks.anchor.getSnapshot()).toBeNull()
    expect(() => source.requestAction()).not.toThrow()
  })

  it('publishes the panel the banner centers over, and notifies only when that changes', () => {
    const source = createNoticeSource()
    const notifies = vi.fn()
    const unsubscribe = source.hooks.anchor.subscribe(notifies)
    expect(source.hooks.anchor.getSnapshot()).toBeNull()
    const panel = {} as HTMLElement
    source.setAnchor(panel)
    // The anchor is re-published after every render, and an unchanged node must not notify: the banner
    // would remount and restart its fade mid-sentence.
    source.setAnchor(panel)
    expect(notifies).toHaveBeenCalledTimes(1)
    expect(source.hooks.anchor.getSnapshot()).toBe(panel)
    source.setAnchor(null)
    expect(source.hooks.anchor.getSnapshot()).toBeNull()
    unsubscribe()
  })
})
