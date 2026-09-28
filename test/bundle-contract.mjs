/**
 * Bundle-contract test: the Host serves `lib/client.js` over the module graph and
 * the browser kernel enforces a strict registration protocol. A bundle that
 * violates it is rejected at boot with no card and a console error, so the
 * contract is worth asserting directly rather than discovering in the browser.
 *
 * Verifies, against the real client-modules loader semantics:
 *   - the file registers exactly one factory under the package id;
 *   - registration happens through `window.__ModuleLoader__.load({id, factory})`;
 *   - the factory resolves `react` and the `styles` builtin and nothing else;
 *   - the declared `dsh.client` metadata points at the file that exists.
 *
 * Run: node test/bundle-contract.mjs
 */
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const bundlePath = join(root, "lib", "client.js")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Load the bundle exactly as the kernel does: it may only register a factory. */
function loadRaw() {
  const source = readFileSync(bundlePath, "utf8")
  const registrations = []
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        registrations.push(entry)
      },
    },
  }
  globalThis.styles = { insert: () => () => {} }
  // eslint-disable-next-line no-new-func
  new Function("require", "styles", source)((specifier) => {
    if (specifier === "react") return { createElement: () => null, useState: () => [undefined, () => {}], useEffect: () => {}, useMemo: (fn) => fn(), Fragment: Symbol("F") }
    throw new Error(`bundle-contract: bundle required "${specifier}" at load time`)
  }, globalThis.styles)
  return registrations
}

check("package declares the client half the loader scans for", () => {
  assert(pkg.dsh !== undefined, "package.json has no dsh block")
  assert(pkg.dsh.client !== undefined, "dsh.client is missing")
  assert(pkg.dsh.client.platform === "web", "dsh.client.platform must be 'web'")
  assert(pkg.dsh.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch is missing")
  assert(pkg.exports["./client"] === "./lib/client.js", "exports['./client'] must point at the bundle")
})

check("every declared file exists", () => {
  for (const relative of ["lib/client.js", "lib/index.js", "cordis.patch.yml"]) {
    assert(existsSync(join(root, relative)), `${relative} does not exist`)
  }
})

check("the bundle is served as a built artifact, not a source file", () => {
  const source = readFileSync(bundlePath, "utf8")
  // A leading JSDoc header is fine; the registration must be the first statement.
  const firstStatement = source.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, "").trimStart()
  assert(firstStatement.startsWith("window.__ModuleLoader__.load("), "no __ModuleLoader__ registration before any other statement")
  assert(!/^\s*import\s/m.test(source), "the bundle must not use ESM import syntax")
  assert(source.includes("require("), "a factory-form CJS bundle resolves its dependencies through require")
  assert(!/\bexport\s+(default|const|function)\b/.test(source), "the bundle must not use ESM export syntax")
})

check("load-time evaluation registers exactly one factory", () => {
  const registrations = loadRaw()
  assert(registrations.length === 1, `expected 1 registration, got ${String(registrations.length)}`)
  assert(typeof registrations[0].factory === "function", "registration has no factory")
})

check("the factory is registered under the package's own name", () => {
  const [registration] = loadRaw()
  assert(registration.id === pkg.name, `registered id "${registration.id}" does not match package name "${pkg.name}"`)
})

check("the factory resolves only the baseline react module", () => {
  const [registration] = loadRaw()
  const requested = []
  const exports = registration.factory((specifier) => {
    requested.push(specifier)
    if (specifier === "react") return { createElement: () => null, useState: () => [undefined, () => {}], useEffect: () => {}, useMemo: (fn) => fn(), Fragment: Symbol("F") }
    throw new Error(`unexpected require("${specifier}")`)
  })
  const unique = [...new Set(requested)]
  assert(
    unique.every((specifier) => specifier === "react"),
    `the factory required non-baseline modules: ${unique.join(", ")} (declare them under dsh.client.external)`,
  )
  assert(typeof exports.apply === "function", "the factory exported no apply()")
})

check("the plugin declares its hard dependencies", () => {
  const [registration] = loadRaw()
  const exports = registration.factory((specifier) => {
    if (specifier === "react") return { createElement: () => null, useState: () => [undefined, () => {}], useEffect: () => {}, useMemo: (fn) => fn(), Fragment: Symbol("F") }
    throw new Error(`unexpected require("${specifier}")`)
  })
  assert(typeof exports.name === "string" && exports.name.length > 0, "the plugin has no name")
  assert(Array.isArray(exports.inject), "the plugin declares no inject list")
  // `configForms` is the settings transport as of dsh 0.1.7; the older
  // `settingsScope` service no longer exists, and injecting it would leave this
  // row waiting forever instead of activating.
  for (const service of ["slots", "configForms"]) {
    assert(exports.inject.includes(service), `inject is missing "${service}"`)
  }
  assert(!exports.inject.includes("settingsScope"), "the removed settingsScope service is still injected")
})

check("the patch row names this exact package", () => {
  const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8")
  assert(patch.includes(`name: '${pkg.name}'`) || patch.includes(`name: "${pkg.name}"`), "the patch row names another package")
  assert(patch.includes("insert:"), "the patch declares no insert list")
})

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}`)
  if (!entry.ok) console.log(`      ${entry.error}`)
}
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
if (failed.length > 0) process.exitCode = 1
