/**
 * Pure functions: parsers and helpers called directly — no tool call, no HTTP route. Everything
 * here runs without a device and without devecocli (real git / temp-dir I/O is fine).
 * A new case belongs here when it does NOT go through `createToolDefs(...).execute()`.
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  ancestorLabels,
  capLines,
  changedCodeFiles,
  cliFromWrapper,
  decodePng,
  diffLines,
  diffPng,
  encodePng,
  labelMatches,
  layoutJson,
  lintScope,
  nodeLabel,
  pageTitle,
  parseLintTable,
  parseBuildErrors,
  deployPhase,
  parseLogLines,
  parseLayoutLine,
  pruneAutoShots,
  pruneToolShots,
  sessionWorkspace,
  SHOT_KEEP,
  sliceText,
  stepSummary,
  untrackedCodeFiles,
} from '../lib/index.js'

/**
 * Every fixture below keeps the exact SHAPE the parsers must survive (lint table, hvigor
 * failure, layout dumps), because that shape is the whole point of these parsers — but the content
 * is sanitized: project names, bundle names, user names, local paths and the app's own UI copy are
 * replaced with neutral examples — the directory and file names inside those paths included, since
 * a neutral project prefix alone still leaks `ets/components/<real component>.ets`. This repository
 * is public: a test file is not a place to carry a real app's identity. Never paste a raw capture in.
 */

const LINT_TABLE = `CodeLinter report

No  File                                                              Line  Column  Severity    Rule                                                 Message
--  ----------------------------------------------------------------  ----  ------  ----------  ---------------------------------------------------  ------------------------------------------------------------------------------
1   DemoApp/entry/src/main/ets/pages/settings/About.ets          8     15      Warning     @performance/avoid-overusing-custom-component-check  Preferentially use the @Builder method instead of custom components.
2   DemoApp/entry/src/main/ets/services/SyncService.ets                  135   21      Warning     @performance/bad-deep-clone-check                    Prioritize structured clone for deep clone operations.
3   DemoApp/entry/src/main/module.json5                                 49    27      Suggestion  @performance/start-window-icon-check                 For faster app startup, keep the startup icon size within 256 x 256 pixels.
Summary: Issues: 10 | Errors: 0 | Warnings: 9 | Suggestions: 1 | Files checked: 7`

const BUILD_FAILURE = `> hvigor ERROR: 00305015 Rollup Error
Error Message: Unexpected token (Note that you need plugins to import files that are not JavaScript)
. At file: C:\\Temp\\hmos-broken\\entry\\src\\main\\ets\\components\\panel\\PanelBody.ets:185
1 ERROR: 10505001 ArkTS Compiler Error
Error Message: Expression expected. At File: C:/Temp/hmos-broken/entry/src/main/ets/components/panel/PanelBody.ets:185:34


COMPILE RESULT:FAIL {ERROR:2 WARN:27}

* Try:
> Run with --stacktrace option to get the stack trace.
> hvigor ERROR: BUILD FAILED in 26 s 363 ms`

const RUN_OK = `[hvigor build] Running...
> hvigor BUILD SUCCESSFUL in 263 ms 
Build completed successfully.
Installing artifacts to device 127.0.0.1:5555...
App installed successfully
Launching com.example.demo/EntryAbility...
Application 'com.example.demo': start ability successfully.`

const HILOG = `- Preparing log request…
09-13 21:49:14.737 10388 10388 W C02c02/PARAM: SystemReadParam failed!name is:persist.init.debug.loglevel,err:1002
09-13 21:49:14.772   128   156 I C01800/SAMGR: NF SA:65962,844_87807
not a log line at all`

describe('parseLintTable', () => {
  it('reads the report rows and the summary counts', () => {
    const { findings, summary } = parseLintTable(LINT_TABLE)
    expect(findings).toHaveLength(3)
    expect(findings[0]).toMatchObject({
      file: 'DemoApp/entry/src/main/ets/pages/settings/About.ets',
      line: 8,
      column: 15,
      severity: 'Warning',
      rule: '@performance/avoid-overusing-custom-component-check',
    })
    expect(findings[0].message).toMatch(/^Preferentially use the @Builder/)
    expect(findings[2]).toMatchObject({ severity: 'Suggestion', line: 49, column: 27 })
    // The summary counts come from the trailing Summary line, not from the rows we happen to keep.
    expect(summary).toEqual({ issues: 10, errors: 0, warnings: 9, suggestions: 1, files: 7 })
  })

  it('returns an empty result for text with no table', () => {
    expect(parseLintTable('No defects found.').findings).toEqual([])
    expect(parseLintTable('No defects found.').summary).toBeNull()
  })
})

