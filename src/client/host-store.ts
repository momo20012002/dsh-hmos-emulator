/**
 * A preference that survives reloads, kept in the shell's client store when the shell publishes it.
 *
 * The shell resolves `@deepseek-ai/dsh-client-store` for its bundles, and the official panels persist
 * through it. A plugin is not guaranteed to find it — the module table grew this row in
 * 0.1.2-alpha.1 — and a missing row would fail the *whole* client bundle at load, which is far worse
 * than losing one preference. So the require is guarded and a memory-only store stands in: the value
 * holds for this page and no further, the same contract as a browser that refuses storage.
 *
 * The read has to be synchronous — the mount decision happens before any registration — which is also
 * why this is the client store and not the host-side settings service.
 */

/** The part of the shell's store this plugin uses. */
type ClientStore<T> = {
  getSnapshot: () => T
  set: (next: T) => void
  subscribe: (listener: () => void) => () => void
}

/** A preference store plus whether anything actually persisted it. */
export type PreferenceStore<T> = ClientStore<T> & { persisted: boolean }

/**
 * Open one preference store.
 * @param name - the storage key, also the shell store's persist name.
 * @param init - the value before anything was chosen.
 * @returns the store, and whether the shell's store answered.
 */
export function preferenceStore<T>(name: string, init: T): PreferenceStore<T> {
  try {
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store') as {
      createSnapshotStore: <V>(initial: V, opts?: { persist?: { name: string } }) => ClientStore<V>
    }
    return { ...createSnapshotStore<T>(init, { persist: { name } }), persisted: true }
  } catch {
    let value = init
    return {
      getSnapshot: () => value,
      set: (next: T) => { value = next },
      subscribe: () => () => undefined,
      persisted: false,
    }
  }
}
