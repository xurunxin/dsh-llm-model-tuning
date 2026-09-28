/**
 * Locate the installed `@deepseek-ai/dsh-llm-pi-ai` adapter so two suites can
 * validate this card's output against the adapter's REAL exported `Config`
 * schema instead of a reimplementation of it.
 *
 * There is no portable path to look up: a DSH installation lives wherever the
 * user or the launcher put it, and a Profile's hoisted `node_modules` sits one
 * level above the profile directory. The resolver therefore walks the places a
 * deployment can plausibly be, and reports "not found" rather than throwing —
 * a contributor without DSH installed should get a clearly labelled SKIP, not a
 * red build and not a silent pass.
 *
 * Override with `DSH_PI_AI_DIR` when running against an unusual layout.
 *
 * @module dsh-llm-model-tuning/test/dsh-adapter
 */
import { createRequire } from "node:module"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const PACKAGE = "@deepseek-ai/dsh-llm-pi-ai"

/** Every directory that could sit beside a resolvable `node_modules`. */
function candidateBases() {
  const bases = new Set()
  const add = (value) => {
    if (typeof value === "string" && value.length > 0) bases.add(resolve(value))
  }

  add(process.cwd())

  // A Harness launched from a profile exports these; `node_modules` is hoisted
  // to the profiles root, so both the profile and its parent are candidates.
  add(process.env.DSH_PI_AI_DIR)
  add(process.env.DSH_PROFILE_DIR)
  if (process.env.DSH_PROFILE_DIR !== undefined) add(join(process.env.DSH_PROFILE_DIR, ".."))

  // The conventional layout: $DSH_HOME/profiles/<profile>/ with a hoisted
  // node_modules beside the profile directories.
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh")
  const profiles = join(home, "profiles")
  add(profiles)
  if (existsSync(profiles)) {
    let entries = []
    try {
      entries = readdirSync(profiles, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      add(join(profiles, entry.name))
      add(join(profiles, entry.name, "node_modules"))
    }
  }
  return [...bases]
}

/**
 * Resolve the adapter's package entry, or `undefined` when no installation is
 * reachable from this machine's layout.
 * @returns the absolute path of the adapter's main module, or undefined.
 */
function resolveAdapterEntry() {
  const require = createRequire(import.meta.url)
  for (const base of candidateBases()) {
    try {
      return require.resolve(PACKAGE, { paths: [base] })
    } catch {
      // Try the next candidate: an unreachable layout is expected, not an error.
    }
  }
  return undefined
}

/** The adapter's real exported `Config` schema, or `undefined` when unavailable. */
export async function loadAdapterConfig() {
  const entry = resolveAdapterEntry()
  if (entry === undefined) return undefined
  const module = await import(pathToFileURL(entry).href)
  return module.Config
}

/**
 * Print the shared skip notice for a suite that needs the real adapter.
 * @param suite - the suite name used in the notice.
 */
export function reportSkip(suite) {
  console.log(`SKIP  ${suite}: no installed ${PACKAGE} found on this machine.`)
  console.log("      The schema-checked cases need a DSH installation; every other suite still runs.")
  console.log("      Point DSH_PI_AI_DIR at a deployment to enable them.")
}
