/**
 * Host half of `dsh-llm-model-tuning`.
 *
 * The Models page card is browser-side, but it cannot read a provider's API key
 * or talk to the provider's gateway by itself: the credential belongs to the
 * Host and the browser may only call this same-origin `/api` surface. This half
 * therefore registers one exact Connection Fetch route —
 * `POST /api/dsh-llm-model-tuning/models` — which
 *
 * 1. looks the named provider profile up in the live `llm-pi-ai` settings
 *    descriptor (so a route declared only in the composition base is found),
 * 2. resolves the profile's `apiKeyEnv` through `credentials`,
 * 3. fetches the gateway's model listing with the protocol's native endpoint
 *    and headers,
 * 4. optionally completes sparse entries from the public models.dev catalog
 *    (`lib/modelsdev.js`) — the gateway always wins, models.dev only fills gaps,
 *    and an unreachable catalog never fails the import — and
 * 5. answers with the storable entries.
 *
 * The API key is used to build one request header and is never returned, logged,
 * or put into an error message; the models.dev request carries no credential.
 * `discoverGatewayModels` is exported separately so offline tests and live checks
 * can exercise the fetch+mapping+completion step without a Connection service,
 * a settings descriptor, or a running Harness.
 *
 * @module dsh-llm-model-tuning
 */
import { mapModelListing } from "./magpie.js"
import {
  MODELS_DEV_URL,
  buildModelsDevIndex,
  enrichModels,
  matchModelsDevModel,
} from "./modelsdev.js"

/** Re-exported models.dev surface for tests and live catalog checks. */
export { MODELS_DEV_URL, buildModelsDevIndex, enrichModels, matchModelsDevModel }

/** Cordis plugin name. */
export const name = "llm-model-tuning"

/** Services this host half needs: the profile lookup, its credential, and the route registry. */
export const inject = ["settings", "credentials", "connection"]

/** Exact Connection Fetch route the card posts to. */
const MODELS_ROUTE_PATH = "/api/dsh-llm-model-tuning/models"

/** Settings namespace owned by the `llm-pi-ai` adapter. */
const DEFAULT_SETTINGS_NS = "llm-pi-ai"

/** Anthropic model-listing API version. */
const ANTHROPIC_VERSION = "2023-06-01"

/** Anthropic's largest model-list page; discovery reads one page. */
const ANTHROPIC_MODEL_LIMIT = 1000

/** One listing fetch may take at most this long, body included. */
const LISTING_TIMEOUT_MS = 20_000

/** One models.dev catalog fetch may take at most this long, body included. */
const MODELS_DEV_TIMEOUT_MS = 10_000

/** How long a loaded models.dev catalog is reused before a fresh fetch. */
const MODELS_DEV_TTL_MS = 6 * 60 * 60 * 1000

/** Politeness header for the public catalog endpoint. */
const MODELS_DEV_USER_AGENT = "dsh-llm-model-tuning/1.5.0 (+https://models.dev)"

/** Protocols whose model listing this plugin knows how to read. */
const LISTABLE_PROTOCOLS = new Set(["openai-completions", "openai-responses", "anthropic-messages"])

/**
 * A discovery failure carrying the HTTP status the route should answer with.
 * Messages in this class are safe to show to the user: they name the endpoint,
 * the reference, or the protocol, never the credential value.
 */
class DiscoveryError extends Error {
  /**
   * @param message - user-facing Chinese explanation.
   * @param status - HTTP status for the route (400 request/profile, 502 gateway).
   */
  constructor(message, status) {
    super(message)
    this.name = "DiscoveryError"
    this.status = status
  }
}

/* ----------------------------------------------------------------- helpers -- */

/**
 * Whether a value is a plain data object (not null, array, or class instance).
 * @param value - candidate value.
 * @returns true for an object-shaped JSON value.
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * A trimmed, non-empty string, or `undefined`.
 * @param value - candidate value.
 * @returns the trimmed string when usable.
 */
function nonEmptyString(value) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * A finite positive number, or `undefined`.
 * @param value - candidate value.
 * @returns the number when usable.
 */
function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * A finite non-negative number, or `undefined`; a TTL of `0` means "never reuse".
 * @param value - candidate value.
 * @returns the number when usable.
 */
