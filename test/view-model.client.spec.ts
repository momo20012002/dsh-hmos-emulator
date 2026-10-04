/**
 * The panel's selection rules, exercised without React: which module, device and project survive an
 * answer from the host. These decisions used to be inline in the component, where only a human
 * clicking through the panel could check them.
 */
import { describe, it, expect } from 'vitest'
import { deviceLabel, keepScannedProject, pickDevice, pickModule, statusTone } from '../src/client/view-model.js'

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