describe('parseBuildErrors', () => {
  it('extracts file/line/column/message from the ArkTS error block', () => {
    const { errors, errorCount, warnCount } = parseBuildErrors(BUILD_FAILURE)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      line: 185,
      column: 34,
      code: '10505001',
      message: 'Expression expected.',
    })
    expect(errors[0].file).toMatch(/PanelBody\.ets$/)
    // The severity totals come from COMPILE RESULT, which is authoritative: the rollup block
    // spells its tail differently and is not one of the numbered ArkTS blocks.
    expect(errorCount).toBe(2)
    expect(warnCount).toBe(27)
  })

})

describe('deployPhase', () => {
  it('reads the furthest stage marker', () => {
    expect(deployPhase('[hvigor build] Running...\n> hvigor ERROR: BUILD FAILED in 26 s')).toBe('build')
    expect(deployPhase('Build completed successfully.\nInstalling artifacts to device 127.0.0.1:5555...')).toBe('install')
    expect(deployPhase(RUN_OK)).toBe('launch')
  })
})

describe('parseLogLines', () => {
  it('splits hilog lines and keeps the tag after the domain slash', () => {
    const lines = parseLogLines(HILOG)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({
      time: '09-13 21:49:14.737',
      level: 'W',
      tag: 'PARAM',
      message: 'SystemReadParam failed!name is:persist.init.debug.loglevel,err:1002',
    })
    expect(lines[1]).toMatchObject({ level: 'I', tag: 'SAMGR' })
  })

  it('drops lines that are not log records', () => {
    expect(parseLogLines('- Preparing log request…')).toEqual([])
  })
})

describe('parseLayoutLine', () => {
  it('reads the widget type, bounds and flags', () => {
    const line = parseLayoutLine('  Column [264,2688,528,2856] clickable')
    expect(line).toMatchObject({ type: 'Column', clickable: true, indent: 2 })
    expect(line.bounds).toEqual([264, 2688, 528, 2856])
  })

  it('handles the bare root bounds line, which has no type', () => {
    const line = parseLayoutLine('[0,0,1320,2856]')
    expect(line.type).toBe('')
    expect(line.bounds).toEqual([0, 0, 1320, 2856])
  })

  it('parses the container types only --mode full prints', () => {
    // Full mode keeps the unlabeled containers the default mode prunes, and those types carry
    // underscores and dots the type regex has to survive.
    expect(parseLayoutLine('    __Common__ [928,2702,1264,2814]').type).toBe('__Common__')
    expect(parseLayoutLine('        NavDestination [0,137,1320,2856]').type).toBe('NavDestination')
    expect(parseLayoutLine('      Stack#GlobalSearch-Index_Stack_blur [0,137,1320,2856]').type).toBe('Stack')
    expect(parseLayoutLine('          Blank [334,2702,886,2814]').type).toBe('Blank')
  })
})

/**
 * Real dump shape: a bottom tab's label lives in a Text child while the clickable
 * node is the Column above it, so a `filter{clickableOnly}` match reports a node with no text.
 */
const TAB_TREE = [
  '[0,0,1320,2856]',
  '  Column [1056,2688,1320,2856] clickable',
  '    Text [1139,2807,1238,2856] "Tab"',
]

describe('nodeLabel / layoutJson', () => {
  const lines = TAB_TREE.map(parseLayoutLine)

  it('inherits the first child text for a container with no text of its own', () => {
    expect(nodeLabel(lines, 1)).toBe('Tab')
  })

  it('prefers the node own text', () => {
    expect(nodeLabel(lines, 2)).toBe('Tab')
  })

  it('adds label to a JSON node that matched through a child', () => {
    const nodes = layoutJson([{ index: 1, line: lines[1] }], lines)
    expect(nodes[0]).toMatchObject({ id: 1, type: 'Column', clickable: true, label: 'Tab' })
    expect(nodes[0].text).toBeUndefined()
  })

})

