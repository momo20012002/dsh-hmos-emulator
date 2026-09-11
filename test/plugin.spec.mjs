import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

describe('dsh-hmos-emulator host', () => {
  it('exports name & apply', async () => {
    const mod = await import('../lib/index.js')
    expect(mod.name).toBe('dsh-hmos-emulator')
    expect(typeof mod.apply).toBe('function')
  })
})

describe('dsh-hmos-emulator client artifact', () => {
  it('registers via window.__ModuleLoader__.load with the package id', async () => {
    let spec
    globalThis.window = { __ModuleLoader__: { load: (s) => { spec = s } } }
    await import('../lib/client.js')
    expect(spec).toBeTruthy()
    expect(spec.id).toBe('dsh-hmos-emulator')
    expect(typeof spec.factory).toBe('function')
  })
})

describe('lintOutcome', () => {
  const none = { issues: 0, errors: 0, warnings: 0, suggestions: 0, files: 0 }
  const dirty = { issues: 3, errors: 1, warnings: 1, suggestions: 1, files: 2 }

  it('calls an incremental run with no uncommitted files "nothing verified"', async () => {
    const { lintOutcome } = await import('../lib/index.js')
    expect(lintOutcome(none, 'changed', 0)).toEqual({ empty: true, stats: '无 Git 已跟踪改动,未检查任何文件' })
    expect(lintOutcome(none, 'fix', 0).empty).toBe(true)
  })

  it('distinguishes "clean" from "nothing to check"', async () => {
    const { lintOutcome } = await import('../lib/index.js')
    expect(lintOutcome(none, 'changed', 3)).toEqual({ empty: false, stats: '未发现告警(已检查 3 个改动文件)' })
    expect(lintOutcome(none, 'changed', null).stats).toBe('未发现告警(仅检查未提交改动)')
  })

  it('treats a clean full check as a real pass', async () => {
    const { lintOutcome } = await import('../lib/index.js')
    expect(lintOutcome(none, 'all', null)).toEqual({ empty: false, stats: '未发现告警' })
  })

  it('summarizes a dirty result', async () => {
    const { lintOutcome } = await import('../lib/index.js')
    expect(lintOutcome(dirty, 'changed', 2)).toEqual({ empty: false, stats: '错误 1 / 警告 1 / 建议 1 / 涉及文件 2' })
  })

  it('reports an unparsable result instead of a false all-clear', async () => {
    const { lintOutcome } = await import('../lib/index.js')
    expect(lintOutcome(null, 'changed', null).stats).toBe('未解析到结果')
  })
})

describe('fixStats', () => {
  // A --fix run prints "No defects found" even when unfixable issues remain (verified: the same
  // directory reports 2 issues plain and 0 with --fix while nothing is written), so the fix part
  // of the result must come from the files that changed, never from that summary.
  it('reports the files an auto-fix run actually rewrote', async () => {
    const { fixStats } = await import('../lib/index.js')
    expect(fixStats(2)).toBe('已自动修复 2 个文件')
  })

  it('says nothing was fixed instead of claiming a clean project', async () => {
    const { fixStats } = await import('../lib/index.js')
    expect(fixStats(0)).toBe('没有可自动修复的告警,未改动任何文件')
  })

  it('degrades honestly when the change cannot be measured', async () => {
    const { fixStats } = await import('../lib/index.js')
    expect(fixStats(null)).toBe('已执行自动修复(无法统计改动文件)')
  })
})
