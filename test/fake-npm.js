/**
 * A stand-in for `npm`, so the global-install path can be asserted on the argv the plugin built
 * without reaching a registry.
 *
 * It is NOT loaded by vitest: the plugin spawns it as a child process (`node <this file> install -g
 * …`) through `DSH_HMOS_NPM`, mirroring how `DSH_HMOS_DEVECO_CLI` stands in for the CLI. It must
 * stay a plain Node program — dependency-free, no types.
 *
 *   DSH_FAKE_NPM_LOG   file each invocation's argv is appended to (one JSON array per line)
 *   DSH_FAKE_NPM_OUT   stdout for an install call
 *   DSH_FAKE_UPDATE_CODE  exit code for an install call
 *   DSH_FAKE_NPM_VERSION / DSH_FAKE_NPM_VIEW_CODE  answer and exit code for `view <spec> version`
 */
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
if (process.env.DSH_FAKE_NPM_LOG) {
  try { appendFileSync(process.env.DSH_FAKE_NPM_LOG, `${JSON.stringify(argv)}\n`) } catch { /* best effort */ }
}
// `view <spec> version` answers the build a channel points at, which the update confirmation shows.
// `DSH_FAKE_NPM_VIEW_WARN` prepends a warning line: npm writes those to stderr and the plugin merges
// both streams, so the answer has to be found by shape rather than by position.
if (argv[0] === 'view') {
  const code = Number(process.env.DSH_FAKE_NPM_VIEW_CODE || '0')
  if (code === 0) {
    if (process.env.DSH_FAKE_NPM_VIEW_WARN) process.stdout.write(`${process.env.DSH_FAKE_NPM_VIEW_WARN}\n`)
    process.stdout.write(process.env.DSH_FAKE_NPM_VERSION || '1.3.4')
  }
  process.exit(code)
}
if (process.env.DSH_FAKE_NPM_OUT) process.stdout.write(process.env.DSH_FAKE_NPM_OUT)
process.exit(Number(process.env.DSH_FAKE_UPDATE_CODE || '0'))