/**
 * Shape follows a card list where repeated labels need their container: one card container per item,
 * a title inside it, and a Button per card whose text is the same 「Start」 everywhere. The
 * indentation and the container/text nesting are the ones a real `ui layout` prints; the titles
 * stand in for whatever the cards hold.
 */
const CARD_LIST = [
  '[0,0,1320,2856]',
  '  Column [0,137,1320,2856]',
  '    Column [40,600,1280,900] clickable',
  '      Text [80,640,700,700] "Alpha card"',
  '      Row [900,760,1240,860] clickable',
  '        Text [980,780,1180,840] "Start"',
  '    Column [40,940,1280,1240] clickable',
  '      Text [80,980,700,1040] "Beta card"',
  '      Row [900,1100,1240,1200] clickable',
  '        Text [980,1120,1180,1180] "Start"',
  '    Column [40,1280,1280,1580] clickable',
  '      Text [80,1320,700,1380] "Gamma card"',
  '      Row [900,1440,1240,1540] clickable',
  '        Text [980,1460,1180,1520] "Start"',
]

describe('labelMatches', () => {
  const lines = CARD_LIST.map(parseLayoutLine)

  it('counts each repeated label as its own tappable candidate', () => {
    const matches = labelMatches(lines, 'Start')
    expect(matches).toHaveLength(3)
    // Every candidate resolves to the clickable Row of its own card, not to a shared ancestor.
    expect(matches.map((m) => m.target.bounds)).toEqual([
      [900, 760, 1240, 860],
      [900, 1100, 1240, 1200],
      [900, 1440, 1240, 1540],
    ])
  })

  it('selects the nth candidate, so a caller can disambiguate instead of pressing the first', () => {
    expect(labelMatches(lines, 'Start')[2].target.bounds).toEqual([900, 1440, 1240, 1540])
  })

  it('collapses two nodes resolving to the same control into one candidate', () => {
    const nested = ['  Column [0,0,100,100] clickable "确定"', '    Text [10,10,90,90] "确定"'].map(parseLayoutLine)
    expect(labelMatches(nested, '确定')).toHaveLength(1)
  })

  it('marks a containment-only match as inexact', () => {
    const matches = labelMatches(lines, 'Alpha')
    expect(matches).toHaveLength(1)
    expect(matches[0].exact).toBe(false)
  })

})

describe('ancestorLabels', () => {
  const lines = CARD_LIST.map(parseLayoutLine)
  // The second card's button: its breadcrumb must name its own card, not the first one.
  const second = labelMatches(lines, 'Start')[1].targetIndex

  it('reads as a breadcrumb of the containers the control sits in', () => {
    expect(ancestorLabels(lines, second)).toEqual(['Beta card', 'Start'])
  })

  it('never names a sibling item as the parent', () => {
    // The page-level Column inherits the FIRST text under it, which is another card's title: the
    // area guard has to stop the walk before that container.
    expect(ancestorLabels(lines, second)).not.toContain('Alpha card')
  })

  it('stays within the requested depth', () => {
    expect(ancestorLabels(lines, second, 2)).toHaveLength(2)
  })
})

/** A full-mode dump of a running app: containers only, no text anywhere. */
const LAYOUT_FULL = [
  '[0,0,1320,2856]',
  '  root [0,137,1320,2856]',
  '    Navigation [0,137,1320,2856]',
  '      NavigationContent [0,137,1320,2856]',
  '        NavDestination [0,137,1320,2856]',
  '          NavDestinationContent [0,137,1320,2856]',
  '            Stack [0,137,1320,2856]',
  '              Column [0,137,1320,2856]',
  '              Column [0,137,1320,2856]',
  '                Row [0,137,1320,318]',
  '                  Image [56,185,140,269] clickable',
  '                  Text [140,190,1096,264] "Page title"',
  '                  Text [1096,178,1264,276] "17 分 7 秒"',
  '                Column [0,318,1320,2856]',
  '                  Row [0,318,1320,409]',
  '                    Text [56,360,519,409] "Tap where it belongs"',
  '                    Text [1177,360,1264,409] "0 / 3"',
  '                  Stack [0,594,1320,2660] clickable',
  '                    Image [0,594,1320,2660]',
  '                  Row [0,2660,1320,2856]',
  '                    Text [56,2738,292,2779] "Miss 0 · Empty 0"',
  '                    __Common__ [928,2702,1264,2814]',
  '                      Row [928,2702,1264,2814] clickable',
  '                        Text [1012,2734,1181,2783] "Hint"',
].join('\n')

