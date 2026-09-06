// dsh-hmos-emulator 构建脚本(esbuild,与 dsh-cost-meter 同款模式)。
//   宿主: src/index.ts           → lib/index.js   (ESM, node, 保留 node: 内建)
//   客户端: src/client/index.ts  → lib/client.js  (__ModuleLoader__ 封装产物)
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

// 宿主 ESM
await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(root, 'lib', 'index.js'),
  format: 'esm',
  platform: 'node',
  bundle: false,
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning',
})

// 客户端:封装为 window.__ModuleLoader__.load 产物(与 DSH 官方一致)
const clientBanner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => { const module = { exports: {} }; const exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });`
const clientFooter = `return module.exports; } });`
await build({
  entryPoints: [join(root, 'src', 'client', 'index.ts')],
  outfile: join(root, 'lib', 'client.js'),
  format: 'cjs',
  platform: 'browser',
  bundle: false,
  target: 'es2020',
  banner: { js: clientBanner },
  footer: { js: clientFooter },
  sourcemap: false,
  logLevel: 'warning',
})

console.log('build ok -> lib/index.js, lib/client.js')
