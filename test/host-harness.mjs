/**
 * Host-half harness for `lib/index.js`: the exact Connection Fetch route that
 * powers the card's "从网关导入模型" action.
 *
 * The route is a contract between the browser bundle and the Host, so it is
 * exercised the way the Connection service will call it: `apply(ctx)` against a
 * stubbed Cordis context, then the captured route's `fetch` receives a real
 * `Request` and must answer with a real `Response`. The gateway itself is
 * stubbed through the global `fetch`, and the credential never leaves the
 * process — every assertion that shows a response body also proves the key is
 * not in it.
 *
 * Run: node test/host-harness.mjs
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  MODELS_DEV_URL,
  apply,
  buildModelsDevIndex,
  discoverGatewayModels,
  enrichModels,
  fetchModelsDevCatalog,
  inject,
  matchModelsDevModel,
  name,
  resetModelsDevCache,
} from "../lib/index.js"

const ROUTE = "/api/dsh-llm-model-tuning/models"
const TEST_KEY = "magpie-live-test-key-123456"
const GATEWAY_URL = "http://gateway.test/v1/models"
const fixture = JSON.parse(readFileSync(new URL("./fixtures/magpie-models.json", import.meta.url), "utf8"))
const workbuddyFixture = JSON.parse(readFileSync(new URL("./fixtures/workbuddy-models.json", import.meta.url), "utf8"))
const modelsDevFixture = JSON.parse(readFileSync(new URL("./fixtures/models-dev.json", import.meta.url), "utf8"))

const results = []
function check(testName, fn) {
  results.push({ name: testName, fn })
}

/* ------------------------------------------------------------------ helpers -- */

/** The route profile a saved `llm-pi-ai` provider row would resolve to. */
const DEMO_PROFILE = {
  apiKeyEnv: "MAGPIE_GATEWAY_API_KEY",
  api: "openai-completions",
  baseURL: "http://gateway.test/v1",
  headers: { "x-gateway-token": "gateway-static" },
}

/**
 * A stub Cordis context with just the services the host half injects, recording
 * every effect, route, and credential lookup it is handed.
 * @param options - descriptor rows and credential resolver to serve.
 * @returns the context plus captured state.
 */
function makeCtx(options = {}) {
  const routes = []
  const effects = []
  const credentialCalls = []
  const describeCalls = []
  const ctx = {
    effect(execute, label) {
      const disposer = execute()
      effects.push({ label, dispose: disposer })
      return disposer
    },
    settings: {
      async describe(describeOptions) {
        describeCalls.push(describeOptions)
        return options.descriptors ?? []
      },
    },
    credentials: {
      async resolve(ref) {
        credentialCalls.push(ref)
        return options.credential === undefined ? undefined : options.credential(ref)
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index !== -1) routes.splice(index, 1)
          }
        },
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  return { ctx, routes, effects, credentialCalls, describeCalls }
}

/**
 * Mount the plugin on a fresh stub context for one saved provider profile.
 * @param profile - the `llm-pi-ai` provider section to resolve.
 * @param options - descriptor overrides and credential override.
 * @returns the stub harness with the registered route.
 */
function mount(profile = DEMO_PROFILE, options = {}) {
  const descriptor = {
    ns: options.ns ?? "llm-pi-ai",
    value: { providers: { magpie: profile } },
  }
  const harness = makeCtx({
    descriptors: options.descriptors ?? [descriptor],
    credential: options.credential ?? (() => ({ value: TEST_KEY, source: "file" })),
  })
  if (options.describeError !== undefined) {
    harness.ctx.settings.describe = async () => {
      throw options.describeError
    }
  }
  apply(harness.ctx)
  assert.equal(harness.routes.length, 1, "apply() must register exactly one route")
  return harness
}