/**
 * The same page as the default (simplified) mode prints it — the simplified dump drops the
 * unlabeled containers entirely and therefore has no NavDestination to read a title from.
 */
const LAYOUT_SIMPLIFIED = [
  '[0,0,1320,2856]',
  '  Image [56,185,140,269] clickable',
  '  Text [140,190,1096,264] "Page title"',
  '  Text [1096,178,1264,276] "17 分 5 秒"',
  '  Text [56,360,519,409] "Tap where it belongs"',
  '  Text [1177,360,1264,409] "0 / 3"',
  '  Text [56,437,1264,503] "Find: sample target"',
  '  Text [56,517,1264,566] "Second line of sample content"',
  '  Stack [0,594,1320,2660] clickable',
  '  Text [56,2738,292,2779] "Miss 0 · Empty 0"',
  '  Row [928,2702,1264,2814] clickable',
  '    Text [1012,2734,1181,2783] "Hint"',
].join('\n')

describe('pageTitle', () => {
  it('prefers the shallowest text inside the NavDestination subtree', () => {
    expect(pageTitle(LAYOUT_FULL.split('\n').map(parseLayoutLine))).toBe('Page title')
  })

  it('falls back to the first top-level text when the dump has no NavDestination', () => {
    expect(pageTitle(LAYOUT_SIMPLIFIED.split('\n').map(parseLayoutLine))).toBe('Page title')
  })

  it('refuses a first text that sits deep in the page', () => {
    // The top of the screen carries no words, and the first text is a stat number
    // two levels down — reporting "0" as the page title names nothing.
    const HOME = [
      '[0,0,1320,2856]',
      '  TextInput [56,164,1264,318] clickable longClickable scrollable',
      '  Swiper [56,360,1264,948] scrollable',
      '      Text [112,762,364,836] "Sample card"',
      '  Text [231,1046,281,1144] "0"',
      '  Text [193,1158,320,1207] "Stat"',
    ].join('\n')
    expect(pageTitle(HOME.split('\n').map(parseLayoutLine))).toBe('')
  })

  it('refuses a bare number even when it really is the first top-level text', () => {
    // The cards' text is absent (images only), so the
    // first text at indent ≤ 2 is a statistics counter — before this guard `page` answered "0".
    const HOME_NO_CARD_TEXT = [
      '[0,0,1320,2856]',
      '  TextInput [56,164,1265,319] clickable longClickable scrollable',
      '  Image [1131,199,1215,283] clickable',
      '  Swiper [56,360,1264,948] scrollable',
      '  Text [231,1046,281,1144] "0"',
      '  Text [193,1158,320,1207] "Pending"',
    ].join('\n')
    expect(pageTitle(HOME_NO_CARD_TEXT.split('\n').map(parseLayoutLine))).toBe('')
    // A real top-level title still comes through.
    const WITH_TITLE = [
      '[0,0,1320,2856]',
      '  Text [140,190,1096,264] "Sample title"',
      '  Text [231,1046,281,1144] "0"',
    ].join('\n')
    expect(pageTitle(WITH_TITLE.split('\n').map(parseLayoutLine))).toBe('Sample title')
  })
})

describe('diffLines', () => {
  const before = [
    '  #8 Text [231,1046,281,1144] "0"',
    '  #9 Text [193,1158,320,1207] "Stat"',
    '  #13 Text [1177,360,1264,409] "0 / 3"',
  ]

  it('answers changed:0 when nothing moved', () => {
    expect(diffLines(before, [...before])).toBe('changed:0')
  })

  it('reports one changed line instead of the whole tree', () => {
    const after = [...before.slice(0, 2), '  #13 Text [1177,360,1264,409] "1 / 3"']
    expect(diffLines(before, after)).toBe([
      '-   #13 Text [1177,360,1264,409] "0 / 3"',
      '+   #13 Text [1177,360,1264,409] "1 / 3"',
    ].join('\n'))
  })

  it('treats a repeated line as a multiset, not a set', () => {
    expect(diffLines(['a', 'a'], ['a'])).toBe('- a')
    expect(diffLines(['a'], ['a', 'a'])).toBe('+ a')
  })
})

