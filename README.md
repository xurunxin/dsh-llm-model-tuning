# dsh-llm-model-tuning

[![CI](https://github.com/xurunxin/dsh-llm-model-tuning/actions/workflows/ci.yml/badge.svg)](https://github.com/xurunxin/dsh-llm-model-tuning/actions/workflows/ci.yml)

Adds a per-model **reasoning-effort** and **multimodal input** editor to every custom provider card on the DeepSeek Harness **Settings → Models** page, rendered in the same visual language as the shipped page, plus a **Magpie gateway import** that can pull a provider's `/models` listing, translate its Magpie extension fields into `llm-pi-ai` model entries, and let you pick which of them to import from a searchable selection dialog before filing them into the card's draft.

When that listing does not disclose a model's details — a bare OpenAI-style `{"id":…}` row, or one that names only a context window — the Host **completes the missing settings from [models.dev](https://models.dev/)**, matching decorated ids such as `xxx/gpt-6.1-sol`, `cn:deepseek-flash` or `cn:kimi-k3-1` to their catalog model instead of guessing from the raw string. Gateways that spell model detail differently are understood too: WorkBuddy-style `attachments`/`supports_images` feed `input`, and `reasoning_supported_efforts`/`supports_reasoning`/`only_reasoning` feed `reasoningEfforts`, so a WorkBuddy import carries the modalities and reasoning the gateway itself spells out even when the catalog is unreachable. The completion is shown in the dialog (`补全` badges and a summary line), never overrides what the gateway itself disclosed, and a models.dev outage only costs the completion — the import still succeeds. The selection dialog also **sizes itself to the model names** it lists, so a long id or display name is readable in full instead of hidden behind an ellipsis.

> **Requires dsh 0.1.7 or newer.** This card writes settings through the `configForms` service; the older `settingsScope` service was removed in 0.1.7. The gateway import additionally uses the Connection exact Fetch-route registry (`ctx.connection.fetch.register`). See [Requirements](#requirements).

Reasoning effort is a *per-model* capability — the models under one provider disagree about it, so a provider-scoped control could only be set to a value some of them reject. This plugin keeps a per-model editor with its own granularity (including the wire spelling each level sends) and adds the gateway import that the shipped editor does not perform: it lists the route's own model entries, lets you choose which gateway models to add or overwrite, and edits two fields on each:

| Field | Meaning |
| --- | --- |
| `reasoningEfforts` | Which effort levels the model offers, and the wire spelling each one sends. `false` declares a non-reasoning model; absent inherits the installed catalog. |
| `input` | Which request modalities the model accepts (`text`, `image`). Absent inherits the installed catalog. |

It also edits the route-level `defaultInput` fallback, which is what makes a gateway serving vision models the catalog does not describe usable.

Both fields are written into the `llm-pi-ai` settings section, so a change reaches the next request with no restart — the adapter resolves profiles per request.

## 从网关导入模型 — Magpie import with model selection

Expand a custom provider card and click **获取可用模型** (the button reads `正在询问提供商…` and is disabled while the request runs). The card stays a thin client: the Host half resolves the provider's profile and credential, fetches `GET {baseURL}/models`, maps the Magpie extensions to storable `llm-pi-ai` entries, and answers the page.

A listing with at least one importable model opens the **选择要添加的模型** dialog (an empty listing reports the warn status `网关没有返回可导入的模型。` instead):

- the search input `搜索模型` filters the candidates as you type; no match shows `没有匹配的模型。`;
- every candidate is checked by default — new and existing ids alike; `全选` / `取消全选` toggles all *visible* candidates;
- each candidate carries a `新增` badge, or a `覆盖` badge when its id already exists in the card's draft;
- `取消` closes the dialog without importing; `添加所选` is disabled while nothing is selected.

Nothing is imported until you confirm with **添加所选**. **The import only edits the draft** — nothing is written until you click **保存** (or **放弃修改** discards it). A failed fetch keeps the dialog closed and reports `导入失败：<message>` in the card.

The gateway answer may be an OpenAI-style `{"data":[…]}` array or a `{"models":{…}}` map. Each entry's Magpie extension fields map as follows:

| Gateway field | Written `llm-pi-ai` field | Rule |
| --- | --- | --- |
| `id` | `id` | The model id. For a `{"models":{…}}` map the key is used when the value has no `id`; an entry without any usable id is skipped with a warning. |
| `display_name` (then `name` / `displayName`) | `name` | Only a genuinely disclosed name is written; with none, the entry omits `name` and the card's label falls back to the id. |
| `context_window`, `context_length`, `max_input_tokens`, `contextWindow` | `contextWindow` | The first positive integer in that order. |
| `max_output_tokens`, `maxTokens`, `max_tokens` | `maxTokens` | The first positive integer in that order. |
| `modalities.input` (then `input_modalities`, then `input`, then `attachments`, then `supports_images: true`) | `input` | Lowercased; only `text` and `image` survive. `text` is the floor (added whenever a list is disclosed); other names such as `pdf` are skipped with a warning. The WorkBuddy-style `attachments: ["image"]` array and the `supports_images: true` hint disclose image input the same way. No disclosed modalities ⇒ field omitted. |
| `reasoning: false`, or `supports_reasoning: false` when no other reasoning declaration and no levels are present | `reasoningEfforts: false` | Declares a non-reasoning model. An explicit `reasoning: true` / `only_reasoning: true` / `supports_reasoning: true` beside it wins and follows the warning rule below. |
| `supported_reasoning_levels[].effort` (then `reasoning_levels` strings, then `reasoning_supported_efforts` / `supported_reasoning_efforts`) | `reasoningEfforts` | Normalized to lower case; the allowed levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `off`/`none` become `off: null`; every other level becomes `{ "<level>": "<level>" }` — the wire spelling is the disclosed effort name. Levels outside that set (e.g. `ultra`) are skipped with a warning. |
| `reasoning: true`, `only_reasoning: true` or `supports_reasoning: true` but no disclosed levels (or only unsupported ones) | — | Field omitted with a warning; the installed catalog (or the models.dev completion) answers for the model. |
| `reasoning_default_effort`, `reasoning_effort` | — | A single default effort, not a level list: not mapped (it is not evidence of which other levels the model accepts). |
| no `reasoning` flag and no levels | — | Field omitted (unknown is not guessed). |
| `magpie_label`, `service_tiers`, `owned_by`, `type`, `pricing`, … | — | Ignored; only the fields above are translated. |

Per-model notes (skipped `ultra` levels, skipped `pdf` modalities, a reasoning model without disclosed levels, an entry without an id) are collected by the Host and shown after the import line as `网关提示：…`.

Confirming the dialog merges **only the selected** candidates:

- **New id + selected + `models` mode** — appended in gateway order (badge `新增`), keeping the existing entries' order.
- **Existing id + selected** — its **managed fields are overwritten** (badge `覆盖`): `name`, `contextWindow`, `maxTokens`, `input`, and `reasoningEfforts`. Each managed field takes the mapped value when the candidate discloses it and is **deleted** when it does not, so a gateway that stops reporting a model's reasoning levels or modalities clears the old values (the model falls back to the installed catalog). `id` and unmanaged raw fields (e.g. `compat`) are preserved. The editable controls are rebuilt from the mapped values.
- **Existing id + not selected** and **entries the gateway does not return** — untouched, byte for byte.
- **`modelOverrides` mode** — a selected existing id is overwritten as above. A selected *new* id is skipped with `跳过 S 个新模型：当前是 modelOverrides 模式，不能新增模型条目。`, because an override cannot introduce a catalog-unknown model.
- Re-importing the same listing with everything selected is **idempotent**: no duplicates, stable model order, and the draft ends up unchanged — the saved section stays identical without needing another save.

A successful attempt reports `已导入 N 个模型（新增 X、覆盖 Y）`, where `N` counts the selected candidates that produced an entry; the Host's per-model notes follow as `网关提示：…`. A gateway that returns nothing importable reports a warning instead.

## 缺失模型详情时自动补全 — models.dev enrichment

A gateway does not have to disclose anything beyond `id` — the common OpenAI-compatible answer is `{"data":[{"id":"gpt-6.1-sol"}, …]}`. When at least one mapped entry is missing one of `contextWindow`, `maxTokens`, `input`, or `reasoningEfforts`, the Host looks the model up in the public [models.dev](https://models.dev/) catalog (`https://models.dev/api.json`) and fills the missing `llm-pi-ai` fields before the selection dialog opens:

- **The gateway always wins.** A field the gateway disclosed is never replaced; only absent fields are completed. An entry that already discloses every detail field triggers no lookup at all; a model whose only gap is its reasoning levels is still looked up, and keeps the gateway's own `网关提示` beside the completed effort map (or beside nothing when models.dev has no effort data either).
- **Best effort, never fatal.** The catalog is fetched with a 10 s deadline and cached in memory for 6 hours. A timeout, an HTTP failure, or a malformed catalog only skips the completion (`modelsDev.available: false` plus a human-readable `error`); the import itself still succeeds with the gateway mapping.
- **Reasoning can be completed too.** Because a missing effort map counts as a gap, a gateway entry that says nothing about reasoning can receive models.dev's effort levels; the dialog marks it with `补全`, and every completed value stays editable in the card.
- The catalog is consulted by the Host only. The page keeps calling the same same-origin route; the browser fetches nothing extra and no credential is involved.

### 智能匹配 — how decorated ids are matched

Gateway ids are often decorated with a provider/category segment, or spell the same model differently (case, dots vs. dashes, a `canonical_model_id`). Matching normalizes case and separators, then considers the full id, every tail after a `/` or `:` separator, the disclosed display name, and — on the catalog side — model ids, `canonical_model_id`s, names and families:

| Gateway id | Matched catalog model | Rule |
| --- | --- | --- |
| `xxx/gpt-6.1-sol` | `openai/gpt-6.1-sol` | an unknown provider prefix is peeled; the catalog's authoritative vendor (`openai`) wins over aggregator copies of the same model |
| `cn:deepseek-flash` | `deepseek/deepseek-flash` | a `:` category prefix is peeled; the official vendor beats resellers |
| `cn:kimi-k3-1` | `moonshotai/kimi-k3` | a short **local disambiguation suffix** (`-1`, `-b`, `-ctrl`, `-exp`, …) is peeled as a last resort when no direct match exists; the catalog's authoritative vendor wins |
| `cn:hy3-b` / `cn:hy4-preview-ctrl` | `aihubmix/hy3` / `aihubmix/hy4-preview` | the same local-suffix rule |
| `openai/gpt-6.1-sol` | provider `openai`, model `gpt-6.1-sol` | the provider prefix names a catalog provider |
| `@cf/openai/gpt-oss-20b` | `@cf/openai/gpt-oss-20b` (canonical `openai/gpt-oss-20b`) | an exact catalog id wins; nested vendor prefixes are peeled when no full id matches |
| `claude/claude-haiku-5-5` | `anthropic/claude-haiku-5-5` | a provider alias resolves through a catalog tail key; the authoritative vendor then wins |
| `Claude Haiku 5.5` (display name) | `anthropic/claude-haiku-5-5` | the disclosed display name is matched too |
| `gpt-6.1-sol` / `gpt-6-1-sol` | the same model | normalization equates dot/dash/underscore spellings |
| `group/smart-split` | — | no plausible match: the entry is left exactly as the gateway returned it |
| `gpt-6.1-turbo` | — | an invented suffix no catalog model has is not approximated |

Ambiguity is resolved deterministically: an exact catalog id beats a canonical-id match; a match from the hinted provider, or from the model's own vendor (the prefix of its `canonical_model_id`), beats another provider's copy; a more complete record beats a sparse one; then provider and model id order decide. A guarded last tier maps a *versionless family alias* (`claude-haiku`, `gpt-sol`) to the family's catalog record — deterministic, but only a hint: that record may be an older or newer member of the family. Below that, an id whose only difference from a catalog id is a trailing **local disambiguation marker** (a single letter or digit, `ctrl`, or `exp`) is matched to the base model (`cn:kimi-k3-1` → `kimi-k3`); this tier never receives the provider/vendor bonuses, so it can never outrank a normal match. Only one such token is peeled: a longer invented suffix stays unmatched (`gpt-6.1-turbo`), while a trailing version-like token can still resolve to the base model (`gpt-6.1-sol-2` → `gpt-6.1-sol`, `cn:kimi-k3-2` → `kimi-k3`) — that is a heuristic hint rather than proof of the exact variant.

### 补全字段 — what is filled in

| models.dev field | Written `llm-pi-ai` field | Rule |
| --- | --- | --- |
| `limit.context` | `contextWindow` | The positive integer. |
| `limit.output` | `maxTokens` | The positive integer. |
| `modalities.input` | `input` | Filtered to `text` and `image` (`pdf`/`audio`/`video` are dropped silently); text stays the floor; canonical order `["text","image"]`. |
| `reasoning_options[].values` (`type: "effort"`) | `reasoningEfforts` | `none`/`off` become `off: null`; only the seven levels the schema accepts survive (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), each spelled with its own name; other values are skipped. |
| `reasoning_options` (`type: "toggle"`) | `reasoningEfforts` | Adds `off: null` when there is at least one usable effort level; a toggle-only model yields no effort map. |
| `reasoning_options` (`type: "budget_tokens"`) | — | Ignored: a thinking-token budget is not an effort level. |
| `reasoning: false` | `reasoningEfforts: false` | Declares a non-reasoning model. |
| `reasoning: true` with no usable level | — | Omitted rather than guessed; the installed catalog answers. |
| `name` | `name` | Only when the gateway disclosed no display name, and never when the catalog name merely echoes the id (`gpt-5.1`) — writing that would replace a stored display name with the raw id, which the gateway mapping already avoids. |

Only those five managed fields are touched; `id` and every unmanaged field (e.g. `compat`) stay as the gateway returned them, and **a completed entry carries no marker field** — it is an ordinary storable `llm-pi-ai` entry.

### 响应与界面 — response shape and UI

The import route's success body grows one optional key, present only when a lookup was attempted (the old `{ ok, models, warnings }` shape is unchanged otherwise):

```json
{
  "ok": true,
  "models": [ /* storable llm-pi-ai entries; completed fields are indistinguishable from disclosed ones */ ],
  "warnings": ["group/never-stuck：跳过 DSH 不支持的推理档位 ultra"],
  "modelsDev": {
    "source": "models.dev",
    "available": true,
    "matched": 3,
    "enriched": [{ "id": "openai/gpt-6.1-sol", "fields": ["name", "contextWindow", "maxTokens", "input", "reasoningEfforts"] }],
    "unmatched": ["group/smart-split"]
  }
}
```

An unreachable or unusable catalog still answers HTTP 200 with the mapped entries; the failure is reported beside them:

```json
{ "ok": true, "models": [ /* … */ ], "warnings": [], "modelsDev": { "source": "models.dev", "available": false, "error": "获取 models.dev 目录超时，已跳过自动补全" } }
```

A request body may pass `"enrich": false` to skip the completion entirely.

In the dialog, a completion hint (`已通过 models.dev 自动补全 N 个模型的设置。`) appears above the candidate list, every completed candidate carries a `补全` badge whose hover title names the filled fields (`名称、上下文、最大输出、输入类型、推理档位`), and confirming the import appends `models.dev 补全：N 个模型` to the status line when at least one selected enriched model was actually imported. When the catalog was unavailable the dialog says so (`models.dev 补全不可用：<error>`) instead. An older Host that never sends `modelsDev` shows no completion hint, no `补全` badges and no completion count; the adaptive dialog width is independent of the payload and applies regardless.

### 对话框宽度 — the selection dialog sizes itself

The dialog no longer fixes its width at 380 px: it estimates the room the longest candidate id and display name need (CJK counted double), clamps the result to 380–920 px, and caps it at the viewport (`calc(100vw - 48px)`). Candidate ids and names wrap instead of being ellipsized — each row also carries a `title` with the full `id · name` — and the width is computed over **all** candidates, so typing in `搜索模型` never makes the dialog jump.

## How it is put together

**Client card.** It renders the same visual language as the shipped Models page: a collapsed header (`模型调优` / `展开配置`), then the provider-level `默认输入类型` fallback, the `从网关导入` group, the `模型（N）` list whose entries expand through `模型选项` into `输入类型` checkboxes and a `推理能力` select (inherit / off / custom level rows with `添加档位` / `删除档位`), an add-model row, and `保存` / `放弃修改` actions. The import opens the selection dialog described above: it sizes itself to the candidate names, shows the `补全` badges/models.dev hint when the Host completed settings, and reports the completion count after confirming.

It registers on the `settings.models.provider-card` seat under the `llm-pi-ai` namespace, keyed by the provider row's own settings namespace. Because every configurable pi-ai route declares `settingsNs: 'llm-pi-ai'`, a single registration under that key receives every custom-provider card — saved rows and the add-provider draft alike — without the Models section knowing anything about this plugin. The card follows the namespace through `configForms.whileServed`, so a deployment without that adapter shows no trace of it, and it reads/writes the namespace through a `configForms` form (`getSnapshot`/`subscribe`/`mutate`).

**Host half.** The entry is no longer empty: it injects `settings`, `credentials`, and `connection` and registers one exact Connection Fetch route. The page only calls this route; the API key never reaches the browser. The route also performs the optional models.dev completion (a plain public catalog fetch with its own deadline and cache — no credential involved), so the browser never talks to models.dev and the returned entries are already complete. The pure matching/completion rules live in `lib/modelsdev.js` (also exported as `dsh-llm-model-tuning/modelsdev`), and the Host re-exports `fetchModelsDevCatalog()` / `resetModelsDevCache()` for live checks and tests.

```
POST /api/dsh-llm-model-tuning/models
content-type: application/json
{ "provider": "<route id>", "settingsNs": "llm-pi-ai", "enrich": true }   // last two optional; settingsNs defaults llm-pi-ai, enrich to true
```

Success — HTTP 200:

```json
{ "ok": true, "models": [ /* storable llm-pi-ai model entries */ ], "warnings": ["group/never-stuck：跳过 DSH 不支持的推理档位 ultra"] }
```

When a models.dev lookup was attempted the body also carries the optional `modelsDev` key (shape in [缺失模型详情时自动补全](#缺失模型详情时自动补全--modelsdev-enrichment)); `"enrich": false` in the request body skips it entirely.

Failure — HTTP 400 (bad request / unknown provider / unsupported protocol / unusable profile) or 502 (gateway unreachable, auth refused, non-JSON listing, missing credential):

```json
{ "ok": false, "message": "给用户看的中文说明" }
```

Host behaviour:

1. Reads the live `llm-pi-ai` descriptor from `ctx.settings.describe({ redactSecrets: true })` and takes `value.providers[<route>]` — the resolved profile, so a route declared only in the composition base/`cordis.patch.yml` is found too. A missing namespace or route answers 400.
2. Chooses the listing endpoint from `profile.api` (default `openai-completions`):
   - `openai-completions` / `openai-responses`: `GET {baseURL without a trailing slash}/models`
   - `anthropic-messages`: strips a trailing `/v1` from `baseURL`, then `GET {root}/v1/models?limit=1000` with `x-api-key` and `anthropic-version: 2023-06-01`
   - anything else answers 400 `该协议不支持自动拉取模型列表`.
3. Starts from the profile's `headers` (string values only), sets `accept: application/json`, and adds the auth header. If `profile.apiKeyEnv` is set, `await ctx.credentials.resolve(ref)` supplies the key; a missing credential answers 502 naming the reference. With no `apiKeyEnv` the listing is fetched unauthenticated.
4. Fetches with a 20 s timeout, answers 502 `网关返回 HTTP <status>` on a non-2xx response (401/403 adds a check-the-key hint), and maps a non-JSON body to 502 as well.
5. Maps the listing with `lib/magpie.js` (including the WorkBuddy-style `attachments` / `supports_images` / `reasoning_supported_efforts` / `supports_reasoning` / `only_reasoning` spellings); when at least one entry lacks `contextWindow`, `maxTokens`, `input`, or `reasoningEfforts`, completes the missing managed fields from models.dev via `lib/modelsdev.js` (gateway-disclosed fields are never replaced; failures are tolerated and reported in the optional `modelsDev` key).
6. Returns the storable entries, the per-model mapping warnings, and the optional completion report.

The route is registered with `ctx.effect(() => ctx.connection.fetch.register({ path, methods: ["POST"], requestBody: "buffered", fetch }))`, so it is disposed with the plugin's fiber. The `/api` prefix authenticates the browser session before any exact route is dispatched; the handler only ever sees the authenticated same-origin page.

## Install

Install the bundle with the plugin manager, pointing it at this directory:

```
plugin_manager  action: install_bundle  target: <absolute path to this package>
```

That performs the package installation and bundle selection itself — it adds the
dependency, links it into the active profile's `node_modules`, and appends the
package to `dsh.profile.bundles` because it declares `dsh.bundle.patch`. Do not
hand-edit the profile's `package.json` or `cordis.patch.yml`, and do not run a
package manager in the profile directory.

The install is a **symlink** to this directory, so later edits here are picked up
without reinstalling. A freshly installed bundle can activate through HMR; a
replaced one needs a profile restart to load a fresh JavaScript module
generation.

## Requirements

- **dsh 0.1.7 or newer.** The card reads and writes settings through the
  `configForms` service (the older `settingsScope` service was removed in 0.1.7,
  and a card still injecting it never activates — the row simply waits forever;
  `test/bundle-contract.mjs` guards against that regression). The gateway import
  additionally needs the Connection exact Fetch-route registry
  (`ctx.connection.fetch.register`), which the same runtime provides.
- The `llm-pi-ai` adapter must be composed, since it owns the settings namespace
  this card edits and the provider profiles the import route reads. The card
  follows it with `configForms.whileServed`, so a deployment without that
  adapter shows no trace of this card rather than a dead panel.
- The Host half needs the `settings`, `credentials`, and `connection` services
  (declared via its `inject`), which the standard web and desktop profiles
  compose. The credential named by a provider's `apiKeyEnv` must be resolvable
  through the credentials service for an authenticated gateway.
- The optional models.dev completion needs outbound HTTPS from the Host process
  to `https://models.dev/api.json`. Without it the import still works — only the
  completion is skipped and reported as unavailable; a fetched catalog is cached
  for six hours.

## What the card does with your document

- **Edit surface.** The card reads and writes the *user* layer of the `llm-pi-ai` section. A route declared only in the composition base is read from the resolved value so it can still be tuned; writing it is what materializes it in the user layer.
- **Path-addressed writes.** Every hand edit travels as `settings.mutate` path ops against the stored section, so fields the card never rendered cannot be deleted. The one deliberate exception is the gateway import: for a model you select in the dialog it rebuilds the five managed fields in the draft, which is what makes an overwrite able to clear a value the gateway no longer discloses. `id` and unmanaged fields are kept. The namespace revision fences a stale card against a concurrent change.
- **`models` vs `modelOverrides`.** A `models` list *replaces* the installed catalog, while `modelOverrides` reshapes it. The adapter refuses both together, so the card edits whichever the profile already uses and offers to add `modelOverrides` entries when neither is present. A `models` list is an array — and the settings path-op walker refuses to descend through arrays — so that array is written as one value; a `modelOverrides` dict is addressed field by field.
- **Text is held on.** `input` and `defaultInput` replace a modality list rather than extending it, so declaring images alone would quietly drop text and leave a model the harness can no longer talk to. Text is therefore always kept, and clearing the last optional modality removes the field so the adapter's own default answers instead.
- **Refusals are named locally.** `ConfigFormController.mutate` reports whether the Host *accepted* a write, not which field it rejected. The card therefore reproduces the adapter's own `reasoningEfforts` rules (every level needs a wire spelling; only `off` may be empty; at least one level beyond `off`) so a refusal names the field, and it still reports a Host rejection as a failure rather than success.

## Tests

```sh
npm test
```

Seven suites, all offline, no dependencies to install:

| Suite | What it proves |
| --- | --- |
| `test/harness.mjs` | The card's own behaviour, driven through its real controls against a faithful settings-op simulator. Includes the selection dialog (default-all-checked, `新增`/`覆盖` badges, search, 全选/取消全选, cancel/Escape), selected-only importing, managed-field overwrite *and* clearing, idempotent re-import, `modelOverrides` skip behaviour, the failure/no-write paths, a rejection-never-reported-as-success case, the models.dev completion display, and the adaptive dialog width (380 px floor → growth → 920 px cap, search never resizing, no truncation). |
| `test/modelsdev.mjs` | The pure models.dev module: catalog index, smart matching of decorated ids (`xxx/gpt-6.1-sol`, `cn:deepseek-flash`, `cn:kimi-k3-1` local-suffix aliases, dotted versions, canonical ids, display names, ambiguity/authoritative-vendor resolution, false-positive guards), fill-only-missing enrichment, modality filtering, reasoning mappings (`none`→`off:null`, toggle, toggle-only, `reasoning:false`, unsupported values), malformed catalogs, and the summary shape. |
| `test/magpie.mjs` | The mapping module against the saved live 28-model Magpie listing, plus WorkBuddy-shaped entries: capacities, modalities (`modalities.input`/`attachments`/`supports_images`), reasoning levels (`supported_reasoning_levels`/`reasoning_levels`/`reasoning_supported_efforts`), `only_reasoning`/`supports_reasoning` handling, `ultra`/`pdf` skips, both envelopes, malformed input. |
| `test/host-harness.mjs` | The Host route handler with a stubbed `ctx` and stubbed `fetch`: success shape, 400 unknown provider, 502 upstream failure, authorization header, route path/methods/body mode, URL-routed catalog stubs for sparse listings, WorkBuddy-shaped listings mapped and completed end-to-end, models.dev failure/timeout tolerance, `enrich:false`, catalog-cache reuse, and injected-catalog discovery. |
| `test/integration.mjs` | The **exact section the card wrote** is accepted by the **real** `llm-pi-ai` `Config` schema — including a section written after an import confirmed through the selection dialog, an idempotent second import, a managed-field overwrite that clears a no-longer-disclosed value, and an imported `modelOverrides` update. |
| `test/conformance.mjs` | Document shapes, and the refusals the card reproduces, checked against that same real schema. |
| `test/bundle-contract.mjs` | The bundle satisfies the loader's registration protocol and requires nothing outside the module baseline. |

The schema-checked suites need an installed `@deepseek-ai/dsh-llm-pi-ai` to
compare against. `test/dsh-adapter.mjs` locates one from `DSH_PROFILE_DIR`,
`DSH_HOME`, or the usual `~/.dsh/profiles` layout; when none is reachable they
print a labelled `SKIP` and exit 0 instead of failing, so a contributor without
a DSH installation still gets a green run. Set `DSH_PI_AI_DIR` to point at an
unusual layout.

The last assertions in `conformance.mjs` are informative on purpose: the real schema **accepts** an empty wire value for a thinking level, because only the adapter's resolution step rejects it. That confirms the card's own validation is load-bearing rather than redundant.

## Limitations

- The card edits only `reasoningEfforts`, `input`, and `defaultInput`; the gateway import additionally writes each model's disclosed `name`, `contextWindow`, and `maxTokens` into the entry (showing the two capacities on the expanded row), but those capacities are not hand-editable here. Compat switches, edits to other model fields, and credentials stay with the shipped editor and `settings.yaml`.
- **Gateway import overwrites what you select.** For an existing model, every selected import replaces all five managed fields and clears any of them the gateway no longer discloses — that is the point of the overwrite, not a bug. Unselected rows and models the gateway does not return are never touched.
- Levels beyond the seven the schema accepts (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) are preserved on write but not offered for editing.
- Settings are stored in the user's `settings.yaml`; the card holds no state of its own.
- **Gateway import:** supports the `{"data":[…]}` and `{"models":{…}}` envelopes only, one listing page per attempt (no pagination), and only the `openai-completions`, `openai-responses`, and `anthropic-messages` protocols; anything else fails with a user-facing message.
- **Gateway import:** only the fields in the mapping table are translated. Magpie-only fields (service tiers, labels, pricing, `owned_by`, …) are ignored, and unsupported reasoning levels or modalities are skipped with warnings rather than approximated.
- **Gateway import:** in `modelOverrides` mode a gateway-only id cannot be imported (an override cannot introduce a catalog-unknown model); only already-shown ids are updated, and the status line counts the skipped new models.
- **Gateway import** never saves by itself and never writes settings from the Host route: the user confirms the selection, reviews the merged draft, and clicks 保存, after which the normal `configForms` transport validates it against the adapter.
- **models.dev completion is a best-effort reference, not a check of the gateway.** It only fills the five managed fields of an entry that lacks details; it never contradicts a disclosed value. A versionless family alias (`claude-haiku`, `gpt-sol`) can only be matched to the family's catalog record, which may be an older or newer member — treat that completion as a hint rather than proof of the exact variant. The same holds for a decorated id whose only extra token is a one-token local marker: it resolves to the base model, but only when no exact record exists. An id with no strong catalog match (`group/smart-split`, a longer invented suffix) is left untouched and listed in `unmatched`. Because models.dev can lag behind or disagree with a gateway (a gateway-specific context cap, a reseller variant), treat completed capacities as a starting point and correct them with the shipped editor if needed.
- **models.dev matching is deterministic but not omniscient.** Two providers' copies of the same model may disagree; the matcher prefers an exact catalog id, then the hinted/authoritative vendor (the prefix of `canonical_model_id`), then the more complete record, then lexicographic provider/model order. Reasoning completion maps only the effort/toggle shapes; `budget_tokens`-style thinking is ignored rather than approximated.
- **Decorated-id compatibility is heuristic.** A `cn:`/`xxx/` provider or category prefix is peeled, so `cn:kimi-k3` matches `kimi-k3`; a *trailing* local disambiguation marker (`-1`, `-b`, `-ctrl`, `-exp`) is peeled only as a last resort and only when the base model has a catalog record, so it can never override a normal match. Longer vendor suffixes (`-lkeap`, `-volc`, `-taiji`) are not guessed; the gateway's display name can sometimes resolve those instead, and otherwise the entry is left untouched. On the mapping side, `attachments`/`supports_images` are read as modality disclosures and `reasoning_supported_efforts` as effort levels; `reasoning_default_effort` is not expanded into a level list, and `supports_attachments` alone is not read as an image claim.
- The dialog grows to fit the model names but caps at 920 px (and at the viewport); an extraordinarily long id wraps onto additional lines instead of stretching the dialog further.
- The API key stays on the Host: it is resolved from `apiKeyEnv` through the credentials service, used for one request header, and never returned, logged, or shown in an error message.
