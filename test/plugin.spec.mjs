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
