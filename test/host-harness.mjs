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
import { apply, discoverGatewayModels, inject, name } from "../lib/index.js"

const ROUTE = "/api/dsh-llm-model-tuning/models"
const TEST_KEY = "magpie-live-test-key-123456"
const fixture = JSON.parse(readFileSync(new URL("./fixtures/magpie-models.json", import.meta.url), "utf8"))

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

/* ------------------------------------------------------------ registration -- */

check("the module exports the host contract surface", () => {
  assert.equal(name, "llm-model-tuning")
  assert.deepEqual(inject, ["settings", "credentials", "connection"])
  assert.equal(typeof apply, "function")
  assert.equal(typeof discoverGatewayModels, "function")
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

check("the route maps the live fixture and answers { ok, models, warnings }", async () => {
  const { stub, calls } = jsonFetch(fixture)
  const harness = mount()
  await withGlobalFetch(stub, async () => {
    const { status, text, payload } = await post(harness, { provider: "magpie" })

    assert.equal(status, 200)
    assert.deepEqual(Object.keys(payload).sort(), ["models", "ok", "warnings"])
    assert.equal(payload.ok, true)
    assert.equal(payload.models.length, 28)
    assert.ok(Array.isArray(payload.warnings))
    assert.ok(payload.warnings.includes("group/never-stuck：跳过 DSH 不支持的推理档位 ultra"))
    assert.deepEqual(
      payload.models.find((entry) => entry.id === "claude/claude-haiku-5-5"),
      HAIKU_ENTRY,
    )

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "http://gateway.test/v1/models")
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
  const { stub, calls } = jsonFetch({ data: [{ id: "m" }] })
  const harness = mount(DEMO_PROFILE, { ns: "custom-provider-ns" })
  await withGlobalFetch(stub, async () => {
    const { status, payload } = await post(harness, { provider: "magpie", settingsNs: "custom-provider-ns" })
    assert.equal(status, 200)
    assert.deepEqual(payload.models, [{ id: "m" }])
    assert.equal(calls.length, 1)
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