function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * JSON response with no-store caching; every route answer goes through this.
 * @param payload - JSON-serializable body.
 * @param status - HTTP status code.
 * @returns the Fetch response.
 */
function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

/**
 * Replace an exact secret occurrence in a diagnostic string. Used on the few
 * messages built from caught errors, which could otherwise echo a credential
 * embedded in a malformed header value.
 * @param text - diagnostic text.
 * @param secret - the credential value, when one was used.
 * @returns the text with the secret removed.
 */
function redactSecret(text, secret) {
  if (typeof secret !== "string" || secret.length === 0) return text
  return text.split(secret).join("[已隐藏凭据]")
}

/**
 * A short reason for a failed HTTP exchange that never quotes a request header.
 * @param error - the caught error.
 * @returns the reason clause.
 */
function describeNetworkError(error) {
  if (error instanceof TypeError) return "请求头或网络参数无效"
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

/**
 * Start the listing deadline.
 *
 * `AbortSignal.timeout` is the primary mechanism (it covers both the request
 * and reading the response body); a manual AbortController keeps the same
 * guarantee on runtimes without it.
 * @param timeoutMs - deadline in milliseconds.
 * @returns the signal, a timed-out predicate, and a cleanup function.
 */
function startListingTimeout(timeoutMs) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    const signal = AbortSignal.timeout(timeoutMs)
    return { signal, timedOut: () => signal.aborted, clear: () => {} }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // Do not keep a CLI/live-check process alive for the full deadline.
  if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") timer.unref()
  return { signal: controller.signal, timedOut: () => controller.signal.aborted, clear: () => clearTimeout(timer) }
}

/**
 * Combine an internal deadline signal with an optional caller signal.
 * @param signals - candidate signals; falsey entries are skipped.
 * @returns one signal, or `undefined` when no signal was supplied.
 */
