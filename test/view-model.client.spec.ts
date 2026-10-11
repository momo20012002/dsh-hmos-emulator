/**
 * The panel's selection rules, exercised without React: which module, device and project survive an
 * answer from the host. These decisions used to be inline in the component, where only a human
 * clicking through the panel could check them.
 */
import { describe, it, expect } from 'vitest'
import { deviceLabel, isRenderableComponent, keepScannedProject, mountSwitchTitle, pickDevice, pickModule, statusTone } from '../src/client/view-model.js'

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

describe('host component shapes', () => {
  it('accepts every shape React renders, not just functions', () => {
    // The shell's own `Button` is a `forwardRef`, i.e. an object: a function-only test rejects a
    // component that renders perfectly well, which is how the mount confirmation once fell back to its
    // inline form on every host while the dialog was in fact available.
    expect(isRenderableComponent(function Component() { return null })).toBe(true)
    expect(isRenderableComponent(() => null)).toBe(true)
    expect(isRenderableComponent({ $$typeof: Symbol.for('react.forward_ref') })).toBe(true)
    expect(isRenderableComponent({ $$typeof: Symbol.for('react.memo') })).toBe(true)
    // Anything else is not a component, and must leave the caller on its fallback.
    expect(isRenderableComponent(undefined)).toBe(false)
    expect(isRenderableComponent(null)).toBe(false)
    expect(isRenderableComponent('Modal')).toBe(false)
    expect(isRenderableComponent({})).toBe(false)
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
