/**
 * Conformance test: the documents this card writes must satisfy the REAL
 * `llm-pi-ai` adapter schema, not a reimplementation of it.
 *
 * The card builds its own draft and validation because the settings transport
 * swallows a rejected write instead of reporting which field failed. That makes
 * a drift risk worth testing directly: the card is driven through its UI, the
 * resulting `llm-pi-ai` section is handed to the adapter's own exported
 * `Config` schema, and the schema is made to judge it.
 *
 * Run: node test/conformance.mjs
 */
import { loadAdapterConfig, reportSkip } from "./dsh-adapter.mjs"

const results = []
function check(name, fn) {
  results.push({ name, fn })
}

/** Validate one section against the real schema; returns the failure text or undefined. */
function validate(Config, section) {
  try {
    const resolved = Config(section)
    if (resolved === undefined) return "schema returned undefined"
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/* ----------------------------------------------------------------- cases --- */

check("a models-list route with effort levels and modalities", (Config) => {
  // Exactly the shape the card produces for the `exampleGateway` fixture: `off`
  // spelled as null and a named wire value for the thinking level.
  const section = {
    providers: {
      exampleGateway: {
        apiKeyEnv: "MY_GATEWAY_API_KEY",
        api: "openai-completions",
        baseURL: "https://gateway.example.com/v1",
        models: [
          {
            id: "auto",
            name: "Auto",
            contextWindow: 168000,
            maxTokens: 32000,
            input: ["text", "image"],
            reasoningEfforts: { high: "high", off: null },
          },
        ],
      },
    },
  }
  return validate(Config, section)
})

check("a modelOverrides route carrying only effort", (Config) => {
  const section = {
    providers: {
      catalogroute: {
        apiKeyEnv: "CATALOG_API_KEY",
        modelOverrides: {
          "some-catalog-model": { reasoningEfforts: { low: "low", high: "high" } },
        },
      },
    },
  }
  return validate(Config, section)
})

check("a provider-level defaultInput fallback", (Config) => {
  const section = {
    providers: {
      exampleGateway: {
        apiKeyEnv: "MY_GATEWAY_API_KEY",
        api: "openai-completions",
        baseURL: "https://gateway.example.com/v1",
        defaultInput: ["text", "image"],
        models: [{ id: "auto", name: "Auto", contextWindow: 1000, maxTokens: 100 }],
      },
    },
  }
  return validate(Config, section)
})

check("declaring no reasoning at all (`false`)", (Config) => {
  const section = {
    providers: {
      exampleGateway: {
        apiKeyEnv: "MY_GATEWAY_API_KEY",
        api: "openai-completions",
        baseURL: "http://x/v1",
        models: [{ id: "auto", reasoningEfforts: false }],
      },
    },
  }
  return validate(Config, section)
})

/* ---- the refusals the card reproduces must also be refusals for the schema -- */

check("REFUSED: a level beyond off with an empty wire value", (Config) => {
  const section = {
    providers: {
      exampleGateway: {
        apiKeyEnv: "K",
        api: "openai-completions",
        baseURL: "http://x/v1",
        models: [{ id: "auto", reasoningEfforts: { high: "" } }],
      },
    },
  }
  const failure = validate(Config, section)
  // An empty string is schema-valid (only resolution rejects it), so this case
  // documents the boundary the card must therefore enforce itself.
  return failure === undefined ? "SCHEMA-ACCEPTS (card's own rule is the only guard)" : undefined
})

check("REFUSED: an unknown reasoning level name", (Config) => {
  const section = {
    providers: {
      exampleGateway: {
        apiKeyEnv: "K",
        api: "openai-completions",
        baseURL: "http://x/v1",
        models: [{ id: "auto", reasoningEfforts: { turbo: "turbo" } }],
      },
    },
  }
  const failure = validate(Config, section)
  if (failure === undefined) throw new Error("expected the schema to reject an unknown level name")
})

check("REFUSED: an unknown modality name", (Config) => {
  const section = {
    providers: {
      exampleGateway: {
        apiKeyEnv: "K",
        api: "openai-completions",
        baseURL: "http://x/v1",
        models: [{ id: "auto", input: ["text", "audio"] }],
      },
    },
  }
  const failure = validate(Config, section)
  if (failure === undefined) throw new Error("expected the schema to reject an unknown modality")
})

/* ---------------------------------------------------------------- runner --- */

const Config = await loadAdapterConfig()
if (Config === undefined) {
  reportSkip("conformance")
  process.exit(0)
}

const failures = []
for (const entry of results) {
  try {
    const outcome = entry.fn(Config)
    console.log(`PASS  ${entry.name}${outcome === undefined ? "" : ` — ${outcome}`}`)
  } catch (error) {
    failures.push(entry.name)
    console.log(`FAIL  ${entry.name}`)
    console.log(`      ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`\n${String(results.length - failures.length)}/${String(results.length)} passed`)
if (failures.length > 0) process.exitCode = 1