describe('capLines', () => {
  it('caps by whole lines and says how many are hidden', () => {
    const capped = capLines(Array.from({ length: 81 }, (_, i) => `#${i}`))
    expect(capped).toHaveLength(81)
    expect(capped[79]).toBe('#79')
    // The cut is by whole lines: cutting by characters would print a fragment of line 80 that
    // reads like a node.
    expect(capped[80]).toBe('…(还有 1 行未显示;可用 depth 或 filter 收窄)')
  })
})

describe('stepSummary', () => {
  it('names what a step acted on', () => {
    expect(stepSummary('layout', { ok: true, total: 33, page: 'Tab one' })).toBe('page=Tab one 33 节点')
    expect(stepSummary('click', { ok: true, x: 256, y: 1095, ancestors: ['Alpha card', 'Start'], matchCount: 3 }))
      .toBe('Alpha card/Start match=3 (256,1095)')
    expect(stepSummary('waitFor', { ok: true, matched: [{ id: 1 }] })).toBe('matched=1')
  })

  it('carries the failure text, which is the reason the batch stopped', () => {
    expect(stepSummary('click', { ok: false, error: 'no layout node matching "x"' })).toBe('no layout node matching "x"')
  })

})


describe('lintScope', () => {
  it('answers `changed` with the files it will cover', () => {
    expect(lintScope('changed', ['entry/src/main/ets/A.ets'])).toEqual({
      full: false, escalated: false, checkedFiles: ['entry/src/main/ets/A.ets'],
    })
    expect(lintScope('changed', [])).toEqual({ full: false, escalated: false, checkedFiles: [] })
  })

  it('escalates to the full check when no change set can be had', () => {
    // The failure this prevents: --incremental inspects nothing, prints a clean summary, and the
    // caller believes its 7 edited files were checked.
    expect(lintScope('changed', null)).toEqual({ full: true, escalated: true, checkedFiles: null })
  })

})

const GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

/**
 * These three shell out to real `git` several times each and build throwaway repositories, which on
 * a busy machine can exceed vitest's 5 s default (observed once: a 7.6 s run with one timeout).
 */
const GIT_TEST_TIMEOUT = 30000

