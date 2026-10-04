/** Parameter fragments two tools spell the same way: one wording, one place to change it. */

/** Both `hmos_deploy` and `hmos_lint` take the same project root. */
export const PROJECT_ROOT = { type: 'string', description: 'project root (contains build-profile.json5)' }

/** `emu_ui` and `hmos_log` default to the first running emulator; `hmos_deploy` words it its own way. */
export const DEVICE_SERIAL = { type: 'string', description: 'serial (default: first running)' }
