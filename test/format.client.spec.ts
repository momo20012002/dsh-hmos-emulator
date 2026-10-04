/**
 * The panel's formatting rules, exercised without a renderer. They live in a React-free module
 * precisely so a duration, a path or a CLI line can be asserted directly instead of through the DOM.
 */
import { describe, it, expect } from 'vitest'
import { LINT_TITLES, cleanCliLine, exitCodeOf, fmtDur, lintStatusLine, shortPath } from '../src/client/format.js'

describe('panel formatting', () => {
  it('reads a duration as seconds below a minute and as minutes above', () => {
    expect(fmtDur(0)).toBe('0s')
    // A clock skew must not print "-1s".
    expect(fmtDur(-500)).toBe('0s')
    expect(fmtDur(42_400)).toBe('42s')
    expect(fmtDur(59_600)).toBe('1m00s')
    expect(fmtDur(72_000)).toBe('1m12s')
    expect(fmtDur(3_600_000)).toBe('60m00s')
  })

  it('shortens a path to its last two segments and leaves short ones whole', () => {
    expect(shortPath('C:\\a\\b\\c\\App.ets')).toBe('…\\c\\App.ets')
    expect(shortPath('/home/u/app')).toBe('…\\u\\app')
    expect(shortPath('a/b')).toBe('a/b')
    expect(shortPath('App.ets')).toBe('App.ets')
  })

  it('cleans one CLI line: no ANSI colour, no CR, no trailing blanks', () => {
    expect(cleanCliLine('\u001b[32mBUILD SUCCESSFUL\u001b[0m\r  ')).toBe('BUILD SUCCESSFUL')
    // Leading spaces are part of the output; only the tail is noise.
    expect(cleanCliLine('  keep leading  ')).toBe('  keep leading')
    expect(cleanCliLine('plain')).toBe('plain')
  })

  it('reads the streaming exit marker, and nothing else', () => {
    expect(exitCodeOf('[HMOS_EXIT]=0')).toBe(0)
    expect(exitCodeOf('[HMOS_EXIT]=1')).toBe(1)
    expect(exitCodeOf('deploy finished')).toBeNull()
    expect(exitCodeOf(' x [HMOS_EXIT]=0')).toBeNull()
  })

  it('prefers the host wording for a check and falls back to raw counts', () => {
    expect(lintStatusLine({ stats: '未发现告警', summary: { errors: 1 } })).toBe('未发现告警')
    expect(lintStatusLine({ summary: { errors: 2, warnings: 3, suggestions: 4, files: 5 } }))
      .toBe('错误 2、警告 3、建议 4、涉及文件 5')
    // An older host sends neither, so the row dashes out instead of printing "undefined".
    expect(lintStatusLine({})).toBe('错误 -、警告 -、建议 -、涉及文件 -')
    expect(Object.keys(LINT_TITLES)).toEqual(['changed', 'all', 'fix', 'fix-all'])
  })
})