describe('changedCodeFiles', () => {
  /** A throwaway repo with the project one level down, so path rebasing is genuinely exercised. */
  function scratchRepo() {
    const root = join(tmpdir(), `dsh-lint-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const project = join(root, 'DemoApp')
    mkdirSync(join(project, 'entry'), { recursive: true })
    const git = (args, cwd = root) => spawnSync('git', args, { cwd, encoding: 'utf8' })
    git(['init', '-q'])
    git(['config', 'user.email', 'test@test'])
    git(['config', 'user.name', 'test'])
    writeFileSync(join(project, 'entry', 'Alpha.ets'), 'const a = 1\n')
    writeFileSync(join(project, 'entry', 'Beta.ets'), 'const b = 1\n')
    writeFileSync(join(project, 'entry', 'zeta.md'), 'x\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'init'])
    return { root, project, git }
  }

  it.skipIf(!GIT)('lists tracked code changes project-relative and skips untracked files', async () => {
    const { root, project } = scratchRepo()
    writeFileSync(join(project, 'entry', 'Alpha.ets'), 'const a = 2\n')
    writeFileSync(join(project, 'entry', 'Beta.ets'), 'const b = 2\n')
    writeFileSync(join(project, 'entry', 'zeta.md'), 'y\n')
    writeFileSync(join(project, 'entry', 'Untracked.ets'), 'const c = 3\n')
    const files = await changedCodeFiles(project)
    // Alpha.ets is the first status line, so it arrives trimmed — a leading space would shift it; the
    // rebase has to drop the repo-root `DemoApp/` prefix the caller never uses; codelinter's
    // --incremental ignores untracked files, and markdown is not code.
    expect(files).toEqual(['entry/Alpha.ets', 'entry/Beta.ets'])
    rmSync(root, { recursive: true, force: true })
  }, GIT_TEST_TIMEOUT)

  it.skipIf(!GIT)('answers null when the project is not a repository', async () => {
    const dir = join(tmpdir(), `dsh-lint-nogit-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    expect(await changedCodeFiles(dir)).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  }, GIT_TEST_TIMEOUT)

  it.skipIf(!GIT)('reports a clean tree as an empty list, not as unknown', async () => {
    const { root, project } = scratchRepo()
    expect(await changedCodeFiles(project)).toEqual([])
    rmSync(root, { recursive: true, force: true })
  }, GIT_TEST_TIMEOUT)

  // `--incremental` cannot see a file that was never added, so a refactor that *adds* files
  // read as a clean run. The lint behaviour stays as it is; the caller is told what was skipped.
  it.skipIf(!GIT)('lists the untracked code files separately from the tracked changes', async () => {
    const { root, project } = scratchRepo()
    writeFileSync(join(project, 'entry', 'Alpha.ets'), 'const a = 2\n')
    writeFileSync(join(project, 'entry', 'Untracked.ets'), 'const c = 3\n')
    writeFileSync(join(project, 'entry', 'Untracked.md'), 'notes\n')
    expect(await changedCodeFiles(project)).toEqual(['entry/Alpha.ets'])
    // Code files only, and project-relative like the tracked list.
    expect(await untrackedCodeFiles(project)).toEqual(['entry/Untracked.ets'])
    rmSync(root, { recursive: true, force: true })
  }, GIT_TEST_TIMEOUT)

  it.skipIf(!GIT)('reports no untracked files for a clean tree', async () => {
    const { root, project } = scratchRepo()
    expect(await untrackedCodeFiles(project)).toEqual([])
    rmSync(root, { recursive: true, force: true })
  }, GIT_TEST_TIMEOUT)
})

describe('sessionWorkspace', () => {
  it('reads the session cwd off the tool-call context', () => {
    expect(sessionWorkspace({ agent: { session: { header: { cwd: 'E:\\ws' } } } })).toBe('E:\\ws')
  })

  it('falls back to the host cwd when there is no session', () => {
    expect(sessionWorkspace(undefined)).toBe(process.cwd())
    expect(sessionWorkspace({ agent: { session: { header: { cwd: '  ' } } } })).toBe(process.cwd())
  })
})

describe('sliceText', () => {
  it('hands back where to continue instead of dropping the tail', () => {
    expect(sliceText('abcdefghij', 2, 4)).toEqual({ text: 'cdef', total: 10, offset: 2, nextOffset: 6 })
    expect(sliceText('abcdefghij', 6, 4)).toEqual({ text: 'ghij', total: 10, offset: 6, nextOffset: null })
  })

  it('treats an offset past the end as an empty last page', () => {
    expect(sliceText('abc', 50, 10)).toEqual({ text: '', total: 3, offset: 50, nextOffset: null })
  })
})

