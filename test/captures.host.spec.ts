/**
 * Drift protection for the parsers, driven by real devecocli output rather than by what we imagine
 * it prints. Each fixture below is one live capture; the assertions pin the exact key set and the
 * quoting quirks our code depends on, so a re-capture that changes either fails loudly.
 *
 * Captured 2026-10-05 with devecocli 1.3.0-stable (`@deveco/deveco-cli`) against a running emulator
 * (HarmonyOS 6.1.1(24), serial 127.0.0.1:5555):
 *   emulator list --format json
 *   device list --format json
 *   emulator image list --all --format json    (trimmed to the first 3 of 70 entries)
 *   ui layout --device 127.0.0.1:5555 --depth 3
 * The layout dump's visible text was replaced with neutral samples — the live one carried the
 * labels of the app running on the device; grammar, nesting, coordinates and flags are unchanged.
 *
 * What this cannot do: notice that devecocli changed its output, because a fixture is static. It
 * protects "we still parse a real dump"; keeping that true needs an occasional re-capture, whose
 * diff these key-set assertions make quick to review.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { cleanLayout, parseLayoutLine, pageTitle } from '../src/parsers/layout.js'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('real CLI captures', () => {
  it('reads the emulator list exactly as the API consumes it', () => {
    const entries = JSON.parse(fixture('emulator-list.json'))
    expect(Array.isArray(entries)).toBe(true)
    // The key set is the contract `emu.list` normalizes; an upstream rename lands here first.
    expect(Object.keys(entries[0]).sort()).toEqual(['deviceType', 'name', 'osVersion', 'serial', 'status'])
    expect(entries[0]).toMatchObject({ status: 'running', serial: '127.0.0.1:5555' })
    // A stopped instance reports a null serial rather than dropping the field.
    expect(entries[1]).toHaveProperty('serial', null)
  })

  it('reads the device list, where entries are objects and the serial rule still applies', () => {
    const entries = JSON.parse(fixture('device-list.json'))
    expect(Object.keys(entries[0]).sort()).toEqual(['deviceType', 'kind', 'name', 'serial'])
    expect(entries[0].kind).toBe('emulator')
    // `api.devices` takes `serial || name`: pin that this real shape yields the serial.
    expect(entries.map((device: any) => device.serial || device.name)).toEqual(['127.0.0.1:5555'])
  })

  it('reads the image list, whose downloaded flag is a string', () => {
    const entries = JSON.parse(fixture('emulator-image-list.json'))
    expect(Object.keys(entries[0]).sort())
      .toEqual(['SoftWareVersion', 'deviceType', 'downloaded', 'osVersion', 'releaseType', 'upgradable'])
    // The pre-start check compares `String(downloaded).toLowerCase() === 'true'`; reading the field
    // as a boolean instead would silently treat every image as not downloaded.
    expect(entries.every((image: any) => typeof image.downloaded === 'string')).toBe(true)
    expect(entries.some((image: any) => image.downloaded === 'false')).toBe(true)
  })

  it('parses a real layout dump: spinner dropped, root bounds, nesting and flags kept', () => {
    const cleaned = cleanLayout(fixture('ui-layout.txt'))
    expect(cleaned).not.toMatch(/Dumping layout/)
    const lines = cleaned.split('\n').map(parseLayoutLine)
    // The bare root bounds line carries no type; the parser keeps it as the tree's root.
    expect(lines[0]).toMatchObject({ type: '', bounds: [0, 0, 1320, 2856] })
    const label = lines.find((line) => line.text === '样本一')
    expect(label).toMatchObject({ type: 'Text', indent: 4, clickable: false })
    expect(label?.bounds).toEqual([193, 1158, 320, 1207])
    // A container line: clickable comes from the flag word, never from the type.
    expect(lines.find((line) => line.type === 'TextInput')).toMatchObject({ clickable: true, indent: 2 })
    // Robustness on real input: a dump carrying no title must answer, not throw.
    expect(typeof pageTitle(lines)).toBe('string')
  })
})
