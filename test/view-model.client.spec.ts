/**
 * The panel's selection rules, exercised without React: which module, device and project survive an
 * answer from the host. These decisions used to be inline in the component, where only a human
 * clicking through the panel could check them.
 */
import { describe, it, expect } from 'vitest'
import { authHint, deviceLabel, keepScannedProject, mountSwitchTitle, pickDevice, pickModule, statusTone } from '../src/client/view-model.js'

describe('mount confirmation wording', () => {
  it('names the destination once, with the workbench build beside it', () => {
    // The build is an attribute of the destination, not a second sentence of detection prose: both
    // confirmation surfaces (the shell's dialog and its banner fallback) read this one string.
    expect(mountSwitchTitle('better', '0.25.0')).toBe('切换到 better-sidebar 0.25.0')
    expect(mountSwitchTitle('native', '')).toBe('切换到 内置右侧栏')
    // A workbench that reports no build is named without a dangling space, and the built-in column never
    // carries one: the shell has no version of its own to report.
    expect(mountSwitchTitle('better', '')).toBe('切换到 better-sidebar')
    expect(mountSwitchTitle('native', '0.25.0')).toBe('切换到 内置右侧栏')
  })
})

describe('signing account state', () => {
  it('names both states, and nothing at all when the state could not be read', () => {
    // The settings row shows this on the right, beside the label that names the account. Both readings are
    // named, because a label that only appears when something is wrong reads as an error; a state that could
    // not be read (no CLI) is not a reading, so it draws nothing.
    expect(authHint(false)).toBe('未登录')
    expect(authHint(true)).toBe('已登录')
    expect(authHint(null)).toBe(null)
  })
})

describe('panel selection rules', () => {
  it('keeps the online serial it is given, otherwise takes the first device', () => {
    expect(pickDevice([], 'a')).toBe('')
    expect(pickDevice(['a', 'b'], 'b')).toBe('b')
    // A serial that is no longer online must never become the deploy target.
    expect(pickDevice(['a', 'b'], 'gone')).toBe('a')
    expect(pickDevice(['a', 'b'])).toBe('a')
  })

  it('prefers the remembered module, then entry, then the first', () => {
    expect(pickModule(['entry', 'feature'], 'feature')).toBe('feature')
    expect(pickModule(['entry', 'feature'], 'gone')).toBe('entry')
    expect(pickModule(['feature', 'other'], 'gone')).toBe('feature')
    expect(pickModule([], 'entry')).toBe('')
  })

  it('keeps a scanned selection only while the scan still finds it', () => {
    expect(keepScannedProject(['/a', '/b'], '/b', true)).toBe('/b')
    expect(keepScannedProject(['/a', '/b'], '/gone', true)).toBe('/a')
    // A scan the user asked for may replace the selection outright.
    expect(keepScannedProject(['/a', '/b'], '/b', false)).toBe('/a')
  })

  it('labels a device with its instance name, and reports status as a tone', () => {
    const instances = [{ name: 'Pixel', serial: '127.0.0.1:5555' }]
    expect(deviceLabel(instances, '127.0.0.1:5555')).toBe('Pixel (127.0.0.1:5555)')
    expect(deviceLabel(instances, 'ABC123')).toBe('ABC123')
    expect(statusTone('running')).toEqual({ tone: 'ok', label: '运行中' })
    expect(statusTone('stopped')).toEqual({ tone: 'danger', label: '已停止' })
    expect(statusTone(undefined)).toEqual({ tone: 'danger', label: '已停止' })
  })
})