/** POST a JSON body to the captured route and decode the answer. */
async function post(harness, body) {
  const response = await harness.routes[0].fetch(
    new Request(`http://dsh.test${ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  )
  const text = await response.text()
  return { status: response.status, text, payload: JSON.parse(text) }
}

/** A fetch stub answering one fixed JSON body and recording its calls. */
function jsonFetch(body, status = 200) {
  const calls = []
  const stub = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }
  return { stub, calls }
}

/** A fetch stub that must never be reached. */
function forbiddenFetch() {
  const calls = []
  const stub = async (url, init) => {
    calls.push({ url, init })
    throw new Error("fetch must not be called")
  }
  return { stub, calls }
}

/** A JSON Response for a stub route. */
function answer(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/**
 * A fetch stub routed by URL: the gateway listing and the models.dev catalog are
 * separate routes, so completion can be exercised without touching the network.
 * Either route may be a JSON body or a function receiving `(url, init)`.
 */
function routedFetch({ gateway, catalog }) {
  const calls = []
  const stub = async (url, init) => {
    calls.push({ url, init })
    const route = url === MODELS_DEV_URL ? catalog : gateway
    if (typeof route === "function") return route(url, init)
    return answer(route)
  }
  return { stub, calls }
}

/** The calls a routed stub made to one URL. */
function callsTo(calls, url) {
  return calls.filter((call) => call.url === url)
}

/** Replace the global fetch for one async body and always restore it. */
async function withGlobalFetch(stub, fn) {
  const previous = globalThis.fetch
  globalThis.fetch = stub
  try {
    return await fn()
  } finally {
    globalThis.fetch = previous
  }
}

const HAIKU_ENTRY = {
  id: "claude/claude-haiku-5-5",
  name: "Claude Haiku 5.5",
  contextWindow: 1000000,
  maxTokens: 128000,
  input: ["text", "image"],
  reasoningEfforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
}

const SOL_ENRICHED = {
  id: "codex/gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  contextWindow: 1050000,
  maxTokens: 128000,
  input: ["text", "image"],
  reasoningEfforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
}

const DEEPSEEK_ENRICHED = {
  id: "cn:deepseek-flash",
  name: "DeepSeek V4.1 Flash 1017",
  contextWindow: 1048576,
  maxTokens: 393216,
  input: ["text", "image"],
  reasoningEfforts: { off: null, low: "low", high: "high", max: "max" },
}

const HAIKU_ENRICHED = {
  id: "claude/claude-haiku-5-5",
  name: "Claude Haiku 5.5",
  contextWindow: 1000000,
  maxTokens: 128000,
  input: ["text", "image"],
  reasoningEfforts: {
    off: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
}

/* ------------------------------------------------------------ registration -- */

check("the module exports the host contract surface", () => {
  assert.equal(name, "llm-model-tuning")
  assert.deepEqual(inject, ["settings", "credentials", "connection"])
  assert.equal(typeof apply, "function")
  assert.equal(typeof discoverGatewayModels, "function")
  assert.equal(typeof fetchModelsDevCatalog, "function")
  assert.equal(typeof resetModelsDevCache, "function")
  // The models.dev surface is re-exported for tests and live checks.
  assert.equal(MODELS_DEV_URL, "https://models.dev/api.json")
  assert.equal(typeof buildModelsDevIndex, "function")
  assert.equal(typeof enrichModels, "function")
  assert.equal(typeof matchModelsDevModel, "function")
})

check("apply registers the exact route and effect disposal unregisters it", () => {
  const harness = mount()
  const [route] = harness.routes
  assert.equal(route.path, ROUTE)
  assert.deepEqual(route.methods, ["POST"])
  assert.equal(route.requestBody, "buffered")
  assert.equal(typeof route.fetch, "function")
  assert.equal(harness.effects.length, 1)
  assert.ok(harness.effects[0].label.includes(ROUTE), "effect label should name the route")
  assert.equal(typeof harness.effects[0].dispose, "function")
  // The real Connection service validates the path as /api/<segment>/... .
  assert.match(ROUTE, /^\/api\/(?:[A-Za-z0-9_$.-]+\/)+[A-Za-z0-9_$.-]+$/)
  harness.effects[0].dispose()
  assert.equal(harness.routes.length, 0)
})

/* ------------------------------------------------------------- happy paths -- */

check("the route maps the live fixture and answers { ok, models, warnings } (+ modelsDev on completion)", async () => {
  resetModelsDevCache()
  // Four saved entries disclose `reasoning: true` without enumerating levels, so
  // the import now consults models.dev; the stub is routed by URL.
  const { stub, calls } = routedFetch({ gateway: fixture, catalog: modelsDevFixture })
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const { status, text, payload } = await post(harness, { provider: "magpie" })

    assert.equal(status, 200)
    assert.deepEqual(Object.keys(payload).sort(), ["models", "modelsDev", "ok", "warnings"])
    assert.equal(payload.ok, true)
    assert.equal(payload.models.length, 28)
    assert.ok(Array.isArray(payload.warnings))
    assert.ok(payload.warnings.includes("group/never-stuck：跳过 DSH 不支持的推理档位 ultra"))
    assert.deepEqual(
      payload.models.find((entry) => entry.id === "claude/claude-haiku-5-5"),
      HAIKU_ENTRY,
    )

    // The gateway entries are complete, so completion fills nothing; the four
    // reasoning gaps have no catalog record and stay unmatched.
    assert.equal(payload.modelsDev.available, true)
    assert.equal(payload.modelsDev.matched, 2)
    assert.deepEqual(payload.modelsDev.enriched, [])
    assert.equal(payload.modelsDev.unmatched.length, 26)
    for (const id of [
      "claude/claude-haiku-4-5",
      "claude/claude-haiku-4-5-20251001",
      "claude/claude-sonnet-4-5",
      "claude/claude-sonnet-4-5-20250929",
    ]) {
      assert.ok(payload.modelsDev.unmatched.includes(id), `${id} should stay unmatched`)
    }

    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, "http://gateway.test/v1/models")
    assert.equal(calls[1].url, MODELS_DEV_URL)
    assert.equal(calls[0].init.method, "GET")
    assert.equal(calls[0].init.headers.accept, "application/json")
    assert.equal(calls[0].init.headers.authorization, `Bearer ${TEST_KEY}`)
    assert.equal(calls[0].init.headers["x-gateway-token"], "gateway-static")
    assert.ok(calls[0].init.signal !== undefined, "the request carries the 20 s deadline signal")

    // The API key is read from the credential service, used once, and never
    // echoed back to the browser.
    assert.equal(harness.credentialCalls.length, 1)
    assert.equal(harness.credentialCalls[0], "MAGPIE_GATEWAY_API_KEY")
    assert.ok(!text.includes(TEST_KEY), "response body must not contain the API key")
  })
})

check("an explicit settingsNs selects which descriptor is searched", async () => {
  resetModelsDevCache()
  // The listing is sparse, so this import also consults the models.dev catalog:
  // the stub is URL-aware, and the fixture has no model "m" so the mapping is
  // unchanged while the completion summary reports the attempt.
  const { stub, calls } = routedFetch({ gateway: { data: [{ id: "m" }] }, catalog: modelsDevFixture })
  const harness = mount(DEMO_PROFILE, { ns: "custom-provider-ns" })
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "magpie", settingsNs: "custom-provider-ns" })
    assert.equal(status, 200)
    assert.deepEqual(payload.models, [{ id: "m" }])
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, GATEWAY_URL)
    assert.equal(calls[1].url, MODELS_DEV_URL)
    assert.equal(payload.modelsDev.available, true)
    assert.equal(payload.modelsDev.matched, 0)
    assert.deepEqual(payload.modelsDev.unmatched, ["m"])
  })
})

check("a profile without apiKeyEnv is fetched unauthenticated", async () => {
  const profile = { api: "openai-completions", baseURL: "http://gateway.test/v1" }
  const { stub, calls } = jsonFetch({ data: [{ id: "m" }] })
  const harness = mount(profile, { credential: () => undefined })
  await withGlobalFetch(stub, async () => {
    const { status } = await post(harness, { provider: "magpie" })
    assert.equal(status, 200)
    assert.equal(harness.credentialCalls.length, 0)
    assert.equal(calls[0].init.headers.authorization, undefined)
  })
})

check("profile headers are forwarded but accept and auth always win", async () => {
  const profile = {
    ...DEMO_PROFILE,
    headers: {
      accept: "text/plain",
      authorization: "stale-value",
      "x-gateway-token": "gateway-static",
      "x-numeric": 7,
    },
  }
  const { stub, calls } = jsonFetch({ data: [{ id: "m" }] })
  const harness = mount(profile)
  await withGlobalFetch(stub, async () => {
    const { status } = await post(harness, { provider: "magpie" })
    assert.equal(status, 200)
    assert.equal(calls[0].init.headers.accept, "application/json")
    assert.equal(calls[0].init.headers.authorization, `Bearer ${TEST_KEY}`)
    assert.equal(calls[0].init.headers["x-gateway-token"], "gateway-static")
    assert.equal(calls[0].init.headers["x-numeric"], undefined)
  })
})

check("a models-map envelope maps through the route", async () => {
  const { stub } = jsonFetch({
    models: {
      "gateway/router": { display_name: "Router", context_length: 64000, max_output_tokens: 8000 },
    },
  })
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 200)
    assert.deepEqual(payload.models, [
      { id: "gateway/router", name: "Router", contextWindow: 64000, maxTokens: 8000 },
    ])
  })
})

check("openai-responses lists at { baseURL }/models", async () => {
  const profile = { ...DEMO_PROFILE, api: "openai-responses" }
  const { stub, calls } = jsonFetch({ data: [{ id: "m" }] })
  const harness = mount(profile)
  await withGlobalFetch(stub, async () => {
    const { status } = await post(harness, { provider: "magpie" })
    assert.equal(status, 200)
    assert.equal(calls[0].url, "http://gateway.test/v1/models")
  })
})

check("anthropic-messages normalizes /v1 and sends x-api-key + anthropic-version", async () => {
  const profile = { ...DEMO_PROFILE, api: "anthropic-messages" }
  const body = {
    data: [
      {
        id: "anthropic/claude",
        display_name: "Anthropic Claude",
        context_window: 200000,
        max_output_tokens: 64000,
        modalities: { input: ["text", "image"] },
        reasoning: true,
        reasoning_levels: ["low", "high"],
      },
    ],
  }
  const { stub, calls } = jsonFetch(body)
  const harness = mount(profile)
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 200)
    assert.equal(calls[0].url, "http://gateway.test/v1/models?limit=1000")
    assert.equal(calls[0].init.headers["x-api-key"], TEST_KEY)
    assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01")
    assert.equal(calls[0].init.headers.authorization, undefined)
    assert.equal(calls[0].init.headers["x-gateway-token"], "gateway-static")
    assert.deepEqual(payload.models, [
      {
        id: "anthropic/claude",
        name: "Anthropic Claude",
        contextWindow: 200000,
        maxTokens: 64000,
        input: ["text", "image"],
        reasoningEfforts: { low: "low", high: "high" },
      },
    ])
  })
})

check("anthropic-messages adds the /v1 listing segment to a bare root", async () => {
  const profile = { ...DEMO_PROFILE, api: "anthropic-messages", baseURL: "http://gateway.test" }
  const { stub, calls } = jsonFetch({ data: [{ id: "m" }] })
  const harness = mount(profile)
  await withGlobalFetch(stub, async () => {
    const { status } = await post(harness, { provider: "magpie" })
    assert.equal(status, 200)
    assert.equal(calls[0].url, "http://gateway.test/v1/models?limit=1000")
  })
})

/* ------------------------------------------------------- models.dev completion -- */

check("a sparse gateway listing is completed from models.dev through the route", async () => {
  resetModelsDevCache()
  const gateway = {
    data: [
      { id: "codex/gpt-6.1-sol" },
      { id: "claude/claude-haiku-5-5" },
      { id: "cn:deepseek-flash" },
      { id: "group/smart-split" },
    ],
  }
  const { stub, calls } = routedFetch({ gateway, catalog: modelsDevFixture })
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const { status, text, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 200)

    assert.equal(calls.length, 2, "one gateway listing plus one catalog fetch")
    assert.equal(calls[0].url, GATEWAY_URL)
    assert.equal(calls[1].url, MODELS_DEV_URL)
    assert.equal(calls[1].init.method, "GET")
    assert.equal(calls[1].init.headers.accept, "application/json")
    assert.match(calls[1].init.headers["user-agent"], /dsh-llm-model-tuning/)
    assert.equal(calls[1].init.headers.authorization, undefined, "the catalog request must not carry the API key")
    assert.equal(calls[1].init.headers["x-api-key"], undefined)
    assert.equal(calls[1].init.headers["x-gateway-token"], undefined, "profile headers stay with the gateway")

    assert.deepEqual(payload.models.find((entry) => entry.id === "codex/gpt-6.1-sol"), SOL_ENRICHED)
    assert.deepEqual(payload.models.find((entry) => entry.id === "claude/claude-haiku-5-5"), HAIKU_ENRICHED)
    assert.deepEqual(payload.models.find((entry) => entry.id === "cn:deepseek-flash"), DEEPSEEK_ENRICHED)
    assert.deepEqual(payload.models.find((entry) => entry.id === "group/smart-split"), {
      id: "group/smart-split",
    })

    assert.deepEqual(payload.modelsDev, {
      source: "models.dev",
      available: true,
      matched: 3,
      enriched: [
        { id: "codex/gpt-6.1-sol", fields: ["name", "contextWindow", "maxTokens", "input", "reasoningEfforts"] },
        { id: "claude/claude-haiku-5-5", fields: ["name", "contextWindow", "maxTokens", "input", "reasoningEfforts"] },
        { id: "cn:deepseek-flash", fields: ["name", "contextWindow", "maxTokens", "input", "reasoningEfforts"] },
      ],
      unmatched: ["group/smart-split"],
    })
    assert.ok(!text.includes(TEST_KEY), "an enriched answer must not contain the API key")
  })
})

check("gateway-disclosed fields are not overridden by models.dev", async () => {
  resetModelsDevCache()
  const gateway = {
    data: [
      {
        id: "gpt-6.1-sol",
        display_name: "Gateway Sol",
        context_window: 123456,
        max_output_tokens: 4321,
        modalities: { input: ["text"] },
        reasoning_levels: ["low"],
      },
      { id: "cn:deepseek-flash" },
    ],
  }
  const { stub, calls } = routedFetch({ gateway, catalog: modelsDevFixture })
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 200)
    assert.equal(calls.length, 2)
    assert.deepEqual(payload.models[0], {
      id: "gpt-6.1-sol",
      name: "Gateway Sol",
      contextWindow: 123456,
      maxTokens: 4321,
      input: ["text"],
      reasoningEfforts: { low: "low" },
    })
    assert.deepEqual(payload.models[1], DEEPSEEK_ENRICHED)
    assert.equal(payload.modelsDev.matched, 2, "both models matched a catalog record")
    assert.deepEqual(payload.modelsDev.enriched, [
      { id: "cn:deepseek-flash", fields: ["name", "contextWindow", "maxTokens", "input", "reasoningEfforts"] },
    ])
    assert.deepEqual(payload.modelsDev.unmatched, [])
  })
})

check("a missing reasoning level alone triggers the catalog fetch", async () => {
  resetModelsDevCache()
  const gateway = {
    data: [
      {
        id: "gpt-6.1-sol",
        name: "Gateway Sol",
        context_window: 1000,
        max_output_tokens: 100,
        modalities: { input: ["text"] },
      },
    ],
  }
  const { stub, calls } = routedFetch({ gateway, catalog: modelsDevFixture })
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 200)
    assert.equal(calls.length, 2, "the reasoning-only gap now consults models.dev")
    assert.equal(calls[1].url, MODELS_DEV_URL)
    assert.deepEqual(payload.models, [
      {
        id: "gpt-6.1-sol",
        name: "Gateway Sol",
        contextWindow: 1000,
        maxTokens: 100,
        input: ["text"],
        reasoningEfforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
      },
    ])
    assert.deepEqual(payload.modelsDev, {
      source: "models.dev",
      available: true,
      matched: 1,
      enriched: [{ id: "gpt-6.1-sol", fields: ["reasoningEfforts"] }],
      unmatched: [],
    })
  })
})

check("a WorkBuddy-shaped import derives modalities and reasoning from the gateway itself", async () => {
  resetModelsDevCache()
  const { stub, calls } = routedFetch({ gateway: workbuddyFixture, catalog: modelsDevFixture })
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const { status, text, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 200)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, GATEWAY_URL)
    assert.equal(calls[1].url, MODELS_DEV_URL)

    assert.equal(payload.models.length, 6)
    const byId = new Map(payload.models.map((entry) => [entry.id, entry]))

    // The gateway's own `attachments` / `supports_images` spellings disclose the
    // modalities, and `reasoning_supported_efforts` discloses the levels.
    assert.deepEqual(byId.get("cn:kimi-k3-1"), {
      id: "cn:kimi-k3-1",
      name: "Kimi-K3",
      contextWindow: 1000000,
      maxTokens: 32000,
      input: ["text", "image"],
      reasoningEfforts: { low: "low", high: "high", xhigh: "xhigh" },
    })
    assert.deepEqual(byId.get("cn:glm-5.3"), {
      id: "cn:glm-5.3",
      name: "GLM-5.3",
      contextWindow: 1000000,
      maxTokens: 64000,
      input: ["text", "image"],
      reasoningEfforts: { low: "low", high: "high", max: "max" },
    })
    assert.deepEqual(byId.get("cn:hy4-preview-ctrl"), {
      id: "cn:hy4-preview-ctrl",
      name: "Hy4 preview",
      contextWindow: 960000,
      maxTokens: 64000,
      input: ["text", "image"],
      reasoningEfforts: { high: "high" },
    })

    // Models.dev only fills the reasoning gap of the model whose gateway entry
    // declares reasoning without enumerating levels; its decorator id resolves
    // through the local-alias tier.
    assert.deepEqual(byId.get("cn:hy3-b"), {
      id: "cn:hy3-b",
      name: "Hy3",
      contextWindow: 192000,
      maxTokens: 64000,
      input: ["text", "image"],
      reasoningEfforts: { low: "low", high: "high" },
    })
    assert.deepEqual(payload.modelsDev, {
      source: "models.dev",
      available: true,
      matched: 4,
      enriched: [{ id: "cn:hy3-b", fields: ["reasoningEfforts"] }],
      unmatched: ["cn:deepseek-v3-1", "cn:hunyuan-image-alpha"],
    })
    assert.deepEqual(payload.warnings, ["cn:hy3-b：网关声明支持推理，但未提供推理档位"])
    assert.ok(!text.includes(TEST_KEY), "the import answer must not contain the API key")
  })
})

check("a WorkBuddy import keeps gateway-derived modalities and reasoning when models.dev is down", async () => {
  resetModelsDevCache()
  const catalogFailure = () => {
    throw new Error(`connect ECONNREFUSED while sending Bearer ${TEST_KEY}`)
  }
  const { stub } = routedFetch({ gateway: workbuddyFixture, catalog: catalogFailure })
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const { status, text, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.modelsDev.available, false)
    assert.ok(payload.modelsDev.error.includes("models.dev"))

    const byId = new Map(payload.models.map((entry) => [entry.id, entry]))
    assert.deepEqual(byId.get("cn:kimi-k3-1").input, ["text", "image"])
    assert.deepEqual(byId.get("cn:kimi-k3-1").reasoningEfforts, { low: "low", high: "high", xhigh: "xhigh" })
    assert.deepEqual(byId.get("cn:glm-5.3").input, ["text", "image"])
    assert.deepEqual(byId.get("cn:glm-5.3").reasoningEfforts, { low: "low", high: "high", max: "max" })
    // The warning path is the same as with the catalog: the gap is reported, not
    // back-filled from nowhere.
    assert.equal(Object.hasOwn(byId.get("cn:hy3-b"), "reasoningEfforts"), false)
    assert.ok(payload.warnings.includes("cn:hy3-b：网关声明支持推理，但未提供推理档位"))
    assert.ok(!text.includes(TEST_KEY), "a stubbed catalog failure must not leak the API key")
  })
})

check("enrich:false skips the catalog fetch entirely", async () => {
  resetModelsDevCache()
  const { stub, calls } = routedFetch({
    gateway: { data: [{ id: "m" }] },
    catalog: () => {
      throw new Error("the models.dev catalog must not be fetched with enrich:false")
    },
  })
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "magpie", enrich: false })
    assert.equal(status, 200)
    assert.deepEqual(Object.keys(payload).sort(), ["models", "ok", "warnings"])
    assert.deepEqual(payload.models, [{ id: "m" }])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, GATEWAY_URL)
  })
})

check("a broken models.dev answer never fails the import", async () => {
  const routes = [
    () => answer("<html>not a catalog</html>"),
    () => {
      throw new Error(`connect ECONNREFUSED while sending Bearer ${TEST_KEY}`)
    },
    () => answer({ unexpected: true }),
  ]
  for (const catalog of routes) {
    resetModelsDevCache()
    const { stub } = routedFetch({ gateway: { data: [{ id: "m" }] }, catalog })
    const harness = mount()
    await withGlobalFetch(stub, async () => {
      const { status, text, payload } = await post(harness, { provider: "magpie" })
      assert.equal(status, 200)
      assert.equal(payload.ok, true)
      assert.deepEqual(payload.models, [{ id: "m" }])
      assert.equal(payload.modelsDev.source, "models.dev")
      assert.equal(payload.modelsDev.available, false)
      assert.equal(typeof payload.modelsDev.error, "string")
      assert.ok(payload.modelsDev.error.includes("models.dev"), "the report says what is unavailable")
      assert.equal(Object.hasOwn(payload.modelsDev, "enriched"), false)
      assert.ok(!text.includes(TEST_KEY), "a stubbed catalog failure must not leak the API key")
    })
  }
})

check("a loaded catalog is cached across route calls with the same fetch", async () => {
  resetModelsDevCache()
  const { stub, calls } = routedFetch({
    gateway: { data: [{ id: "cn:deepseek-flash" }] },
    catalog: modelsDevFixture,
  })
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const first = await post(harness, { provider: "magpie" })
    assert.equal(first.status, 200)
    assert.deepEqual(first.payload.models[0], DEEPSEEK_ENRICHED)
    assert.equal(callsTo(calls, MODELS_DEV_URL).length, 1)
    assert.equal(calls.length, 2)

    const second = await post(harness, { provider: "magpie" })
    assert.equal(second.status, 200)
    assert.deepEqual(second.payload.modelsDev, first.payload.modelsDev)
    assert.equal(callsTo(calls, MODELS_DEV_URL).length, 1, "the second import reuses the cached catalog")
    assert.equal(callsTo(calls, GATEWAY_URL).length, 2, "the gateway listing is still fetched per import")
    assert.equal(calls.length, 3)
  })
})

check("concurrent imports share one models.dev load (single-flight)", async () => {
  resetModelsDevCache()
  let catalogRequests = 0
  const catalog = async () => {
    catalogRequests += 1
    await new Promise((resolve) => setTimeout(resolve, 15))
    return answer(modelsDevFixture)
  }
  const { stub, calls } = routedFetch({
    gateway: { data: [{ id: "cn:deepseek-flash" }] },
    catalog,
  })
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const [first, second] = await Promise.all([
      post(harness, { provider: "magpie" }),
      post(harness, { provider: "magpie" }),
    ])
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(catalogRequests, 1, "two concurrent imports must share one catalog request")
    assert.equal(callsTo(calls, MODELS_DEV_URL).length, 1)
    assert.deepEqual(first.payload.models[0], DEEPSEEK_ENRICHED)
    assert.deepEqual(second.payload.models[0], DEEPSEEK_ENRICHED)
  })
})

check("discoverGatewayModels accepts an injected models.dev catalog", async () => {
  const { stub, calls } = jsonFetch({ data: [{ id: "cn:deepseek-flash" }] })
  const result = await discoverGatewayModels(
    {
      baseURL: "http://direct.test/v1",
      api: "openai-completions",
      apiKey: "direct-test-key",
      fetchImpl: stub,
    },
    { modelsDev: { catalog: modelsDevFixture } },
  )
  assert.equal(calls.length, 1, "an injected catalog causes no second network call")
  assert.deepEqual(result.models[0], DEEPSEEK_ENRICHED)
  assert.deepEqual(result.modelsDev, {
    source: "models.dev",
    available: true,
    matched: 1,
    enriched: [
      { id: "cn:deepseek-flash", fields: ["name", "contextWindow", "maxTokens", "input", "reasoningEfforts"] },
    ],
    unmatched: [],
  })
  assert.ok(!JSON.stringify(result).includes("direct-test-key"))
})

check("a models.dev timeout is tolerated by the direct discovery API", async () => {
  const keepAliveFor = (init, reject) => {
    // `AbortSignal.timeout` uses an unref'ed timer, so a hanging stub must keep
    // the event loop alive itself; otherwise the process could exit first.
    const keepAlive = setInterval(() => {}, 1000)
    const settle = (error) => {
      clearInterval(keepAlive)
      reject(error)
    }
    const signal = init?.signal
    if (signal === undefined) {
      settle(new Error("fetch was never aborted: no timeout signal"))
      return
    }
    if (signal.aborted) {
      settle(signal.reason)
      return
    }
    signal.addEventListener("abort", () => settle(signal.reason), { once: true })
  }
  const stub = async (url, init) => {
    if (url === MODELS_DEV_URL) {
      return new Promise((resolve, reject) => {
        void resolve
        keepAliveFor(init, reject)
      })
    }
    return answer({ data: [{ id: "cn:deepseek-flash" }] })
  }

  const result = await discoverGatewayModels(
    { baseURL: "http://slow-catalog.test/v1", api: "openai-completions" },
    { fetchImpl: stub, modelsDev: { timeoutMs: 25 } },
  )
  assert.deepEqual(result.models, [{ id: "cn:deepseek-flash" }], "the gateway mapping survives")
  assert.equal(result.modelsDev.source, "models.dev")
  assert.equal(result.modelsDev.available, false)
  assert.ok(result.modelsDev.error.includes("超时"), "the report explains the deadline")
})

check("fetchModelsDevCatalog validates, caches, and can be reset", async () => {
  resetModelsDevCache()
  const { stub, calls } = jsonFetch(modelsDevFixture)
  const catalog = await fetchModelsDevCatalog({ fetchImpl: stub })
  assert.deepEqual(catalog, modelsDevFixture)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, MODELS_DEV_URL)
  assert.equal(calls[0].init.headers.accept, "application/json")

  const again = await fetchModelsDevCatalog({ fetchImpl: stub })
  assert.equal(calls.length, 1, "the same fetch implementation reuses one load")
  assert.equal(again, catalog)

  resetModelsDevCache()
  await fetchModelsDevCatalog({ fetchImpl: stub })
  assert.equal(calls.length, 2, "resetModelsDevCache forces a fresh load")

  await assert.rejects(
    () => fetchModelsDevCatalog({ fetchImpl: async () => answer({ nope: true }) }),
    /models\.dev 目录格式无法识别/,
  )
})

/* -------------------------------------------------------------- 400 refusals -- */

check("an unknown provider is a 400 that names it", async () => {
  const { stub, calls } = forbiddenFetch()
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "missing-route" })
    assert.equal(status, 400)
    assert.equal(payload.ok, false)
    assert.ok(payload.message.includes("missing-route"))
    assert.ok(payload.message.includes("未找到供应商"))
    assert.equal(calls.length, 0)
  })
})

check("an unknown settings namespace is a 400", async () => {
  const { stub } = forbiddenFetch()
  const harness = mount(DEMO_PROFILE, { ns: "some-other-ns" })
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 400)
    assert.ok(payload.message.includes("llm-pi-ai"))
  })
})

check("a missing provider is a 400", async () => {
  const { stub } = forbiddenFetch()
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, {})
    assert.equal(status, 400)
    assert.ok(payload.message.includes("provider"))
  })
})

check("a non-JSON request body is a 400", async () => {
  const { stub } = forbiddenFetch()
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, "this is not json")
    assert.equal(status, 400)
    assert.ok(payload.message.includes("JSON"))
  })
})

check("an unsupported protocol is a 400 before any network or credential work", async () => {
  const profile = { ...DEMO_PROFILE, api: "azure-openai" }
  const { stub, calls } = forbiddenFetch()
  const harness = mount(profile)
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 400)
    assert.equal(payload.message, "该协议不支持自动拉取模型列表")
    assert.equal(calls.length, 0)
    assert.equal(harness.credentialCalls.length, 0)
  })
})

/* -------------------------------------------------------------- 502 failures -- */

check("a missing credential is a 502 naming the reference, with no network call", async () => {
  const { stub, calls } = forbiddenFetch()
  const harness = mount(DEMO_PROFILE, { credential: () => undefined })
  await withGlobalFetch(stub, async () => {
    const { status, text, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 502)
    assert.equal(payload.ok, false)
    assert.ok(payload.message.includes("MAGPIE_GATEWAY_API_KEY"))
    assert.ok(payload.message.includes("未找到凭据"))
    assert.equal(calls.length, 0)
    assert.ok(!text.includes(TEST_KEY))
  })
})

check("an upstream 401 is a 502 that suggests checking the API key", async () => {
  const harness = mount()
  const stub = async () => new Response("denied", { status: 401 })
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 502)
    assert.ok(payload.message.includes("网关返回 HTTP 401"))
    assert.ok(payload.message.includes("检查 API key"))
  })
})

check("an upstream 500 is a 502", async () => {
  const harness = mount()
  const stub = async () => new Response("boom", { status: 500 })
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 502)
    assert.equal(payload.message, "网关返回 HTTP 500")
  })
})

check("a non-JSON upstream body is a 502", async () => {
  const harness = mount()
  const stub = async () => new Response("<html>gateway</html>", { status: 200 })
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 502)
    assert.ok(payload.message.includes("不是 JSON"))
  })
})

check("a malformed listing envelope is a 502", async () => {
  const { stub } = jsonFetch({ unexpected: true })
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 502)
    assert.ok(payload.message.includes("模型列表"))
  })
})

check("a network error is a 502 whose message redacts the API key", async () => {
  const harness = mount()
  const stub = async () => {
    throw new Error(`connect ECONNREFUSED while sending Bearer ${TEST_KEY}`)
  }
  await withGlobalFetch(stub, async () => {
    const { status, text, payload } = await post(harness, { provider: "magpie" })
    assert.equal(status, 502)
    assert.ok(payload.message.includes("无法连接网关"))
    assert.ok(payload.message.includes("http://gateway.test/v1/models"))
    assert.ok(!text.includes(TEST_KEY), "even an echoing network error must not leak the key")
    assert.ok(text.includes("[已隐藏凭据]"))
  })
})

check("a settings describe failure is a contained 502", async () => {
  const harness = mount(DEMO_PROFILE, { describeError: new Error("settings unavailable") })
  const { status, payload } = await post(harness, { provider: "magpie" })
  assert.equal(status, 502)
  assert.equal(payload.ok, false)
  assert.equal(typeof payload.message, "string")
  assert.ok(!payload.message.includes("settings unavailable"))
})

/* ------------------------------------------------ discoverGatewayModels API -- */

check("discoverGatewayModels can be driven directly with a fetchImpl profile", async () => {
  const { stub, calls } = jsonFetch({ data: fixture.data })
  const result = await discoverGatewayModels({
    baseURL: "http://direct.test/v1",
    api: "openai-completions",
    apiKey: "direct-test-key",
    headers: { "x-static": "yes" },
    fetchImpl: stub,
  })
  assert.equal(result.models.length, 28)
  assert.ok(result.warnings.includes("group/never-stuck：跳过 DSH 不支持的推理档位 ultra"))
  assert.equal(calls[0].url, "http://direct.test/v1/models")
  assert.equal(calls[0].init.headers.authorization, "Bearer direct-test-key")
  assert.equal(calls[0].init.headers["x-static"], "yes")
  assert.ok(!JSON.stringify(result).includes("direct-test-key"))
})

check("discoverGatewayModels classifies unusable profiles as status 400", async () => {
  const cases = [
    [{ api: "openai-completions" }, /baseURL/],
    [{ baseURL: "http://x.test/v1", api: "azure-openai" }, /协议不支持/],
    [{ baseURL: "not a url", api: "openai-completions" }, /URL/],
  ]
  for (const [profile, pattern] of cases) {
    await assert.rejects(
      () => discoverGatewayModels(profile, { fetchImpl: async () => new Response("{}") }),
      (error) => {
        assert.equal(error.status, 400)
        assert.match(error.message, pattern)
        return true
      },
    )
  }
})

check("discoverGatewayModels enforces the fetch timeout", async () => {
  // `AbortSignal.timeout` uses an unref'ed timer, so a hanging stub must keep the
  // event loop alive itself; otherwise the process can exit before the deadline.
  const hangingFetch = (url, init) =>
    new Promise((resolve, reject) => {
      const keepAlive = setInterval(() => {}, 1000)
      const safety = setTimeout(
        () => settle(new Error("fetch was never aborted: the timeout was not enforced")),
        1000,
      )
      function settle(error) {
        clearInterval(keepAlive)
        clearTimeout(safety)
        reject(error)
      }
      const signal = init?.signal
      if (signal === undefined) return
      if (signal.aborted) {
        settle(signal.reason)
        return
      }
      signal.addEventListener("abort", () => settle(signal.reason), { once: true })
    })
  await assert.rejects(
    () =>
      discoverGatewayModels(
        { baseURL: "http://slow.test/v1", api: "openai-completions" },
        { fetchImpl: hangingFetch, timeoutMs: 25 },
      ),
    (error) => {
      assert.equal(error.status, 502)
      assert.match(error.message, /超时/)
      return true
    },
  )
})

/* ---------------------------------------------------------------- runner --- */

let failed = 0
for (const { name: testName, fn } of results) {
  try {
    await fn()
    console.log(`PASS  ${testName}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${testName}`)
    console.log(`      ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`\n${String(results.length - failed)}/${String(results.length)} passed`)
if (failed > 0) process.exitCode = 1
