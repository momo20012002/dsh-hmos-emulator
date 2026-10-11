import { isAbsolute, resolve } from 'node:path'

/**
 * The local half of a device transfer, in one place.
 *
 * Two callers need the same answer — the `hmos_device` tool and the panel's file route — and the rule
 * is subtle enough that two copies would drift: on Windows a device path like `/data/app/db` looks
 * absolute to `path.isAbsolute`, and `resolve` would still read its leading slash against the current
 * drive's root. Keeping one implementation means a fix lands for both.
 */

/**
 * Whether a local path is absolute — without reading a device path as one.
 *
 * On Windows `path.isAbsolute('/data/app/db')` is true, so a device path pasted into `local` would
 * count as absolute and, worse, `resolve` would still read its leading slash against the current
 * drive's root. Only a drive letter or a UNC prefix counts as absolute there; everything else stays
 * workspace-relative, with any leading separators trimmed so a pasted device path (`/data/x`) does not
 * become a drive-root path. Ordinary `..` segments still resolve, so a caller's own relative path can
 * step outside the workspace — that is their choice, not something this helper tries to contain.
 */
export function absoluteLocal(asked: string): boolean {
  if (process.platform !== 'win32') return isAbsolute(asked)
  return /^[A-Za-z]:[\\/]/.test(asked) || asked.startsWith('\\\\')
}

/** The local half of a transfer: an absolute path as given, anything else under the workspace. */
export function localPathFor(asked: string, root: string): string {
  if (absoluteLocal(asked)) return asked
  // A leading separator is not a request for a drive root on Windows: it is how a device path looks.
  return resolve(root, asked.replace(/^[\\/]+/, ''))
}
