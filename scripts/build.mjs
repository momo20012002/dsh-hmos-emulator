// dsh-hmos-emulator build script (esbuild).
//   host:   src/index.ts          -> lib/index.js   (ESM, node builtins kept)
//   client: src/client/index.ts   -> lib/client.js  (wrapped for __ModuleLoader__)
// Artifacts stay single-file: bundle both halves, and take react from the loader's require.
import { createRequire } from 'node:module'
import { rmSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
let esbuild
try {
  esbuild = require('esbuild')
} catch {
  throw new Error('esbuild 未安装,请先在插件目录运行 `pnpm install`,再 `pnpm build`')
}
const { build } = esbuild

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const ID = 'dsh-hmos-emulator'

mkdirSync(join(root, 'lib'), { recursive: true })

// Host (ESM)
await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(root, 'lib', 'index.js'),
  format: 'esm',
  platform: 'node',
  bundle: true,
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning',
})

// Client: wrapped as a window.__ModuleLoader__.load artifact (the DSH convention).
// Externals are the modules the shell's module table resolves at runtime — react, the shared UI
// primitives the overlay banner comes from, and the client store the two settings persist through —
// so nothing of theirs is bundled here.
const clientBanner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => { const module = { exports: {} }; const exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });`
const clientFooter = `return module.exports; } });`
await build({
  entryPoints: [join(root, 'src', 'client', 'index.ts')],
  outfile: join(root, 'lib', 'client.js'),
  format: 'cjs',
  platform: 'browser',
  bundle: true,
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store'],
  target: 'es2020',
  banner: { js: clientBanner },
  footer: { js: clientFooter },
  sourcemap: false,
  logLevel: 'warning',
  // The entry writes `module.exports = { apply }` on purpose: it is a CommonJS module for the
  // loader above, and the banner supplies the `module` it writes to. esbuild sees the enclosing
  // package as ESM and warns that such a `module` would be a global; here it is the banner's own
  // binding in the factory scope, so the warning is expected and the output is correct.
  logOverride: { 'commonjs-variable-in-esm': 'silent' },
})

console.log('build ok -> lib/index.js, lib/client.js')