function combineSignals(signals) {
  const usable = signals.filter((signal) => signal !== undefined && signal !== null)
  if (usable.length === 0) return undefined
  if (usable.length === 1) return usable[0]
  if (typeof AbortSignal.any === "function") return AbortSignal.any(usable)
  // Node 20.0 predates AbortSignal.any; forwarding the first abort is enough.
  const controller = new AbortController()
  for (const signal of usable) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/**
 * Join the profile's base URL with its protocol's listing path.
 *
 * The base URL is treated as a prefix (not a URL to resolve against), and one
 * trailing slash is dropped so `https://gateway/v1/` lists at
 * `https://gateway/v1/models`. Anthropic Messages lists at `{root}/v1/models`,
 * where the root is the base without a trailing `/v1` segment — gateway
 * documentation publishes both spellings of the same root.
 * @param baseURL - configured route endpoint (already validated and trimmed).
 * @param api - route protocol.
 * @returns the absolute listing URL.
 */
function listingUrl(baseURL, api) {
  const base = baseURL.replace(/\/+$/, "")
  if (api !== "anthropic-messages") return `${base}/models`
  const root = base.endsWith("/v1") ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`
}

/* -------------------------------------------------------------- models.dev -- */

/**
 * Validated models.dev catalog and its built index, keyed by the identity of the
 * fetch implementation. Tests swap the global fetch per case, so a fresh stub
 * must never read a catalog another stub loaded; two calls with the same stub
 * reuse one load until its TTL expires or `resetModelsDevCache` is called.
 * @type {WeakMap<Function, { url: string, loadedAt: number, catalog: object, index: object }>}
 */
let modelsDevCache = new WeakMap()

/**
 * In-flight catalog loads, keyed like the cache, so concurrent imports with the
 * same fetch implementation share one request instead of stampeding models.dev.
 * @type {Map<Function, { url: string, promise: Promise<{ catalog: object, index: object }> }>}
 */
const modelsDevInflight = new Map()

/**
 * Resolve the models.dev settings for one call.
 *
 * Accepts both the nested form used by discovery options
 * (`{ modelsDev: { ... } }`) and the flat settings bag used by tests and live
 * checks (`{ catalog?, fetchImpl?, url?, timeoutMs?, ttlMs? }`). The fetch
 * implementation defaults to the caller's `fetchImpl`, then the global fetch.
 * @param options - discovery options or a flat models.dev settings bag.
 * @returns the resolved `{ catalog, fetchImpl, url, timeoutMs, ttlMs }`.
 */
function resolveModelsDevSettings(options = {}) {
  const nested = isRecord(options?.modelsDev) ? options.modelsDev : {}
  const pick = (key) => (nested[key] !== undefined ? nested[key] : options?.[key])
  const fetchImpl = typeof pick("fetchImpl") === "function" ? pick("fetchImpl") : globalThis.fetch
  return {
    catalog: pick("catalog"),
    fetchImpl,
    url: nonEmptyString(pick("url")) ?? MODELS_DEV_URL,
    timeoutMs: positiveNumber(pick("timeoutMs")) ?? MODELS_DEV_TIMEOUT_MS,
    ttlMs: nonNegativeNumber(pick("ttlMs")) ?? MODELS_DEV_TTL_MS,
  }
}

/**
 * Turn a catalog failure into one user-safe Chinese sentence.
 *
 * The raw error is never echoed: a stubbed or unexpected fetch failure could
 * carry arbitrary request details, and the sentence is shown to the browser.
 * @param error - the caught error.
 * @returns the safe sentence for the import answer.
 */
function describeModelsDevFailure(error) {
  const message = error instanceof Error ? error.message : ""
  if (message.includes("超时")) return "获取 models.dev 目录超时，已跳过自动补全"
  if (message.includes("格式无法识别")) return "models.dev 目录格式无法识别，已跳过自动补全"
  if (message.includes("不支持 fetch")) return "当前运行环境不支持 fetch，已跳过 models.dev 自动补全"
  return "models.dev 目录暂时无法获取，已跳过自动补全"
}

/**
 * Fetch and validate the models.dev catalog once, with its own deadline.
 *
 * The request is unauthenticated and carries a politeness user-agent; it has no
 * access to the gateway's credential. The thrown errors may carry a network
 * detail for diagnostics (never a credential — the request has none); the import
 * route sanitises them with `describeModelsDevFailure` before they reach the
 * browser. `buildModelsDevIndex` rejects a non-catalog body.
 * @param settings - resolved models.dev settings.
 * @returns `{ catalog, index }` — the validated catalog and its built index.
 * @throws {Error} when the catalog cannot be fetched or is not a catalog.
 */
async function fetchModelsDevCatalogOnce(settings) {
  if (typeof settings.fetchImpl !== "function") {
    throw new Error("当前运行环境不支持 fetch，无法获取 models.dev 目录")
  }
  const timeout = startListingTimeout(settings.timeoutMs)
  const timeoutError = () =>
    new Error(`获取 models.dev 目录超时（${String(Math.round(settings.timeoutMs / 1000))} 秒）`)

  try {
    let response
    try {
      response = await settings.fetchImpl(settings.url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": MODELS_DEV_USER_AGENT },
        signal: timeout.signal,
      })
    } catch (error) {
      if (timeout.timedOut()) throw timeoutError()
      throw new Error(`无法连接 models.dev：${describeNetworkError(error)}`)
    }

    if (!response.ok) {
      const body = response.body
      if (body !== null && body !== undefined && typeof body.cancel === "function") {
        void body.cancel().catch(() => {})
      }
      throw new Error(`models.dev 返回 HTTP ${String(response.status)}`)
    }

    let text
    try {
      text = await response.text()
    } catch (error) {
      if (timeout.timedOut()) throw timeoutError()
      throw new Error(`读取 models.dev 目录失败：${describeNetworkError(error)}`)
    }

    let catalog
    try {
      catalog = JSON.parse(text)
    } catch {
      throw new Error("models.dev 目录不是 JSON，无法解析")
    }
    return { catalog, index: buildModelsDevIndex(catalog) }
  } finally {
    timeout.clear()
  }
}

/**
 * Load the models.dev catalog, reusing the per-fetch-implementation cache.
 *
 * The cache key is the fetch implementation identity: a test that swaps
 * `globalThis.fetch` per case gets a fresh catalog, while repeated imports
 * through the same fetch reuse one load. Concurrent loads with the same fetch
 * and URL share one in-flight request. An injected `settings.catalog` bypasses
 * both the cache and the network (used by tests and the direct discovery API).
 * @param settings - resolved models.dev settings.
 * @returns `{ catalog, index }`.
 * @throws {Error} when no catalog is available.
 */
async function loadModelsDevCatalog(settings) {
  if (settings.catalog !== undefined) {
    return { catalog: settings.catalog, index: buildModelsDevIndex(settings.catalog) }
  }
  if (typeof settings.fetchImpl !== "function") {
    throw new Error("当前运行环境不支持 fetch，无法获取 models.dev 目录")
  }

  const key = settings.fetchImpl
  const cached = modelsDevCache.get(key)
  if (cached !== undefined && cached.url === settings.url && Date.now() - cached.loadedAt < settings.ttlMs) {
    return { catalog: cached.catalog, index: cached.index }
  }

  const pending = modelsDevInflight.get(key)
  if (pending !== undefined && pending.url === settings.url) return pending.promise

  const promise = fetchModelsDevCatalogOnce(settings)
    .then((loaded) => {
      modelsDevCache.set(key, {
        url: settings.url,
        loadedAt: Date.now(),
        catalog: loaded.catalog,
        index: loaded.index,
      })
      return loaded
    })
    .finally(() => {
      const current = modelsDevInflight.get(key)
      if (current !== undefined && current.promise === promise) modelsDevInflight.delete(key)
    })
  modelsDevInflight.set(key, { url: settings.url, promise })
  return promise
}

/**
 * Forget every cached models.dev catalog and stop sharing in-flight loads.
 *
 * The Host half exports this for tests that deliberately reuse one fetch
 * implementation across cases with different catalogs, and for live checks that
 * want a fresh copy of https://models.dev/api.json. A load that is already in
 * flight still completes and caches its result under the fresh map; only the
 * sharing/caching state is discarded, no request is aborted.
 */
export function resetModelsDevCache() {
  modelsDevCache = new WeakMap()
  modelsDevInflight.clear()
}

/**
 * Load the validated models.dev catalog for tests and live checks.
 *
 * Runs the same fetch, deadline, validation and cache path the import route
 * uses, so a live check proves the Host half's own behavior. `{ catalog }`
 * short-circuits the network and only validates the injected body.
 *
 * @param options - `{ catalog?, fetchImpl?, url?, timeoutMs?, ttlMs? }`, or the
 *   nested discovery form `{ modelsDev: { ... } }`; defaults are the module's
 *   constants.
 * @returns the validated catalog JSON object (`{ [providerId]: { models } }`).
 * @throws {Error} when the catalog cannot be fetched or is not a catalog.
 */
export async function fetchModelsDevCatalog(options = {}) {
  const loaded = await loadModelsDevCatalog(resolveModelsDevSettings(options))
  return loaded.catalog
}

/**
 * Whether at least one mapped model is sparse enough to need completion.
 *
 * A missing `contextWindow`, `maxTokens`, `input` or `reasoningEfforts`
 * triggers the whole-catalog lookup. The reasoning gap matters even when the
 * gateway enumerated nothing: the Magpie mapping may derive capacities and
 * modalities from the gateway's own spellings, so a model whose reasoning
 * levels the gateway does not enumerate would otherwise never be completed.
 * Once triggered, every gap on every model — including `name` — is filled.
 * @param models - the mapped model entries.
 * @returns true when the catalog should be loaded.
 */
function needsModelsDevCompletion(models) {
  return models.some(
    (entry) =>
      isRecord(entry) &&
      (entry.contextWindow === undefined ||
        entry.contextWindow === null ||
        entry.maxTokens === undefined ||
        entry.maxTokens === null ||
        !Array.isArray(entry.input) ||
        entry.input.length === 0 ||
        entry.reasoningEfforts === undefined ||
        entry.reasoningEfforts === null),
  )
}

/**
 * Complete a mapped listing from models.dev, never failing the import.
 *
 * The gateway mapping is authoritative: completion only fills absent fields.
 * Any catalog failure (network, timeout, malformed body) is contained into a
 * `modelsDev.available: false` report, so the import still succeeds with the
 * gateway entries and per-model warnings.
 * @param mapped - `{ models, warnings }` from `mapModelListing`.
 * @param options - discovery options carrying `enrich` and `modelsDev`.
 * @param gatewayFetchImpl - the fetch implementation the listing used, reused
 *   for the catalog unless `options.modelsDev.fetchImpl` overrides it.
 * @returns the mapped result, with `modelsDev` added when completion was attempted.
 */
async function completeFromModelsDev(mapped, options = {}, gatewayFetchImpl) {
  if (options?.enrich === false) return mapped
  if (!needsModelsDevCompletion(mapped.models)) return mapped

  const settings = resolveModelsDevSettings({ modelsDev: options?.modelsDev, fetchImpl: gatewayFetchImpl })
  try {
    const loaded = await loadModelsDevCatalog(settings)
    const completed = enrichModels(mapped.models, loaded.catalog, loaded.index)
    return { models: completed.models, warnings: mapped.warnings, modelsDev: completed.modelsDev }
  } catch (error) {
    return {
      models: mapped.models,
      warnings: mapped.warnings,
      modelsDev: { source: "models.dev", available: false, error: describeModelsDevFailure(error) },
    }
  }
}

/* --------------------------------------------------------------- discovery -- */

/**
 * Fetch one gateway's model listing and map it to storable entries.
 *
 * This is the fetch+mapping step of the import route, exported so it can be
 * called directly:
 *
 * ```js
 * await discoverGatewayModels({ baseURL, api, apiKey, headers, fetchImpl })
 * ```
 *
 * A route with no `apiKeyEnv`/`apiKey` is fetched unauthenticated. Headers from
 * the profile are forwarded (string values only); the protocol's auth header is
 * added last. The whole exchange — including reading the body — has a 20 s
 * deadline by default. Errors are `DiscoveryError`s whose `message` is safe to
 * show to the user and whose `status` says whether the profile (400) or the
 * gateway (502) is at fault.
 *
 * After mapping, a listing with at least one missing `contextWindow`,
 * `maxTokens`, `input` or `reasoningEfforts` is completed from models.dev,
 * unless `options.enrich === false`. Catalog trouble never throws: it is
 * reported as `modelsDev.available: false` and the mapped answer still
 * succeeds.
 *
 * @param profile - `{ baseURL?, api?, apiKey?, headers?, fetchImpl? }`; values
 *   are the resolved route profile, and `fetchImpl` lets tests stub the network.
 * @param options - `{ fetchImpl?, headers?, timeoutMs?, signal?, apiKey?,
 *   enrich?, modelsDev? }` overrides; `fetchImpl` may live here or on the
 *   profile, and `modelsDev` (`{ catalog?, fetchImpl?, url?, timeoutMs?,
 *   ttlMs? }`) overrides the completion fetch for tests.
 * @returns the mapped entries in listing order, plus per-model warnings, and a
 *   `modelsDev` completion report when completion was attempted.
 * @throws {DiscoveryError} when the profile is unusable or the gateway fails.
 */
export async function discoverGatewayModels(profile = {}, options = {}) {
  const baseURL = nonEmptyString(profile?.baseURL)
  const api = nonEmptyString(profile?.api) ?? "openai-completions"
  const apiKey = nonEmptyString(profile?.apiKey) ?? nonEmptyString(options?.apiKey)
  const timeoutMs =
    typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : LISTING_TIMEOUT_MS
  const fetchImpl = options?.fetchImpl ?? profile?.fetchImpl ?? globalThis.fetch
  const redact = (message) => redactSecret(message, apiKey)

  if (baseURL === undefined) throw new DiscoveryError("该供应商未配置 baseURL，无法拉取模型列表", 400)
  if (!LISTABLE_PROTOCOLS.has(api)) throw new DiscoveryError("该协议不支持自动拉取模型列表", 400)
  try {
    // Reject an unusable endpoint before blaming the network for it.
    new URL(baseURL)
  } catch {
    throw new DiscoveryError("该供应商的 baseURL 不是合法的 URL，无法拉取模型列表", 400)
  }
  if (typeof fetchImpl !== "function") {
    throw new DiscoveryError("当前运行环境不支持 fetch，无法拉取模型列表", 502)
  }

  const url = listingUrl(baseURL, api)
  // Contract order: start from the profile's own headers, then force the
  // listing's accept header, then add the protocol's auth header last.
  const headers = {}
  for (const source of [profile?.headers, options?.headers]) {
    if (!isRecord(source)) continue
    for (const [header, value] of Object.entries(source)) {
      if (typeof value === "string") headers[header.toLowerCase()] = value
    }
  }
  headers.accept = "application/json"
  if (api === "anthropic-messages") {
    headers["anthropic-version"] = ANTHROPIC_VERSION
    if (apiKey !== undefined) headers["x-api-key"] = apiKey
  } else if (apiKey !== undefined) {
    headers.authorization = `Bearer ${apiKey}`
  }

  const timeout = startListingTimeout(timeoutMs)
  const timeoutError = () =>
    new DiscoveryError(`拉取模型列表超时（${String(Math.round(timeoutMs / 1000))} 秒）：${url}`, 502)

  let response
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: combineSignals([timeout.signal, options?.signal]),
    })
  } catch (error) {
    timeout.clear()
    if (timeout.timedOut()) throw timeoutError()
    if (options?.signal?.aborted === true) throw new DiscoveryError("模型列表拉取已取消", 502)
    throw new DiscoveryError(redact(`无法连接网关 ${url}：${describeNetworkError(error)}`), 502)
  }

  try {
    if (!response.ok) {
      if (response.body !== null) void response.body.cancel().catch(() => {})
      const hint = response.status === 401 || response.status === 403 ? "，请检查 API key" : ""
      throw new DiscoveryError(`网关返回 HTTP ${String(response.status)}${hint}`, 502)
    }

    let text
    try {
      text = await response.text()
    } catch (error) {
      if (timeout.timedOut()) throw timeoutError()
      throw new DiscoveryError(redact(`读取网关响应失败：${describeNetworkError(error)}`), 502)
    }

    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new DiscoveryError("网关返回的内容不是 JSON，无法解析模型列表", 502)
    }

    let mapped
    try {
      mapped = mapModelListing(body)
    } catch (error) {
      throw new DiscoveryError(
        redact(`网关返回的模型列表无法解析：${error instanceof Error ? error.message : String(error)}`),
        502,
      )
    }
    return completeFromModelsDev(mapped, options, fetchImpl)
  } finally {
    timeout.clear()
  }
}

/* ------------------------------------------------------------------- route -- */

/**
 * Read the provider profile named by the request from the live settings
 * descriptor. The resolved section includes the composition base, so a route
 * declared only in `cordis.patch.yml` is found too.
 * @param ctx - the plugin context (services `settings`).
 * @param settingsNs - settings namespace to look in.
 * @param provider - route id to look up.
 * @returns the resolved provider profile, or a 400/502 response.
 */
async function resolveProviderProfile(ctx, settingsNs, provider) {
  let descriptors
  try {
    descriptors = await ctx.settings.describe({ redactSecrets: true })
  } catch {
    return { failure: jsonResponse({ ok: false, message: "读取供应商配置失败" }, 502) }
  }
  const descriptor = Array.isArray(descriptors)
    ? descriptors.find((row) => isRecord(row) && row.ns === settingsNs)
    : undefined
  if (descriptor === undefined) {
    return { failure: jsonResponse({ ok: false, message: `未找到设置命名空间「${settingsNs}」` }, 400) }
  }
  const providers = isRecord(descriptor.value) ? descriptor.value.providers : undefined
  const profile = isRecord(providers) ? providers[provider] : undefined
  if (!isRecord(profile)) {
    return { failure: jsonResponse({ ok: false, message: `未找到供应商「${provider}」的配置` }, 400) }
  }
  return { profile }
}

/**
 * Resolve the profile's credential reference, if it names one.
 * @param ctx - the plugin context (service `credentials`).
 * @param apiKeyEnv - the reference named by the profile, when present.
 * @returns `{ apiKey }` (possibly undefined for an unauthenticated route), or a 502 response.
 */
async function resolveApiKey(ctx, apiKeyEnv) {
  if (apiKeyEnv === undefined) return { apiKey: undefined }
  let hit
  try {
    hit = await ctx.credentials.resolve(apiKeyEnv)
  } catch {
    return { failure: jsonResponse({ ok: false, message: `读取凭据「${apiKeyEnv}」失败` }, 502) }
  }
  const value = isRecord(hit) ? hit.value : undefined
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      failure: jsonResponse(
        { ok: false, message: `未找到凭据「${apiKeyEnv}」，请先配置该供应商的 API key` },
        502,
      ),
    }
  }
  return { apiKey: value }
}

/**
 * Handle one `POST /api/dsh-llm-model-tuning/models` request.
 *
 * Request body: `{ provider: <route id>, settingsNs?: <namespace>,
 * enrich?: false }`; `enrich: false` opts out of the models.dev completion.
 * Success: `200 { ok: true, models, warnings }`, plus a `modelsDev` report when
 * completion was attempted.
 * Failure: `400` (bad request, unknown provider, unsupported protocol) or `502`
 * (gateway unreachable/refused, malformed listing, missing credential) with
 * `{ ok: false, message }` in Chinese.
 *
 * @param ctx - the plugin context.
 * @param request - the Fetch request built by the Connection bridge.
 * @returns the Fetch response; never throws.
 */
async function handleModelsRequest(ctx, request) {
  try {
    return await respondWithModels(ctx, request)
  } catch {
    // The failure paths above answer for themselves; anything reaching here is
    // an internal fault, and its raw error could carry request details.
    return jsonResponse({ ok: false, message: "拉取模型列表失败，请稍后重试" }, 502)
  }
}

/**
 * The route body, split out so the outer handler can contain unexpected throws.
 * @param ctx - the plugin context.
 * @param request - the Fetch request.
 * @returns the Fetch response.
 */
async function respondWithModels(ctx, request) {
  let payload
  try {
    payload = await request.json()
  } catch {
    return jsonResponse({ ok: false, message: "请求体必须是 JSON" }, 400)
  }
  if (!isRecord(payload)) {
    return jsonResponse({ ok: false, message: "请求体必须是 JSON 对象" }, 400)
  }

  const provider = nonEmptyString(payload.provider)
  if (provider === undefined) {
    return jsonResponse({ ok: false, message: "请求缺少供应商标识（provider）" }, 400)
  }
  const settingsNs = nonEmptyString(payload.settingsNs) ?? DEFAULT_SETTINGS_NS

  const resolved = await resolveProviderProfile(ctx, settingsNs, provider)
  if (resolved.failure !== undefined) return resolved.failure
  const profile = resolved.profile

  const api = nonEmptyString(profile.api) ?? "openai-completions"
  if (!LISTABLE_PROTOCOLS.has(api)) {
    return jsonResponse({ ok: false, message: "该协议不支持自动拉取模型列表" }, 400)
  }

  const credential = await resolveApiKey(ctx, nonEmptyString(profile.apiKeyEnv))
  if (credential.failure !== undefined) return credential.failure

  let discovered
  try {
    discovered = await discoverGatewayModels(
      {
        baseURL: profile.baseURL,
        api,
        apiKey: credential.apiKey,
        headers: profile.headers,
      },
      payload.enrich === false ? { enrich: false } : {},
    )
  } catch (error) {
    const status = error instanceof DiscoveryError && error.status === 400 ? 400 : 502
    const message = error instanceof DiscoveryError ? error.message : "拉取模型列表失败，请稍后重试"
    ctx.logger?.warn?.(`llm-model-tuning: ${message}`)
    return jsonResponse({ ok: false, message }, status)
  }

  const answer = { ok: true, models: discovered.models, warnings: discovered.warnings }
  if (discovered.modelsDev !== undefined) answer.modelsDev = discovered.modelsDev
  return jsonResponse(answer, 200)
}

/**
 * Mount the host half: register the one exact Connection Fetch route the card
 * calls. The registration lives in `ctx.effect`, so it is removed with this
 * plugin's fiber — and the Connection service fails loudly on a duplicate path
 * instead of letting a second copy shadow the first.
 *
 * @param ctx - Host plugin context (injects `settings`, `credentials`, `connection`).
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: MODELS_ROUTE_PATH,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: (request) => handleModelsRequest(ctx, request),
      }),
    `llm-model-tuning: ${MODELS_ROUTE_PATH} Fetch route`,
  )
}
