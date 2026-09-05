# 🔀 Auto Model Router v2

Global pi extension that automatically selects the most appropriate model for each task,
without manually switching models between prompts.

## Tier Taxonomy

| Tier            | Profile                             | Examples (default)                            |
|-----------------|-------------------------------------|-----------------------------------------------|
| `sota+`         | Frontier, deep reasoning            | claude-fable-5, claude-opus-4-8, gemini-3.1-pro-preview |
| `sota`          | Complex high-quality tasks          | claude-sonnet-5, gemini-3-pro-preview, gpt-5.5 |
| `workhorses+`   | Heavy engineering work              | claude-sonnet-4-6, gemini-2.5-pro, gpt-5.3-codex, glm-5p2 |
| `workhorses`    | General development and debugging  | claude-sonnet-4-5, gemini-3.5-flash, deepseek-v4-pro, kimi-k2p7-code |
| `lightweights+` | Medium low-cost tasks               | claude-haiku-4-5, gemini-3-flash-preview, gpt-5.4-mini |
| `lightweights`  | Trivial (chat, lists, one-liners)   | gemini-2.5-flash, gpt-5-mini, gpt-oss-20b |

Each tier is an **ordered list of candidates** `{provider, model}`. The extension
**permutates only over enabled providers** in the configuration: if a provider
is disabled, its models are discarded even if listed.

## Multi-component Scoring (Non-trivial)

The tier is NOT decided by prompt length. A weighted score 0..1 is calculated
from 6 independent signals:

| Signal        | Weight | What it measures                                                         |
|---------------|--------|--------------------------------------------------------------------------|
| `structure`   | 0.15   | Estimated size in tokens + attached images                               |
| `context`     | 0.18   | Session context pressure (`ctx.getContextUsage()`)                       |
| `code`        | 0.22   | Code density: ``` blocks, diffs, file paths, technical verbs             |
| `agentic`     | 0.15   | Agentic depth: active tools, skills, contextFiles, multi-step indicators |
| `criticality` | 0.20   | Risk: production, deploy, migration, security, money, data               |
| `output`      | 0.10   | Expected format: long report vs. single line                             |

Consistent floor/ceiling rules:
- **Criticality ≥ 0.7** → floor at `sota` (security overrides: a "quick" production change
  still deserves a serious model).
- **Explicit quick intent** (`quick`, `in one line`, `tl;dr`…) → ceiling at
  `workhorses` (do not waste SOTA on trivialities).
- The criticality floor **wins** over the quick intent ceiling.

## Selection Within Tiers

1. Candidates are filtered by **enabled providers**.
2. **Provider priority**: the effective priority of each provider is the one from the
   `tierProviderPriorities[tier]` map if it exists (per provider, falling back to
   the general priority for unlisted ones), or the general `priority` of `providers`
   if the tier does not have a specific map.
3. **Provider affinity** (tie-breaker): if the current model belongs to a provider
   in this tier, that candidate is preferred (provider continuity → better prompt caching).
   NOTE: if the tier has an explicit `tierProviderPriorities`, the specific priority
   takes precedence and affinity only acts as a tie-breaker.
4. **List order** as the final tie-breaker.

`pi.setModel()` fails silently if no API key is set → the next candidate is tried.
If none is usable, the current model is kept (nothing breaks).
Additionally, `pickModel` pre-filters by providers with configured auth
(`modelRegistry.getAvailable()`), so an enabled provider in config without a key
in the keychain never blocks routing.

## Usage — Where and how to use each control

> **Important:** The extension controls only exist if the extension is loaded.
> After installing or updating the extension, run **`/reload`** in your pi session
> (or restart pi) so it loads and `/auto-model` appears in the command autocomplete.

### 🖱️ Slash commands (typed in the normal pi input bar, with autocomplete)

| Command | Where/What it does |
|---|---|
| `/auto-model` | Status: ON/OFF, current model, last tier + scoring breakdown |
| `/auto-model on` | Enables automatic routing (this session only) |
| `/auto-model off` | Disables routing (this session only) — choose models manually |
| `/auto-model reload` | Reloads `~/.pi/agent/auto-model.json` from disk without restarting |
| `/auto-model config` | Shows active providers, effective tiers, and priorities per tier |
| `/auto-model score <text>` | Simulates scoring with sample text → tier + model (without sending anything) |
| `/auto-model debug` | Diagnostics of the last decision: router timing (scoring/select/setModel/total in ms), cold start yes/no, % context usage, signals (dominant marked with ←), config path |
| `/auto-model health` | Health status of providers; `/auto-model health clear` resets health tracking |
| `/auto-model usage` | Usage and cost dashboard (total/tier/top models + current session); `/auto-model usage clear` resets it |
| `/auto-model pin <provider/model>` | Manually pins a model (blocks the router until `/auto-model unpin`) |
| `/auto-model unpin` | Unpins the model and resumes automatic routing |
| `/model` | Native pi command: interactive selector to manually change the model |

### ⌨️ Prompt prefixes (typed at the very beginning of a NORMAL message, not with `/`)

| Prefix | Example | What it does |
|---|---|---|
| `!!` | `!! explain X` | Bypasses the router **for this turn** — pi uses the active model |
| `@@tier` | `@@sota design the architecture` | Forces a specific tier for this turn (`@@sota`, `@@workhorses+`, `@@lightweights`, …) |

These prefixes are processed in the extension's `input` event and stripped from the prompt before it is sent to the model.

### 🎛️ Other ways

| Way | What it does |
|---|---|
| `Ctrl+P` | Cycles models in the session (you can limit the cycle with `enabledModels` in settings.json) |
| `pi --model provider/model` | Initial model when launching pi |
| `~/.pi/agent/auto-model.json` → `"enabled"` | Persistent ON/OFF between sessions (loaded at every `session_start`) |

### 🔁 Switching between auto and manual

```
Auto ──(!! prompt)──────────► single manual turn
Auto ──(/auto-model off)────► manual indefinitely ──(/auto-model on)──► Auto
Auto ──(@@sota prompt)──────► single turn forced to that tier
Manual ──(enabled:true + /auto-model reload)──► Auto
```

**Note:** With the router ON, if you manually change the model (`/model` or `Ctrl+P`),
on the next prompt without `!!` the router will re-evaluate and might switch back.
To keep a manual model for several turns: `/auto-model off` → select model → finish work → `/auto-model on`.

Status is displayed in pi's status bar: **`🔀`** = active routing, **`⏸`** = paused.

Each routing notification includes the **dominant signal** — the one that contributed
the most weighted value to the score (`🚨 criticality`, `💻 code`, `🧮 context`, …):
`🔀 [sota] github-copilot/gpt-5.6-terra (score 0.66 · 🚨 criticality)`. This makes
the tier decision transparent.

The `/auto-model` command (without arguments) shows the timing of the last decision;
`/auto-model debug` adds the full detail. The router itself takes <1ms for scoring
and milliseconds for `setModel` — if you notice seconds of delay between the
`session_start` notification and the routing notification, it is pi's startup overhead
(resource discovery, system prompt preparation) on the first turn, not the router.

### 🩺 Provider Health (failover detection)

The router monitors provider errors during `message_end` and **degrades them with a cooldown**:
a failing provider is excluded from routing until its cooldown expires, recovery is automatic.
Classification of errors and cooldowns (configurable in `health.cooldownMs`):

| Category | Examples | Default Cooldown |
|---|---|---|
| `auth` | 401/403, invalid API key, service disabled | 1 hour |
| `rate-limit` | 429, quota exceeded, too many requests | 10 minutes |
| `server` | 502/503, overloaded | 2 minutes |
| `network` | timeout, ECONNREFUSED, fetch failed | 2 minutes |

**Context** errors (`context_length_exceeded`) do NOT degrade the provider (pi handles them with compaction).
The health state is persisted in `~/.pi/agent/auto-model-health.json` (survives restarts) and is shown in the `session_start` notification, `/auto-model`, and `/auto-model health`.

### 📊 Usage and Cost

Each assistant response logs actual tokens and cost (calculated by pi using catalog prices) in `~/.pi/agent/auto-model-usage.json`, aggregated per model. `/auto-model usage` shows:

- **Total** (all-time): cost, tokens, and calls.
- **Per tier**: how many calls and cost per level (`sota+`…`lightweights`).
- **Top models**: top 5 models by cost.
- **Current session**: stats for this pi session only.

`/auto-model usage clear` resets all usage counters.

### 💸 Budget Cap

Financial guardrail on usage data: when the **session** or **daily** cost exceeds the configured limit, routing is **capped at `capTier`** (the maximum capacity tier allowed). This is a hard guardrail: it also applies to tiers forced with `@@tier`.

```json
"budget": {
  "maxCostPerSession": 0.5,
  "maxCostPerDay": 2.0,
  "capTier": "workhorses"
}
```

Setting a limit to `0` disables it. The daily tracker is persisted in `~/.pi/agent/auto-model-budget.json`. When a threshold is exceeded, it notifies once (`💸 Session budget exceeded — capped at [workhorses]`) and status is reflected in `/auto-model usage`.

### 📌 Model Pinning

`/auto-model pin <provider/model>` locks a specific model and **bypasses the router** until `/auto-model unpin`: neither scoring, `@@tier`, nor budgets will switch the model while pinned (pinning has the absolute highest precedence). Useful for sessions where you want total manual control (e.g. debugging with a specific model). Pins are session-scoped (reset on pi restart) and the status bar displays `📌`.

**Precedence hierarchy**: `pin` (manual, overrides everything) → `budget` (financial guardrail) → `@@tier` (manual force) → automatic scoring.

### 🎯 Evaluation Harness (labeled corpus)

`eval-score.mjs` runs the static pipeline of the classifier (`classifyPrompt`, deterministic: no health/budget/hysteresis) over `eval-corpus.json` and reports **exact accuracy, ±1 band accuracy, precision/recall per tier, and confusion matrix**.

```
node --experimental-strip-types eval-score.mjs
```

The corpus has two sections:

- **`regression`**: current behavior considered correct → **CI gate** (non-zero exit if exact < `EVAL_ACCURACY_MIN` (0.9) or band < `EVAL_BAND_MIN` (0.95)).
- **`aspirational`**: cases where the classifier **under-scores** (heavy tasks with current weights) → reported as documented gaps without breaking CI — these are candidates for future calibration (#9).

CI (`auto-model-router.yml`) runs smoke + eval on every PR touching the extension, so any changes to weights/thresholds/regexes that alter decisions are caught (and aspirational gaps can be closed when calibration resolves them).

### 🧮 Calibration Loop (implicit feedback)

Every correction you make is a calibration signal, logged in `~/.pi/agent/auto-model-calibration.jsonl` (JSONL, last 1000 lines):

- Forced **`@@tier`** → `override`: the natural tier the router would have chosen vs. the one you requested, with score and dominant signal.
- **`!!`** → `bypass`: the prompt where you bypassed the router (and its natural tier).

`/auto-model calibrate` analyzes these signals and **suggests** adjustments (without applying them):

- Under-scores (you requested higher capacity than routed) and over-scores per dominant signal.
- **Weight deltas** per signal (`code: 0.25 → 0.28`): more under-scores than over-scores in a signal → increase its weight (Δ ±0.01 per sample, capped at ±0.06).
- **Boundary hints**: if you forced `sota` with scores way below the threshold (0.66), the sota threshold might be too high.

Example:
```
🧮 Calibration — 12 signals (9 overrides · 3 bypass)
  Under-scores: 6 · Over-scores: 3
  💻 code: ↓5 ↑1 → suggests +0.04
  🚨 criticality: ↓1 ↑2 → suggests -0.01
  ⚠️ 4 forced upgrades to sota (mean score 0.44) — sota threshold (0.66) might be too high
