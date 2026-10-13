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
    expect(names).toEqual(['emu', 'emu_ui', 'hmos_deploy', 'hmos_device', 'hmos_log', 'hmos_docs', 'hmos_lint', 'hmos_setup'])
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
    // Raised to 12 800 for capabilities reached through a tool a caller already holds, plus one new tool:
    // `emu` gained fold/scene (a foldable's physical shape, whose accepted values differ by model, and the
    // three motion scenes a navigation or fitness app reads), `hmos_lint` grew from a linter into the
    // project-check tool (kind=lint | arkts | compat), `emu_ui` gained windows — the list its own `window`
    // parameter used to assume — and `hmos_setup` carries the jobs that come up about once per project
    // rather than once per round (scaffold an app, sign it, create or delete an instance). The first three
    // are new verbs inside tools already in hand, so none of them costs the extra round a separate tool
    // would; `hmos_setup` is separate precisely because those jobs are rare, and a capability the model
    // cannot see is one it cannot ask for. Its description opens with the rule that gates it — call only
    // when the user asks — which is not a saving but a safeguard: those verbs write to disk, so an
    // unasked scaffold or instance costs a cleanup round, not just a call. Raised again to 13 450 for
    // `hmos_log`'s `since:"earliest"`: `--tail` only ever means the newest N, so reading a device's buffer
    // from its first line was reachable only by guessing a window wide enough and retrying — one sentence
    // and a two-word parameter replace that guesswork.
    // Measured: total rose 13 203 → 13 387 with this read (only `hmos_log` grew, 913 → 1 097), while
    // emu stays 1 317, hmos_lint 1 297, emu_ui 4 866, hmos_setup 1 538 and deploy 1 570.
    const total = mountTools()
      .reduce((sum, def) => sum + JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters }).length, 0)
    expect(total).toBeLessThan(13450)
  })

  it('keeps every tool inside its own share of the budget', () => {
    // One composite tool carries the whole action surface, so it gets the only large share; every
    // other tool is a single-purpose wrapper and must stay small. Caps sit just above the measured
    // cost (emu_ui 4 866, hmos_log 1 097, hmos_deploy 1 570, hmos_docs 771, hmos_lint 1 297, emu 1 317,
    // hmos_device 904, hmos_setup 1 538 — the middle three rose with the control group, the build options
    // and the device verbs, hmos_lint with the other two checks, emu_ui/emu with windows and fold/scene,
    // hmos_setup with the once-per-project jobs, and hmos_log with the buffer-start read, as the budget
    // test above explains), so a message that grows them has to be a deliberate edit here.
    const caps = { emu_ui: 4900, hmos_log: 1120, hmos_deploy: 1650, hmos_device: 1000, hmos_docs: 1000, hmos_lint: 1400, emu: 1350, hmos_setup: 1650 }
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
      expect(afterFirstMount).toEqual(['emu', 'emu_ui', 'hmos_deploy', 'hmos_device', 'hmos_docs', 'hmos_lint', 'hmos_setup'])
      expect(registered.map((d) => d.name)).toEqual(afterFirstMount)
    } finally {
      logged.mockRestore()
    }
  })
})