describe('shot pruning by ownership', () => {
  /**
   * A screenshots directory holding all three kinds of shot, oldest first: `auto-*` (failure shots),
   * `tool-*` (captures the model tools took) and `hmos-shot-*` (the panel's — the user's own).
   */
  function shotDir(autoCount, manualCount, toolCount = 0) {
    const dir = join(tmpdir(), `dsh-shots-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const stamp = (name, ageSeconds) => {
      const file = join(dir, name)
      writeFileSync(file, 'png')
      const when = new Date(Date.now() - ageSeconds * 1000)
      utimesSync(file, when, when)
    }
    for (let i = 0; i < autoCount; i += 1) stamp(`auto-waitFor-${1000 + i}.png`, autoCount - i)
    for (let i = 0; i < manualCount; i += 1) stamp(`hmos-shot-${2000 + i}-dev.png`, manualCount - i)
    for (let i = 0; i < toolCount; i += 1) stamp(`tool-${3000 + i}-dev.png`, toolCount - i)
    return dir
  }

  it('keeps the newest SHOT_KEEP automatic shots and never touches a hand-taken one', () => {
    // The number is user-facing — it decides how far back a capture survives — and was raised
    // 20 → 40 on 2026-09-19 at the user's request; pinning it keeps a refactor from moving it.
    expect(SHOT_KEEP).toBe(40)
    const dir = shotDir(45, 3)
    expect(pruneAutoShots(dir)).toBe(5)
    const left = readdirSync(dir)
    expect(left.filter((f) => f.startsWith('auto-'))).toHaveLength(SHOT_KEEP)
    // The real directory already held tens of megabytes taken by hand; none of them may disappear.
    expect(left.filter((f) => f.startsWith('hmos-shot-'))).toHaveLength(3)
    expect(left).toContain('auto-waitFor-1044.png')
    expect(left).not.toContain('auto-waitFor-1000.png')
    rmSync(dir, { recursive: true, force: true })
  })

  // Hand-taken shots must never be auto-deleted. The tool takes far more captures than the
  // failure paths do, so it needs its own cap — and the cap must be provably unable to reach a file
  // the plugin did not write.
  it('prunes only the tool\'s own captures, down to the newest SHOT_KEEP', () => {
    const dir = shotDir(2, 4, 43)
    expect(pruneToolShots(dir)).toBe(3)
    const left = readdirSync(dir)
    expect(left.filter((f) => f.startsWith('tool-'))).toHaveLength(SHOT_KEEP)
    expect(left).toContain('tool-3042-dev.png')
    expect(left).not.toContain('tool-3000-dev.png')
    // Both other kinds survive untouched: the user's shots, and the failure shots the auto path owns.
    expect(left.filter((f) => f.startsWith('hmos-shot-'))).toHaveLength(4)
    expect(left.filter((f) => f.startsWith('auto-'))).toHaveLength(2)
    rmSync(dir, { recursive: true, force: true })
  })

  it('never lets one pruner eat another kind: each prefix is exclusive', () => {
    const dir = shotDir(45, 45, 45)
    pruneAutoShots(dir)
    pruneToolShots(dir)
    const left = readdirSync(dir)
    // 5 + 5 removed, 40 + 45 + 40 left — true only because no name matches two prefixes.
    expect(left).toHaveLength(125)
    expect(left.filter((f) => f.startsWith('hmos-shot-'))).toHaveLength(45)
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves a directory under the limit alone', () => {
    const dir = shotDir(3, 1)
    expect(pruneAutoShots(dir)).toBe(0)
    expect(readdirSync(dir)).toHaveLength(4)
    rmSync(dir, { recursive: true, force: true })
  })

})

// ── screenshot baseline diff (2026-09-16 requirement) ───────────────────

/** Make sure the decoder is checked against blueprints rather than a checked-in blob. */
function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0)
  return Buffer.concat([head, data, crc])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** `rows` is an array of rows of channel bytes; `filter` is applied, so decoding must undo it. */
function png(width, channels, rows, filter = 0) {
  const stride = width * channels
  const raw = Buffer.alloc(rows.length * (stride + 1))
  rows.forEach((row, y) => {
    raw[y * (stride + 1)] = filter
    const start = y * (stride + 1) + 1
    for (let i = 0; i < stride; i += 1) {
      const byte = row[i]
      const left = i >= channels ? row[i - channels] : 0
      const up = y > 0 ? rows[y - 1][i] : 0
      const upLeft = y > 0 && i >= channels ? rows[y - 1][i - channels] : 0
      const predicted = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? ((left + up) >> 1)
              : paeth(left, up, upLeft)
      raw[start + i] = (byte - predicted) & 0xff
    }
  })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(rows.length, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const RGB_ROWS = [
  [10, 20, 30, 40, 50, 60, 70, 80, 90],
  [11, 21, 31, 41, 51, 61, 71, 81, 91],
]

describe('decodePng', () => {
  it('undoes every filter type and returns the pixels that went in', () => {
    for (const filter of [0, 1, 2, 3, 4]) {
      const decoded = decodePng(png(3, 3, RGB_ROWS, filter))
      expect(decoded, `filter ${filter}`).toMatchObject({ width: 3, height: 2, channels: 3 })
      expect([...decoded.pixels], `filter ${filter}`).toEqual(RGB_ROWS.flat())
    }
  })

  it('refuses a shape it does not recognise, by name', () => {
    expect(() => decodePng(Buffer.from('not a png at all'))).toThrow(/签名/)
    const sixteen = png(1, 3, [[1, 2, 3]])
    sixteen[24] = 16
    expect(() => decodePng(sixteen)).toThrow(/位深 16/)
    const interlaced = png(1, 3, [[1, 2, 3]])
    interlaced[28] = 1
    expect(() => decodePng(interlaced)).toThrow(/隔行/)
    const palette = png(1, 3, [[1, 2, 3]])
    palette[25] = 3
    expect(() => decodePng(palette)).toThrow(/颜色类型 3/)
  })
})

describe('diffPng', () => {
  const one = decodePng(png(3, 3, RGB_ROWS))
  const same = decodePng(png(3, 3, RGB_ROWS))

  it('calls two identical captures the same', () => {
    expect(diffPng(one, same)).toMatchObject({ same: true, diffRatio: 0, changedPixels: 0 })
  })

  it('reports the fraction of pixels that moved', () => {
    // One of six pixels differs: 1/6 ≈ 0.166667, and it is the pixel count that says "one" at all.
    const moved = decodePng(png(3, 3, [RGB_ROWS[0], [99, 21, 31, 41, 51, 61, 71, 81, 91]]))
    const verdict = diffPng(one, moved)
    expect(verdict.same).toBe(false)
    expect(verdict.changedPixels).toBe(1)
    expect(verdict.totalPixels).toBe(6)
    expect(verdict.diffRatio).toBeCloseTo(0.166667, 6)
  })

  it('treats a resized screen as fully changed', () => {
    const wider = decodePng(png(4, 3, [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]))
    expect(diffPng(one, wider)).toMatchObject({ same: false, diffRatio: 1 })
  })
})

describe('PNG encode and crop', () => {
  const pixels = (w, h, channels) => {
    const buf = Buffer.alloc(w * h * channels)
    for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 7) % 256
    return buf
  }

  it('round-trips RGBA and RGB pixels through encode → decode', () => {
    for (const channels of [4, 3]) {
      const source = { width: 5, height: 3, channels, pixels: pixels(5, 3, channels) }
      const decoded = decodePng(encodePng(source))
      expect(decoded.width).toBe(5)
      expect(decoded.height).toBe(3)
      expect(decoded.channels).toBe(channels)
      expect(decoded.pixels.equals(source.pixels)).toBe(true)
    }
  })

  it('refuses to encode something that is not RGB/RGBA', () => {
    expect(() => encodePng({ width: 2, height: 2, channels: 1, pixels: Buffer.alloc(4) })).toThrow(/通道/)
    expect(() => encodePng({ width: 0, height: 2, channels: 4, pixels: Buffer.alloc(0) })).toThrow(/无法编码/)
  })
})

describe('cliFromWrapper', () => {
  it('traces an npm wrapper to the CLI entry it would run, and refuses what it cannot trace', () => {
    const npmRoot = mkdtempSync(join(tmpdir(), 'dsh-cli-'))
    const entry = join(npmRoot, 'node_modules', '@deveco', 'deveco-cli', 'dist', 'cli.js')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '// entry')
    // The wrappers `npm i -g` writes side by side all launch that same entry, so any of them is a
    // valid way to point at the CLI — Node cannot spawn them (a .cmd needs a shell), so they are
    // traced instead of executed.
    expect(cliFromWrapper(join(npmRoot, 'devecocli.cmd'))).toBe(entry)
    expect(cliFromWrapper(join(npmRoot, 'devecocli.ps1'))).toBe(entry)
    expect(cliFromWrapper(join(npmRoot, 'devecocli'))).toBe(entry)
    // The entry itself is used as given — including a .ts entry, which Node runs by stripping
    // types: reading one as a wrapper makes the plugin fall back to the real CLI on PATH instead.
    expect(cliFromWrapper(entry)).toBe(entry)
    const entryTs = join(npmRoot, 'cli.ts')
    writeFileSync(entryTs, '// a TS entry is an entry too: node runs it by stripping types')
    expect(cliFromWrapper(entryTs)).toBe(entryTs)
    expect(cliFromWrapper(join(npmRoot, 'missing-cli.js'))).toBeUndefined()
    expect(cliFromWrapper(join(tmpdir(), 'no-such-npm-root', 'devecocli.cmd'))).toBeUndefined()
    rmSync(npmRoot, { recursive: true, force: true })
  })
})
