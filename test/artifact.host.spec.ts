/**
 * The shape of what this plugin delivers to the host: the tools it registers, the JSON schema they
 * must keep (a lowercase subset, `additionalProperties` boolean, inside a size budget), and the
 * registration contract. Nothing here drives a device or a screen.
 */
import { describe, it, expect, vi } from 'vitest'
import { apply } from '../lib/index.js'
import { createHostContext, mountPlugin } from './harness.js'

/** Every tool the plugin registers, in order. */
function mountTools() {
  return mountPlugin().tools
}

describe('tool surface', () => {
  it('registers hmos_lint next to the existing tools', () => {
    const names = mountTools().map((d) => d.name)
    expect(names).toEqual(['emu', 'emu_ui', 'hmos_deploy', 'hmos_device', 'hmos_log', 'hmos_docs', 'hmos_lint'])
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
    // keeps the bound honest. The bound covers the layout window scope (`window` /
    // `allWindows`: a focused-window dump leaves out system pickers and UIExtension panels
    // entirely), the gesture-speed fixes
    // (`swipe`/`fling` never forwarded it, a speedless drag moved nothing) and the two capability
    // notes; measured 8 237 after `thenWaitFor` stopped restating `waitFor`'s fields.
    //
    // Raised to 10 200 for the debugging capabilities devecocli already had and this plugin did not:
    // `emu` gained six device controls (rotate, power, volume, battery, geolocation, shake),
    // `hmos_deploy` gained a clean action plus a module list, and `hmos_device` is new — the device's
    // details, one file in or out, and SQL against a database on it. Six verbs and fourteen parameters
    // the model can call directly, measured 10 126, about 650 tokens per request. The wording is the
    // shortest form that still names every flag; the flags themselves are the purchase.
    //
    // What it buys in rounds, not only tokens: the control verbs live in the tool the model is
    // already calling, so using one costs no extra round. Split into its own tool they would have to
    // be discovered first — and a deferred declaration is not offered until something activates it —
    // so the 700 characters saved there are paid back by a single retry: output is priced around
    // 200x cached input on the same route (deepseek-flash: 0.02 vs 4 yuan per million), and one
    // retry spends far more than the whole 900 characters cost across thousands of requests. Merged
    // is the cheaper arrangement at any realistic volume; the schema is resident, the round is not.
    const total = mountTools()
      .reduce((sum, def) => sum + JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters }).length, 0)
    expect(total).toBeLessThan(10200)
  })

  it('keeps every tool inside its own share of the budget', () => {
    // One composite tool carries the whole action surface, so it gets the only large share; every
    // other tool is a single-purpose wrapper and must stay small. Caps sit just above the measured
    // cost (emu_ui 4 765, hmos_log 913, hmos_deploy 1 117, hmos_docs 771, hmos_lint 607, emu 1 049,
    // hmos_device 904 — the middle three rose with the control group, the build options and the
    // device verbs, as the budget test above explains), so a message that grows them has to be a
    // deliberate edit here.
    const caps = { emu_ui: 4900, hmos_log: 1000, hmos_deploy: 1200, hmos_device: 1000, hmos_docs: 1000, hmos_lint: 1000, emu: 1100 }
    const over = mountTools()
      .map((def) => ({ name: def.name, cost: JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters }).length }))
      .filter((tool) => tool.cost >= caps[tool.name])
    expect(over).toEqual([])
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

describe('tool registration resilience', () => {
  it('registers each name once per registry and keeps going when one name is taken', () => {
    // A live patch reload reuses the registry instance, so a second mount must not re-register; and
    // one taken name must not strand the tools that come after it.
    const registered = []
    const registry = {
      register: (def) => {
        if (def.name === 'hmos_log') throw new Error('name already taken')
        registered.push(def)
        return () => {}
      },
    }
    const { ctx } = createHostContext({ tools: registry })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      apply(ctx, {})
      const afterFirstMount = registered.map((d) => d.name)
      apply(ctx, {})
      expect(afterFirstMount).toEqual(['emu', 'emu_ui', 'hmos_deploy', 'hmos_device', 'hmos_docs', 'hmos_lint'])
      expect(registered.map((d) => d.name)).toEqual(afterFirstMount)
    } finally {
      logged.mockRestore()
    }
  })
})
