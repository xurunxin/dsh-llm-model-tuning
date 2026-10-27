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
 *    and headers, and
 * 4. answers with entries mapped by `lib/magpie.js`.
 *
 * The API key is used to build one request header and is never returned, logged,
 * or put into an error message. `discoverGatewayModels` is exported separately so
 * offline tests and live checks can exercise the fetch+mapping step without a
 * Connection service, a settings descriptor, or a running Harness.
 *
 * @module dsh-llm-model-tuning
 */
import { mapModelListing } from "./magpie.js"

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
 * @param profile - `{ baseURL?, api?, apiKey?, headers?, fetchImpl? }`; values
 *   are the resolved route profile, and `fetchImpl` lets tests stub the network.
 * @param options - `{ fetchImpl?, headers?, timeoutMs?, signal?, apiKey? }`
 *   overrides; `fetchImpl` may live here or on the profile.
 * @returns the mapped entries in listing order, plus per-model warnings.
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

    try {
      return mapModelListing(body)
    } catch (error) {
      throw new DiscoveryError(
        redact(`网关返回的模型列表无法解析：${error instanceof Error ? error.message : String(error)}`),
        502,
      )
    }
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
 * Request body: `{ provider: <route id>, settingsNs?: <namespace> }`.
 * Success: `200 { ok: true, models, warnings }`.
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
    discovered = await discoverGatewayModels({
      baseURL: profile.baseURL,
      api,
      apiKey: credential.apiKey,
      headers: profile.headers,
    })
  } catch (error) {
    const status = error instanceof DiscoveryError && error.status === 400 ? 400 : 502
    const message = error instanceof DiscoveryError ? error.message : "拉取模型列表失败，请稍后重试"
    ctx.logger?.warn?.(`llm-model-tuning: ${message}`)
    return jsonResponse({ ok: false, message }, status)
  }

  return jsonResponse({ ok: true, models: discovered.models, warnings: discovered.warnings }, 200)
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