```

Apply the deltas by copying them to `scoring.weights` in your `auto-model.json` (or project `.pi/` config) and validate with the evaluation harness (`eval-score.mjs`) — changes that break regression are caught in CI. `/auto-model calibrate clear` resets the calibration logs.

### 🧲 Anti-Flip-Flop Hysteresis

Prevents the router from oscillating between tiers on consecutive turns (e.g. tough prompt → sota, trivial prompt → lightweights, back to sota…): to **downgrade** a tier, the current tier must have been held for at least `hysteresis.minDowngradeTurns` routed turns; **upgrades are always immediate** (tough tasks deserve the strong model right away). When a downgrade is blocked, the notification indicates it (`🧲 hysteresis (downgrade blocked 1/2)`). `0` disables it; the current anchor is shown in `/auto-model debug`.

### 🚑 Mid-Turn Rescue (failover)

If the selected model fails with a recoverable error (auth/429/5xx/timeout/model not available), the router **degrades the provider** (health) and **retries the exact same prompt with the next candidate in the tier** (healthy and enabled). Max 2 rescues per actual user prompt; the retry won't hit the failed model again because it is now degraded. Context errors (`context_length_exceeded`) do NOT trigger a rescue (pi resolves them with compaction). Does not apply when `pin` is active or during `!!` turns. The rescue count is shown in `/auto-model debug`.

### 🗂️ Project-level Config

In addition to the global config (`~/.pi/agent/auto-model.json`), each project can have its own config in **`.pi/auto-model.json`** (loaded only in trusted projects). The effective configuration is:

```
embedded defaults → global (~/.pi/agent) → project (./.pi)
```

The merge is deep per key: the project only overrides what it defines, falling back to global and defaults for everything else. Useful for your multi-repo ecosystem — a conservative domain can pin specific providers/tiers without touching the global config. `/auto-model config` displays both paths and whether the project config is active.

## Configuration

`~/.pi/agent/auto-model.json` (optional). See `config.example.json` in this directory. The configuration is reloaded on `session_start` and via `/auto-model reload`.

```json
{
  "enabled": true,
  "providers": {
    "anthropic": { "enabled": true, "priority": 1 },
    "google": { "enabled": true, "priority": 2 }
  },
  "tiers": {
    "sota+": [
      { "provider": "anthropic", "model": "claude-fable-5", "thinking": "max" },
      { "provider": "google", "model": "gemini-3.1-pro-preview", "thinking": "xhigh" }
    ]
  },
  "tierProviderPriorities": {
    "sota+": { "anthropic": 1, "google": 2 }
  }
}
```
