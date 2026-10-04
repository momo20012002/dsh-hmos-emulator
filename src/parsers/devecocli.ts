/**
 * Parse what devecocli prints: ArkTS build errors, deploy stage markers, hilog lines.
 * Pure text parsing - the colour frames and `\r` redraws are stripped before anyone reads it.
 */
/** One ArkTS compiler error from a failed build. */
export interface BuildError { file: string; line: number; column: number; code: string; message: string }

/**
 * Parse the ArkTS error blocks hvigor prints on a failed build. Shape of a failure:
 *   1 ERROR: 10505001 ArkTS Compiler Error
 *   Error Message: Expression expected. At File: C:/…/PanelBody.ets:185:34
 *   COMPILE RESULT:FAIL {ERROR:2 WARN:27}
 * The rollup variant spells its tail "At file:" lower-case on the next line, hence the tolerant
 * tail; the severity counts come from the COMPILE RESULT line when it is present.
 */
export function parseBuildErrors(text: string): { errors: BuildError[]; errorCount: number; warnCount: number } {
  const src = String(text || '')
  const errors: BuildError[] = []
  const re = /\d+\s+ERROR:\s*(\d+)?\s*[^\n]*\nError Message:\s*([\s\S]*?)\s*At [Ff]ile:\s*([^\n]*?):(\d+)(?::(\d+))?/g
  let m
  while ((m = re.exec(src)) !== null) {
    errors.push({
      file: m[3].trim(),
      line: Number(m[4]),
      column: m[5] ? Number(m[5]) : 0,
      code: (m[1] || '').trim(),
      message: m[2].replace(/\s+/g, ' ').trim(),
    })
  }
  const counts = src.match(/COMPILE RESULT:\w*\s*\{ERROR:(\d+)\s+WARN:(\d+)\}/)
  return { errors, errorCount: counts ? Number(counts[1]) : errors.length, warnCount: counts ? Number(counts[2]) : 0 }
}

/**
 * hvigor prints errors and progress inside colour frames (`\u001b[31m…\u001b[39m`) and redraws
 * progress lines with `\r`. A tool result is read as plain text, so both are removed before the
 * output is parsed or tailed.
 */
export function stripAnsi(text: string): string {
  return String(text || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
}

/**
 * The toolchain checks the module's page list against disk while it assembles the entry list, and
 * throws `10906403 … Page '<path>' does not exist.` when the resolved name has no `.ets` file; a
 * routerMap entry whose buildFunction never got emitted fails the same way. That happens before any
 * page is compiled, so the page's own syntax and type errors are never printed and the build log
 * stops at a message that points away from the real problem.
 */
export function pageMissingHint(text: string): string {
  const src = String(text || '')
  if (!/10906403|Page '[^']*' does not exist|buildFunction[^\n]*does not exist|routerMap[^\n]*does not exist/i.test(src)) return ''
  return '工具链在装配入口页清单时找不到页面或它的 buildFunction(报 does not exist):这一步在页面开始编译之前,所以页面自身的语法/类型错误不会被打出来——先按报错里的路径核对页名与文件是否一致(重命名、挪目录、大小写,或页面在另一个 module),再回看页面源码。'
}

/**
 * Furthest deploy stage the output reached, from the stage markers `devecocli run` prints:
 *   `[hvigor build] Running...`      → `Build completed successfully.`
 *   `Installing artifacts to device` → `App installed successfully`
 *   `Launching <bundle>/<ability>...` → `start ability successfully.`
 * A failed run stops at the stage that failed, so the last marker seen is that stage.
 */
export function deployPhase(text: string): 'build' | 'install' | 'launch' {
  const src = String(text || '')
  if (/Launching\s+\S+/.test(src)) return 'launch'
  if (/Installing artifacts/.test(src)) return 'install'
  return 'build'
}

/** One hilog line, split into the fields a developer filters by. */
export interface LogLine { time: string; level: string; tag: string; message: string }

/**
 * Parse hilog lines. Line format:
 *   `09-13 21:49:14.737 10388 10388 W C02c02/PARAM: SystemReadParam failed!…`
 * `tag` is the part after the domain slash (`PARAM`), which is the name callers know.
 * Lines that do not match (devecocli's progress line, wrapped continuations) are dropped.
 */
export function parseLogLines(text: string): LogLine[] {
  const out: LogLine[] = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^\s*(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([DIWEF])\s+(\S+?):\s?(.*)$/)
    if (!m) continue
    const domainTag = m[5]
    out.push({
      time: m[1],
      level: m[4],
      tag: domainTag.includes('/') ? domainTag.slice(domainTag.lastIndexOf('/') + 1) : domainTag,
      message: m[6].trim(),
    })
  }
  return out
}

