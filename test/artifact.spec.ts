/**
 * The shape of what this plugin delivers: the tools it registers, the JSON schema they must keep
 * (a lowercase subset, `additionalProperties` boolean, inside a size budget) and the client bundle
 * the page loads. Nothing here drives a device or a screen — it is the contract a consumer sees.
 */
import { describe, it, expect } from 'vitest'
import { apply } from '../lib/index.js'

/** Mount the plugin the way the host does, with every service it polls for already present. */
function mountTools() {
  const registered = []
  const ctx = {
    get: (n) => {
      if (n === 'tools') return { register: (def) => { registered.push(def); return () => {} } }
      if (n === 'webServer') return { host: '127.0.0.1', register: () => () => {} }
      if (n === 'systemPrompt') return { context: () => () => {} }
      return undefined
    },
    effect: (fn) => fn(),
  }
  apply(ctx, {})
  return registered
}

describe('tool surface', () => {
  it('registers hmos_lint next to the existing tools', () => {
    const names = mountTools().map((d) => d.name)
    expect(names).toEqual(['emu', 'emu_ui', 'hmos_deploy', 'hmos_log', 'hmos_docs', 'hmos_lint'])
  })

})

describe('emu_ui batch surface', () => {
  it('exposes steps, waitForChange and changedOnly', () => {
    const emuUi = mountTools().find((d) => d.name === 'emu_ui')
    for (const action of ['steps', 'waitForChange', 'changedOnly']) {
      if (action === 'changedOnly') expect(emuUi.parameters.properties).toHaveProperty('changedOnly')
      else expect(emuUi.parameters.properties.action.enum).toContain(action)
    }
    expect(emuUi.parameters.properties.steps.type).toBe('array')
    expect(emuUi.parameters.properties.onFail.enum).toEqual(['stop', 'continue'])
  })

  it('keeps the resident emulator schema inside its budget', () => {
    // The resident schema (every tool name, description and parameter list) is spent on every
    // request, so it has a budget test. The bound is not a goal: a necessary capability may raise
    // it, but the same commit must say what the extra text buys, and wording that gets shorter
    // keeps the bound honest.
    const total = mountTools()
      .reduce((sum, def) => sum + JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters }).length, 0)
    expect(total).toBeLessThan(8000)
  })
})

describe('emu_ui resident schema', () => {
  it('keeps every additionalProperties boolean so no tool degrades to unknown', () => {
    const offenders = []
    const walk = (node, path) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach((child, index) => walk(child, `${path}[${index}]`))
      for (const [key, value] of Object.entries(node)) {
        if (key === 'additionalProperties' && typeof value !== 'boolean') offenders.push(`${path}.additionalProperties`)
        walk(value, `${path}.${key}`)
      }
    }
    walk(mountTools().find((def) => def.name === 'emu_ui').parameters, 'emu_ui.parameters')
    expect(offenders).toEqual([])
  })
})

describe('client bundle artifact', () => {
  it('registers through window.__ModuleLoader__.load with the package id', async () => {
    let spec
    ;(globalThis as any).window = { __ModuleLoader__: { load: (loaded) => { spec = loaded } } }
    try {
      await import('../lib/client.js')
    } finally {
      delete (globalThis as any).window
    }
    expect(spec).toBeTruthy()
    expect(spec.id).toBe('dsh-hmos-emulator')
    expect(typeof spec.factory).toBe('function')
  })
})
