/**
 * Host half of `dsh-llm-model-tuning`.
 *
 * This plugin has nothing to provide on the Host plane: the Models page card is
 * a browser-side contribution that reads and writes the `llm-pi-ai` settings
 * namespace through the client settings transport (`settingsScope`), which the
 * shipped `ui-settings` plugin already owns.
 *
 * The module still exists, and still exports `apply`, because the profile row
 * must resolve to a real package for `@deepseek-ai/dsh-client-modules` to scan
 * its `dsh.client` declaration and serve `lib/client.js` into the boot graph.
 *
 * @module dsh-llm-model-tuning
 */

/** Cordis plugin name. */
export const name = 'llm-model-tuning'

/**
 * Mount the (deliberately empty) host half.
 *
 * Registering a model-discovery provider or a settings namespace here would
 * duplicate what the `llm-pi-ai` adapter already owns; per-model effort and
 * modality are plain fields of that adapter's own settings section.
 */
export function apply() {}
