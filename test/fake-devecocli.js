/**
 * A stand-in for `@deveco/deveco-cli`, so `emu_ui` can be exercised without a device.
 *
 * It is NOT loaded by vitest: the plugin spawns it as a child process (`node <this file> ui …`),
 * so it must stay a plain Node program — dependency-free, no types, nothing that needs a transform.
 *
 * The plugin only ever talks to devecocli through the path in `DSH_HMOS_DEVECO_CLI`, so pointing
 * that variable here drives the real execute path — the argv the plugin builds, the parsing it
 * does on the answer, and the cross-call state it keeps. Answers come from environment variables
 * so one fixture serves every case:
 *
 *   DSH_FAKE_STATE           file whose length counts `ui layout` calls (absent/poll behaviour)
 *   DSH_FAKE_LAYOUT_FIRST    stdout for the first layout call
 *   DSH_FAKE_LAYOUT_LATER    stdout from the second call on (defaults to FIRST)
 *   DSH_FAKE_INSTANCES       stdout for `emulator list --format json`
 *   DSH_FAKE_IMAGES          stdout for `emulator image list --format json`
 *   DSH_FAKE_DEVICES         stdout for `device list --format json`
 *   DSH_FAKE_START/_CODE     stdout and exit code for `emulator start`
 *   DSH_FAKE_STOP/_CODE      stdout and exit code for `emulator stop`
 *   DSH_FAKE_UPDATE/_CODE    stdout and exit code for `update`
 *   DSH_FAKE_PNG             bytes written for `ui screenshot`
 *   DSH_FAKE_BUILD           stdout for `build` (with DSH_FAKE_BUILD_CODE as its exit code)
 *   DSH_FAKE_ARGV_LOG        file each invocation's argv is appended to (one JSON array per line)
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const argv = process.argv.slice(2)
const [group, verb] = argv
const out = (text) => { process.stdout.write(text); process.exit(0) }

// Record the exact argv the plugin built, so a test can assert what was *asked for* — a depth, a
// flag — rather than inferring it from the answer.
if (process.env.DSH_FAKE_ARGV_LOG) {
  try { appendFileSync(process.env.DSH_FAKE_ARGV_LOG, `${JSON.stringify(argv)}\n`) } catch { /* best effort */ }
}

if (group === 'emulator' && verb === 'list') out(process.env.DSH_FAKE_INSTANCES || '[]')

// `--version` reports which build is installed, so an upgrade's dist-tag can be asserted: the plugin
// reads this to decide the channel it follows.
if (argv[0] === '--version') out(process.env.DSH_FAKE_VERSION || '1.3.0-stable')

// System images back the pre-start check: an instance whose image is missing must not be started.
if (group === 'emulator' && verb === 'image') out(process.env.DSH_FAKE_IMAGES || '[]')

// Emulator lifecycle: the caller asserts the argv and the exit code, never a window.
if (group === 'emulator' && (verb === 'start' || verb === 'stop')) {
  const text = process.env[verb === 'start' ? 'DSH_FAKE_START' : 'DSH_FAKE_STOP']
  if (text) process.stdout.write(text)
  process.exit(Number(process.env[verb === 'start' ? 'DSH_FAKE_START_CODE' : 'DSH_FAKE_STOP_CODE'] || '0'))
}

// Device enumeration: the same JSON shape the real CLI prints for `device list --format json`.
if (group === 'device' && verb === 'list') out(process.env.DSH_FAKE_DEVICES || '[]')

// `update` reinstalls the CLI; here it only reports what the caller asked to see.
if (group === 'update') {
  if (process.env.DSH_FAKE_UPDATE) process.stdout.write(process.env.DSH_FAKE_UPDATE)
  process.exit(Number(process.env.DSH_FAKE_UPDATE_CODE || '0'))
}

if (group === 'ui' && verb === 'layout') {
  const state = process.env.DSH_FAKE_STATE
  let seen = 0
  if (state) {
    try { seen = readFileSync(state, 'utf8').length } catch { seen = 0 }
    appendFileSync(state, 'x')
  }
  out(seen === 0
    ? (process.env.DSH_FAKE_LAYOUT_FIRST || '')
    : (process.env.DSH_FAKE_LAYOUT_LATER ?? process.env.DSH_FAKE_LAYOUT_FIRST ?? ''))
}

if (group === 'ui' && verb === 'screenshot') {
  const at = argv.indexOf('--path')
  const path = at >= 0 ? argv[at + 1] : ''
  if (path) {
    mkdirSync(dirname(path), { recursive: true })
    // `DSH_FAKE_PNG_B64` carries real PNG bytes (base64) for the tests that decode the capture.
    const body = process.env.DSH_FAKE_PNG_B64
      ? Buffer.from(process.env.DSH_FAKE_PNG_B64, 'base64')
      : Buffer.from(process.env.DSH_FAKE_PNG || 'fake-png-bytes')
    writeFileSync(path, body)
  }
  out('screenshot ok')
}

// `docs` answers one search hit and a two-line body, so a search+open call can be asserted without
// the real offline doc set.
if (group === 'docs' && verb === 'search') {
  out(process.env.DSH_FAKE_DOCS_SEARCH || 'sample/doc-1\n  Title: Sample doc\n  Content: A short snippet about the subject.\n')
}
if (group === 'docs' && verb === 'read') {
  out(process.env.DSH_FAKE_DOCS_READ || 'line one\nline two\n')
}

// `log` answers canned hilog lines, so `observe {log:…}` can be asserted.
if (group === 'log') out(process.env.DSH_FAKE_LOG || '')

// `build` answers canned build output with a chosen exit code, so a failed `hmos_deploy` can be
// asserted (colour frames, error wording) without running hvigor.
if (group === 'build') {
  if (process.env.DSH_FAKE_BUILD) process.stdout.write(process.env.DSH_FAKE_BUILD)
  process.exit(Number(process.env.DSH_FAKE_BUILD_CODE || '0'))
}

// A stand-in for a long build. `DSH_FAKE_STUBBORN` makes it ignore SIGTERM, so only the caller's
// SIGKILL escalation ends it — the case that matters when a cancelled build would otherwise keep
// holding the device.
if (process.env.DSH_FAKE_SLEEP_MS) {
  if (process.env.DSH_FAKE_STUBBORN) process.on('SIGTERM', () => { /* hold on until SIGKILL */ })
  setTimeout(() => process.exit(0), Number(process.env.DSH_FAKE_SLEEP_MS))
} else {
  // Interaction verbs (click/text/swipe/...) succeed silently: argv shape is asserted by the caller.
  out('')
}
