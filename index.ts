/**
 * Auto Model Router v2 — global pi extension
 * ==========================================
 *
 * Automatically selects the most appropriate model for each task,
 * based on a taxonomy of 6 levels (tiers):
 *
 *     sota+ / sota / workhorses+ / workhorses / lightweights+ / lightweights
 *
 * Each tier defines A LIST of {provider, model} candidates, and providers
 * can be enabled/disabled in the configuration. If a provider is disabled,
 * its models are excluded from the permutation (for example: SOTA has
 * claude-fable-5 (anthropic) and gemini-3.1-pro-preview (google), but if
 * anthropic is disabled, gemini-3.1-pro-preview will be used).
 *
 * The tier selection is NOT trivial (it is not based only on prompt
 * length): it computes a multicomponent complexity score:
 *
 *   - structure  : estimated size in tokens + attached images
 *   - context    : session context pressure (getContextUsage)
 *   - code       : code density (``` blocks, diffs, paths, verbs)
 *   - agentic    : agentic depth (active tools, skills, contextFiles,
 *                  multi-step indicators in the prompt)
 *   - criticality: risk (production, deploy, migration, security, money…)
 *   - output     : expected output format (long report vs. one line)
 *
 * Weights and thresholds are configurable (~/.pi/agent/auto-model.json).
 *
 * Usage:
 *   - Automatic on every prompt (if "enabled": true).
 *   - Prefix "!!"        → skips the router for this turn.
 *   - Prefix "@@tier" (e.g. "@@sota do X") → forces a specific level.
 *   - /auto-model                 → status + last scoring breakdown
 *   - /auto-model on|off          → toggle
 *   - /auto-model reload          → reloads the configuration
 *   - /auto-model config          → shows the configuration path
 *   - /auto-model score <text>    → simulates scoring without sending anything
 *
 * Configuration: ~/.pi/agent/auto-model.json (optional; if missing, uses the
 * embedded defaults). See config.example.json in this directory.
 */

import type {
  BeforeAgentStartEvent,
  ContextUsage,
  ExtensionAPI,
  InputEvent,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** True when this extension is running inside an explicitly launched subagent. */
export function isSubagentProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_SUBAGENT_CHILD === "1" || env.PI_SUBAGENT_CHILD === "true" || !!env.PI_SUBAGENT_CHILD_AGENT;
}

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

export type TierId =
  | "sota+"
  | "sota"
  | "workhorses+"
  | "workhorses"
  | "lightweights+"
  | "lightweights";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ModelEntry {
  provider: string;
  model: string;
  /** Optional thinking level when selecting this model. */
  thinking?: ThinkingLevel;
}

export interface ProviderConfig {
  enabled: boolean;
  /** Lower = preferred within the tier (ties broken by provider affinity). */
  priority?: number;
}

export interface AutoModelConfig {
  enabled: boolean;
  providers: Record<string, ProviderConfig>;
  tiers: Record<TierId, ModelEntry[]>;
  /**
   * Per-tier provider priorities. They override the general `providers`
   * priority ONLY for that tier; providers not listed in a tier's map use
   * their general priority. Empty → everything uses the general one.
   */
  tierProviderPriorities: Partial<Record<TierId, Record<string, number>>>;
  /** Provider health: cooldowns per error category. */
  health: {
    cooldownMs: Record<HealthReason, number>;
  };
  /**
   * Budget: cost limits with a tier cap. 0 = disabled.
   * When the session or day cost exceeds the limit, routing is capped at
   * `capTier` (the maximum allowed capability level) — it also applies to
   * tiers forced with @@tier (hard guardrail).
   */
  budget: {
    maxCostPerSession: number;
    maxCostPerDay: number;
    capTier: TierId;
  };
  /**
   * Anti-flip-flop hysteresis: to DOWNGRADE a tier, the current tier must
   * have been held for at least `minDowngradeTurns` routed turns. Upgrades
   * are always immediate. 0 = disabled.
   */
  hysteresis: {
    minDowngradeTurns: number;
  };
  scoring: {
    weights: Record<SignalKey, number>;
    thresholds: Record<TierId, number>;
  };
}

export type HealthReason = "auth" | "rate-limit" | "server" | "network";

export interface ProviderHealth {
  /** Epoch ms until which the provider is degraded. */
  degradedUntil: number;
  reason: HealthReason;
  lastError: string;
  hits: number;
}

export type HealthMap = Record<string, ProviderHealth>;

type SignalKey =
  | "structure"
  | "context"
  | "code"
  | "agentic"
  | "criticality"
  | "output";

// ---------------------------------------------------------------------------
// Embedded defaults (overridable via ~/.pi/agent/auto-model.json)
// ---------------------------------------------------------------------------

const TIER_ORDER: TierId[] = [
  "sota+",
  "sota",
  "workhorses+",
  "workhorses",
  "lightweights+",
  "lightweights",
];

const DEFAULT_CONFIG: AutoModelConfig = {
  enabled: true,
  providers: {
    "github-copilot": { enabled: true, priority: 1 },
    deepseek: { enabled: true, priority: 2 },
    google: { enabled: true, priority: 3 },
    anthropic: { enabled: true, priority: 4 },
  },
  tiers: {
    "sota+": [
      { provider: "github-copilot", model: "gpt-5.6-sol", thinking: "max" },
      { provider: "anthropic", model: "claude-fable-5", thinking: "max" },
      { provider: "google", model: "gemini-3.1-pro-preview", thinking: "xhigh" },
      { provider: "deepseek", model: "deepseek-v4-pro", thinking: "high" },
    ],
    sota: [
      { provider: "github-copilot", model: "gpt-5.6-terra", thinking: "high" },
      { provider: "anthropic", model: "claude-opus-4-8", thinking: "high" },
      { provider: "google", model: "gemini-3-pro-preview", thinking: "high" },
      { provider: "deepseek", model: "deepseek-v4-pro", thinking: "high" },
    ],
    "workhorses+": [
      { provider: "github-copilot", model: "gpt-5.3-codex", thinking: "medium" },
      { provider: "deepseek", model: "deepseek-v4-pro", thinking: "high" },
      { provider: "google", model: "gemini-3.5-flash", thinking: "medium" },
      { provider: "anthropic", model: "claude-sonnet-4-6", thinking: "high" },
    ],
    workhorses: [
      { provider: "github-copilot", model: "gpt-5.6-luna", thinking: "medium" },
      { provider: "deepseek", model: "deepseek-v4-flash", thinking: "low" },
      { provider: "google", model: "gemini-3-flash-preview", thinking: "medium" },
      { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "medium" },
    ],
    "lightweights+": [
      { provider: "github-copilot", model: "gpt-5-mini", thinking: "low" },
      { provider: "deepseek", model: "deepseek-v4-flash", thinking: "low" },
      { provider: "google", model: "gemini-2.5-pro", thinking: "low" },
      { provider: "anthropic", model: "claude-haiku-4-5", thinking: "medium" },
    ],
    lightweights: [
      { provider: "github-copilot", model: "claude-haiku-4.5", thinking: "low" },
      { provider: "deepseek", model: "deepseek-v4-flash", thinking: "low" },
      { provider: "google", model: "gemini-2.5-flash", thinking: "low" },
      { provider: "anthropic", model: "claude-haiku-4-5", thinking: "low" },
    ],
  },
  scoring: {
    weights: {
      structure: 0.12,
      context: 0.18,
      code: 0.25,
      agentic: 0.15,
      criticality: 0.2,
      output: 0.1,
    },
    thresholds: {
      "sota+": 0.82,
      sota: 0.66,
      "workhorses+": 0.5,
      workhorses: 0.36,
      "lightweights+": 0.2,
      lightweights: 0,
    },
  },
  tierProviderPriorities: {
    "sota+": { "github-copilot": 1, anthropic: 2, google: 3, deepseek: 4 },
    sota: { "github-copilot": 1, anthropic: 2, google: 3, deepseek: 4 },
  },
  health: {
    cooldownMs: {
      auth: 3_600_000,
      "rate-limit": 600_000,
      server: 120_000,
      network: 120_000,
    },
  },
  budget: {
    maxCostPerSession: 0,
    maxCostPerDay: 0,
    capTier: "workhorses",
  },
  hysteresis: {
    minDowngradeTurns: 2,
  },
};

// ---------------------------------------------------------------------------
// Configuration loading (deep merge over defaults)
// ---------------------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".pi", "agent", "auto-model.json");
const HEALTH_FILE = join(homedir(), ".pi", "agent", "auto-model-health.json");
const USAGE_FILE = join(homedir(), ".pi", "agent", "auto-model-usage.json");
const BUDGET_FILE = join(homedir(), ".pi", "agent", "auto-model-budget.json");
const CALIB_LOG = join(homedir(), ".pi", "agent", "auto-model-calibration.jsonl");

function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) {
    return (override === undefined ? base : override) as T;
  }
  if (typeof base === "object" && typeof override === "object") {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const key of Object.keys(override as Record<string, unknown>)) {
      const bv = (base as Record<string, unknown>)[key];
      const ov = (override as Record<string, unknown>)[key];
      out[key] = deepMerge(bv, ov);
    }
    return out as T;
  }
  return override as T;
}

/**
 * Effective config for a project: embedded defaults → global file
 * (~/.pi/agent/auto-model.json) → project file (./.pi/auto-model.json).
 * The project is only applied when cwd is passed (trusted project).
 */
export function mergeConfigs(globalObj: unknown, projectObj?: unknown): AutoModelConfig {
  let cfg = deepMerge(DEFAULT_CONFIG, globalObj);
  if (projectObj !== undefined) {
    cfg = deepMerge(cfg, projectObj);
  }
  return cfg;
}

function loadConfig(cwd?: string): AutoModelConfig {
  let global: unknown = undefined;
  let project: unknown = undefined;
  try {
    if (existsSync(CONFIG_PATH)) {
      global = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch (err) {
    console.error(`[auto-model-router] error reading ${CONFIG_PATH}:`, err);
  }
  if (cwd) {
    const projectPath = join(cwd, ".pi", "auto-model.json");
    try {
      if (existsSync(projectPath)) {
        project = JSON.parse(readFileSync(projectPath, "utf-8"));
      }
    } catch (err) {
      console.error(`[auto-model-router] error reading ${projectPath}:`, err);
    }
  }
  return mergeConfigs(global, project);
}

// ---------------------------------------------------------------------------
// Multicomponent scoring (each signal → [0,1])
// ---------------------------------------------------------------------------

function tokenEstimate(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/** 1) Structure: prompt size + attached images. */
function scoreStructure(prompt: string, imageCount: number): number {
  const tokens = tokenEstimate(prompt);
  let s: number;
  if (tokens < 30) s = 0.05;
  else if (tokens < 80) s = 0.2;
  else if (tokens < 200) s = 0.45;
  else if (tokens < 500) s = 0.7;
  else s = 0.9;
  if (imageCount > 0) s = Math.min(1, s + 0.15 + 0.05 * (imageCount - 1));
  return s;
}

/** 2) Context: session context pressure. */
function scoreContext(usage: ContextUsage | undefined): number {
  if (!usage || usage.percent === null) return 0.3; // unknown → mild
  const p = usage.percent;
  if (p < 0.2) return 0.1;
  if (p < 0.4) return 0.3;
  if (p < 0.6) return 0.55;
  if (p < 0.8) return 0.75;
  return 0.95;
}

/** 3) Code: density of engineering tasks. */
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const DIFF_RE = /(^|\n)(diff --git|--- |\+\+\+ |@@ )/;
const FILE_PATH_RE =
  /(?<![\w])([\w./*-]+?\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|c|h|cpp|hpp|sh|bash|zsh|tf|yaml|yml|json|toml|ini|md|sql|css|html|vue|svelte|graphql|proto|mod|sum))(?:\:\d+)?(?![\w])/i;
const CODE_VERBS_RE =
  /\b(implement|implementa|build|construye|develop|desarrolla|refactor|refactoriza|debug|depura|fix|arregla|optimize|optimiza|write (a |the )?(function|class|module|api|test)|escribe (una |un )?(función|clase|api|módulo|test)|endpoint|handler|microservicio|test|prueba|migrate|migra|deploy|despliega|configure|configura|scaffold|generate|genera|parse|parsea|handle|maneja el error)\b/i;

function scoreCode(prompt: string): number {
  const codeBlocks = (prompt.match(CODE_BLOCK_RE) || []).length;
  const blockSig = Math.min(1, codeBlocks / 3) * 0.4;
  const fileSig = DIFF_RE.test(prompt) ? 0.25 : FILE_PATH_RE.test(prompt) ? 0.15 : 0;
  const verbSig = CODE_VERBS_RE.test(prompt) ? 0.35 : 0;
  return Math.min(1, blockSig + fileSig + verbSig);
}

/** 4) Agentic: depth of the agentic task. */
const MULTISTEP_RE =
  /(paso\s*\d|step\s*\d|primero.{0,60}(luego|despu[eé]s|entonces)|investiga.{0,80}(y\s|luego)|busca.{0,80}(y\s|luego)|lee.{0,80}(y\s|luego)|explora.{0,80}(y\s|luego)|y\s+luego|entonces|despu[eé]s\s+de|en paralelo|a la vez|s[íi]ncelo|coordina|encadena|multi[ -]paso|por fases|fase 1|fase 2|end-to-end|varios (archivos|ficheros|servicios)|m[úu]ltiples (archivos|ficheros|servicios|m[óo]dulos|componentes)|todos los (archivos|ficheros|servicios))/i;
const BIG_SCOPE_RE = /\b(de cero|from scratch|completo|completa|plataforma|sistema entero|end-to-end|microservicio)\b/i;
const LIST_RE = /(?:\n|^)\s*(?:[-*]|\d+[.)])\s+/g;

function scoreAgentic(
  prompt: string,
  selectedTools: string[] | undefined,
  skillsCount: number,
  contextFilesCount: number,
): number {
  let s = 0;
  const toolCount = selectedTools?.length ?? 4;
  if (toolCount >= 8) s += 0.35;
  else if (toolCount >= 6) s += 0.2;
  else if (toolCount >= 5) s += 0.1;

  if (skillsCount >= 5) s += 0.2;
  else if (skillsCount >= 2) s += 0.1;

  if (contextFilesCount >= 3) s += 0.15;
  else if (contextFilesCount >= 1) s += 0.05;

  if (MULTISTEP_RE.test(prompt)) s += 0.3;
  if (BIG_SCOPE_RE.test(prompt)) s += 0.15;
  const listItems = (prompt.match(LIST_RE) || []).length;
  if (listItems >= 3) s += 0.15;
  else if (listItems >= 1) s += 0.05;

  return Math.min(1, s);
}

/** 5) Criticality: operational or data risk. */
const CRITICAL_RE =
  /\b(produ[cct]ion|prod\b|deploy|release|rollback|migraci[oó]n|migration|breaking|irreversible|seguridad|security|vulnerabil|exploit|datos sensibles|sensitive data|pii|customer data|datos de clientes|financiero|financial|dinero|money|factura|invoice|contrato|contract|compliance|audit(?:or[ií]a)?|drop table|truncate|rm -rf|borra (la )?(base|tabla|datos)|elimina (la )?(base|tabla|datos)|sin copia de seguridad|no backup)\b/i;

function scoreCriticality(prompt: string): number {
  const matches = (prompt.match(CRITICAL_RE) || []).length;
  return Math.min(1, matches * 0.35);
}

/** 6) Output: expected response format. */
const LONG_OUTPUT_RE =
  /\b(documenta|document this|informe|report|tutorial|gu[ií]a completa|explain in detail|explica en detalle|detallado|plan detallado|dise[ñn]o completo|write (a |the |un )?(full|complete|detailed)|escribe (un |una |el |la )?(informe|documento|tutorial|manual)|describe el proceso completo|arquitectura completa|rfc|adr|proposal|propuesta formal)\b/i;
const SHORT_OUTPUT_RE =
  /\b(resume|resumen|en una l[ií]nea|in one line|tl;dr|tldr|r[aá]pido|quick|breve|short|una frase|one sentence|lista r[aá]pida|quick list|sin rodeos|directo|just tell me|solo dime)\b/i;

function scoreOutput(prompt: string): number {
  if (SHORT_OUTPUT_RE.test(prompt)) return 0.1;
  if (LONG_OUTPUT_RE.test(prompt)) return 0.75;
  return 0.4;
}

// ---------------------------------------------------------------------------
// Provider health (dead-provider detection)
// ---------------------------------------------------------------------------

const HEALTH_PATTERNS: Array<[HealthReason, RegExp]> = [
  ["auth", /\b(api[ _-]?key|unauthorized|authentication|permission|forbidden|401|403|404|service_disabled|is disabled|not been used|invalid (?:api )?key|no longer available|model .{0,30}not found|does not exist)\b/i],
  ["rate-limit", /\b(429|rate limit|too many requests|quota|throttl|exceeded (?:monthly|daily|max)|usage limit)\b/i],
  ["server", /\b(5\d\d|502|503|overloaded|internal server|temporarily (?:unavailable|down)|backend)\b/i],
  ["network", /\b(timeout|timed out|ECONN|socket hang|network|fetch failed|ETIMEDOUT|ECONNREFUSED|ENOTFOUND)\b/i],
];
const CONTEXT_OVERFLOW_RE =
  /context_length_exceeded|maximum context|context window|token limit|too many tokens/i;

/**
 * Classifies an error message into a provider health category.
 * Returns null if the error is NOT the provider's fault (e.g. context
 * overflow, which pi handles through compaction).
 */
function classifyError(errorMessage: string): HealthReason | null {
  if (!errorMessage) return null;
  if (CONTEXT_OVERFLOW_RE.test(errorMessage)) return null;
  for (const [reason, re] of HEALTH_PATTERNS) {
    if (re.test(errorMessage)) return reason;
  }
  return null;
}

function cooldownMsFor(cfg: AutoModelConfig, reason: HealthReason): number {
  return cfg.health.cooldownMs[reason] ?? 120_000;
}

/**
 * Maps an HTTP status to a provider health reason. Returns null for statuses
 * that are not a retryable provider outage (e.g. 200, 400 client mistakes).
 */
function httpStatusReason(status: number | undefined): HealthReason | null {
  if (status === undefined) return null;
  if (status === 429) return "rate-limit";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500 && status <= 599) return "server";
  return null;
}

function isProviderHealthy(health: HealthMap, provider: string, now = Date.now()): boolean {
  const h = health[provider];
  return !h || h.degradedUntil <= now;
}

// ---------------------------------------------------------------------------
// Usage and cost (dashboard)
// ---------------------------------------------------------------------------

export interface ModelUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

export type UsageMap = Record<string, ModelUsage>;

export function usageKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function aggregateUsage(
  acc: UsageMap,
  provider: string,
  model: string,
  u: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: number;
  },
): UsageMap {
  const key = usageKey(provider, model);
  const prev = acc[key] ?? {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
  acc[key] = {
    calls: prev.calls + 1,
    inputTokens: prev.inputTokens + (u.input ?? 0),
    outputTokens: prev.outputTokens + (u.output ?? 0),
    cacheReadTokens: prev.cacheReadTokens + (u.cacheRead ?? 0),
    cacheWriteTokens: prev.cacheWriteTokens + (u.cacheWrite ?? 0),
    totalTokens: prev.totalTokens + (u.totalTokens ?? 0),
    cost: prev.cost + (u.cost ?? 0),
  };
  return acc;
}

/** Tier a model belongs to (first match from highest to lowest). */
export function tierForModel(
  cfg: AutoModelConfig,
  provider: string,
  model: string,
): TierId | "unknown" {
  for (const id of TIER_ORDER) {
    if ((cfg.tiers[id] || []).some((e) => e.provider === provider && e.model === model)) return id;
  }
  return "unknown";
}

/**
 * Parses a "provider/model" spec for the pin. Returns null if it does
 * not have the expected shape.
 */
export function parsePinSpec(spec: string): { provider: string; model: string } | null {
  const s = spec.trim();
  const slash = s.indexOf("/");
  if (slash <= 0 || slash >= s.length - 1) return null;
  const provider = s.slice(0, slash).trim();
  const model = s.slice(slash + 1).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

/**
 * Next rescue candidate after a failure: the first model of the tier after the
 * failed one that is enabled and healthy. The WHOLE failed provider is skipped
 * (plus any extra providers in `skipProviders`), so when a provider-wide quota
 * exhaustion or outage brings down several of its models, the router moves on to
 * a genuinely different provider instead of retrying the same dead provider.
 * Returns undefined when no usable candidate remains.
 */
export function nextRescueCandidate(
  candidates: ModelEntry[],
  failedKey: string,
  isHealthy: (provider: string) => boolean,
  isEnabled: (provider: string) => boolean,
  skipProviders: string[] = [],
): ModelEntry | undefined {
  const skip = new Set(skipProviders);
  const idx = candidates.findIndex((e) => usageKey(e.provider, e.model) === failedKey);
  if (idx === -1) return undefined;
  return candidates
    .slice(idx + 1)
    .find((e) => isEnabled(e.provider) && isHealthy(e.provider) && !skip.has(e.provider));
}

/**
 * Hysteresis: decides whether a tier DOWNGRADE is allowed or blocked.
 * - No active tier, upgrade, or same tier → no change (blocked=false).
 * - Downgrade with stable turns >= min → allowed (returns the natural tier).
 * - Downgrade with turns < min → blocked (returns the active tier).
 * force ignores hysteresis (handled in the handler by passing min=0 or by
 * the handler itself avoiding the call on the forced path).
 */
export function hysteresisTier(
  tier: TierId,
  activeTier: TierId | null,
  activeTierTurns: number,
  minDowngradeTurns: number,
): { tier: TierId; blocked: boolean } {
  if (!activeTier || minDowngradeTurns <= 0) return { tier, blocked: false };
  const natIdx = TIER_ORDER.indexOf(tier);
  const actIdx = TIER_ORDER.indexOf(activeTier);
  if (natIdx <= actIdx) return { tier, blocked: false }; // same capability or upgrade
  if (activeTierTurns < minDowngradeTurns) {
    return { tier: activeTier, blocked: true }; // downgrade blocked → keep
  }
  return { tier, blocked: false }; // downgrade allowed
}

/**
 * Calibration sample: implicit user signal about the decision.
 * - override: the user forced a @@tier different from the router's natural one.
 * - bypass: the user used !! and skipped routing on that prompt.
 */
export interface CalibrationSample {
  ts: number;
  kind: "override" | "bypass";
  /** The natural tier the router would have decided. */
  routerTier: TierId;
  /** override: the tier forced with @@tier. */
  forcedTier?: TierId;
  score: number;
  dominant: SignalKey;
  excerpt: string;
}

export interface WeightSuggestion {
  signal: SignalKey;
  from: number;
  to: number;
  delta: number;
}

export interface CalibrationReport {
  total: number;
  overrides: number;
  bypasses: number;
  /** User asked for MORE capability than the router (router undershoot). */
  under: number;
  /** User asked for LESS capability than the router (overshoot). */
  over: number;
  perSignal: Record<SignalKey, { under: number; over: number }>;
  weightSuggestions: WeightSuggestion[];
  boundaryHints: string[];
}

const WEIGHT_DELTA_PER_SAMPLE = 0.01;
const MAX_WEIGHT_DELTA = 0.06;

/**
 * Analyzes the user's corrections and suggests per-signal weight deltas
 * (more undershoots than overshoots on a signal → raise its weight, and
 * vice versa). Pure and deterministic; does not mutate the configuration.
 */
export function analyzeCalibration(
  samples: CalibrationSample[],
  cfg: AutoModelConfig,
): CalibrationReport {
  const bypasses = samples.filter((s) => s.kind === "bypass").length;
  const idxOf = (t: TierId) => TIER_ORDER.indexOf(t);
  const overrides = samples.filter(
    (s) =>
      s.kind === "override" &&
      s.routerTier &&
      s.forcedTier &&
      idxOf(s.forcedTier) !== idxOf(s.routerTier),
  );

  const perSignal: Record<SignalKey, { under: number; over: number }> = {
    structure: { under: 0, over: 0 },
    context: { under: 0, over: 0 },
    code: { under: 0, over: 0 },
    agentic: { under: 0, over: 0 },
    criticality: { under: 0, over: 0 },
    output: { under: 0, over: 0 },
  };
  let under = 0;
  let over = 0;
  const upCross: Record<string, number[]> = {};

  for (const s of overrides) {
    const d = idxOf(s.forcedTier!) - idxOf(s.routerTier);
    if (d === 0) continue;
    if (d < 0) {
      under++;
      perSignal[s.dominant].under++;
      const cross = `${s.forcedTier}:${s.routerTier}`;
      (upCross[cross] ??= []).push(s.score);
    } else {
      over++;
      perSignal[s.dominant].over++;
    }
  }

  const weightSuggestions: WeightSuggestion[] = [];
  for (const k of Object.keys(perSignal) as SignalKey[]) {
    const net = perSignal[k].under - perSignal[k].over;
    if (net === 0) continue;
    const delta = Math.max(
      -MAX_WEIGHT_DELTA,
      Math.min(MAX_WEIGHT_DELTA, net * WEIGHT_DELTA_PER_SAMPLE),
    );
    weightSuggestions.push({
      signal: k,
      from: cfg.scoring.weights[k],
      to: +(cfg.scoring.weights[k] + delta).toFixed(3),
      delta: +delta.toFixed(3),
    });
  }

  const boundaryHints: string[] = [];
  for (const [cross, scores] of Object.entries(upCross)) {
    const [target] = cross.split(":");
    const sorted = [...scores].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const thr = cfg.scoring.thresholds[target as TierId];
    if (med < thr) {
      boundaryHints.push(
        `${scores.length} forced upgrade(s) to ${target} from a lower tier (mean score ${med.toFixed(2)}) — the ${target} threshold (${thr}) may be high; also review the dominant signal weight.`,
      );
    }
  }

  return {
    total: samples.length,
    overrides: overrides.length,
    bypasses,
    under,
    over,
    perSignal,
    weightSuggestions,
    boundaryHints,
  };
}

export interface BudgetClamp {
  tier: TierId;
  /** true if the budget is exceeded (regardless of whether there was a clamp). */
  over: boolean;
  /** true if the tier was lowered by the cap. */
  clamped: boolean;
  reason: "session" | "day" | null;
}

/**
 * Applies the budget cap: if the session or day cost exceeds the limit,
 * the tier is capped at `capTier`. 0 in the limits = disabled. The cap is
 * a hard guardrail: it can downgrade even forced tiers.
 */
export function clampTierToBudget(
  tier: TierId,
  cfg: AutoModelConfig,
  sessionCost: number,
  dayCost: number,
): BudgetClamp {
  const b = cfg.budget;
  const overSession = b.maxCostPerSession > 0 && sessionCost >= b.maxCostPerSession;
  const overDay = b.maxCostPerDay > 0 && dayCost >= b.maxCostPerDay;
  if (!overSession && !overDay) {
    return { tier, over: false, clamped: false, reason: null };
  }
  const capIdx = TIER_ORDER.indexOf(b.capTier);
  const idx = TIER_ORDER.indexOf(tier);
  const clampedTier = idx < capIdx ? b.capTier : tier;
  return {
    tier: clampedTier,
    over: true,
    clamped: clampedTier !== tier,
    reason: overSession ? "session" : "day",
  };
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

export interface ScoreSignals {
  structure: number;
  context: number;
  code: number;
  agentic: number;
  criticality: number;
  output: number;
}

function computeSignals(
  prompt: string,
  imageCount: number,
  usage: ContextUsage | undefined,
  selectedTools: string[] | undefined,
  skillsCount: number,
  contextFilesCount: number,
): ScoreSignals {
  return {
    structure: scoreStructure(prompt, imageCount),
    context: scoreContext(usage),
    code: scoreCode(prompt),
    agentic: scoreAgentic(prompt, selectedTools, skillsCount, contextFilesCount),
    criticality: scoreCriticality(prompt),
    output: scoreOutput(prompt),
  };
}

function weightedScore(signals: ScoreSignals, weights: AutoModelConfig["scoring"]["weights"]): number {
  return (
    weights.structure * signals.structure +
    weights.context * signals.context +
    weights.code * signals.code +
    weights.agentic * signals.agentic +
    weights.criticality * signals.criticality +
    weights.output * signals.output
  );
}

const SIGNAL_ICONS: Record<SignalKey, string> = {
  structure: "📏",
  context: "🧮",
  code: "💻",
  agentic: "🤖",
  criticality: "🚨",
  output: "📝",
};

/**
 * Dominant signal: the one contributing the most weighted contribution
 * to the score (weight × value). It explains the tier decision.
 */
function dominantSignal(
  signals: ScoreSignals,
  weights: AutoModelConfig["scoring"]["weights"],
): SignalKey {
  let best: SignalKey = "structure";
  let bestVal = -1;
  for (const k of Object.keys(signals) as SignalKey[]) {
    const contrib = weights[k] * signals[k];
    if (contrib > bestVal) {
      bestVal = contrib;
      best = k;
    }
  }
  return best;
}

/**
 * Static classifier pipeline (deterministic, for eval/calibration):
 * signals → score → tier (with quickIntent and without session state such as
 * health, budget or hysteresis). This is what the evaluation harness tests.
 */
export function classifyPrompt(
  prompt: string,
  cfg: AutoModelConfig = DEFAULT_CONFIG,
  usage?: ContextUsage,
  tools?: string[],
  skillsCount = 0,
  contextFilesCount = 0,
): { tier: TierId; score: number; signals: ScoreSignals; dominant: SignalKey } {
  const signals = computeSignals(prompt, 0, usage, tools, skillsCount, contextFilesCount);
  const score = weightedScore(signals, cfg.scoring.weights);
  const quickIntent = SHORT_OUTPUT_RE.test(prompt);
  const tier = resolveTier(score, signals, quickIntent, cfg.scoring.thresholds);
  return { tier, score, signals, dominant: dominantSignal(signals, cfg.scoring.weights) };
}

/**
 * Score → tier map. Applies consistent floor/ceiling rules:
 *  - high criticality (>=0.7) imposes a floor at sota (safety comes first).
 *  - explicit fast intent (SHORT_OUTPUT_RE) imposes a ceiling at
 *    workhorses (do not waste SOTA on "summarize this in one line").
 *  - The criticality floor beats the fast ceiling (a "quick" prod change
 *    still deserves a serious model).
 */
/**
 * Score → tier map. Applies consistent floor/ceiling rules:
 *  - high criticality (>=0.7) imposes a CAPABILITY floor at sota (safety
 *    first: a "quick" prod change still deserves a serious model).
 *  - explicit fast intent (SHORT_OUTPUT_RE) imposes a CAPABILITY ceiling at
 *    workhorses (do not waste SOTA on trivialities).
 *
 * NOTE: TIER_ORDER goes from highest to lowest capability (sota+ →
 * lightweights), so the capability ceiling = MINIMUM index and the
 * capability floor = MAXIMUM index.
 */
function resolveTier(
  score: number,
  signals: ScoreSignals,
  quickIntent: boolean,
  thresholds: AutoModelConfig["scoring"]["thresholds"],
): TierId {
  // Indices in TIER_ORDER space (0 = sota+, 5 = lightweights)
  let minCapabilityIdx = 0; // capability ceiling (never more capable than this)
  let maxCapabilityIdx = TIER_ORDER.length - 1; // capability floor

  if (signals.criticality >= 0.7) {
    // Floor: never below sota → max index 1
    maxCapabilityIdx = TIER_ORDER.indexOf("sota");
  } else if (quickIntent) {
    // Ceiling: never above workhorses → min index 3
    minCapabilityIdx = TIER_ORDER.indexOf("workhorses");
  }

  let tier: TierId = "lightweights";
  for (const id of TIER_ORDER) {
    if (score >= thresholds[id]) {
      tier = id;
      break;
    }
  }

  const tierIdx = TIER_ORDER.indexOf(tier);
  const clamped = Math.min(Math.max(tierIdx, minCapabilityIdx), maxCapabilityIdx);
  return TIER_ORDER[clamped];
}

// ---------------------------------------------------------------------------
// Model selection within the tier (permutation over active providers)
// ---------------------------------------------------------------------------

interface PickResult {
  model: Model<any> | null;
  entry?: ModelEntry;
  reason: string;
}

/**
 * Ordered candidates of a tier: enabled providers → affinity with the
 * current provider → provider priority → list order.
 */
/**
 * Is there conversation history (at least one completed assistant turn)?
 * On the first prompt of a session there is no continuity to preserve, so
 * provider affinity is skipped and pure priorities win (cold start). From
 * the second turn onward, affinity applies again.
 */
function hasAssistantHistory(sm: { getEntries(): unknown[] } | undefined): boolean {
  try {
    const entries = sm?.getEntries() ?? [];
    return entries.some(
      (e) =>
        (e as { type?: string; message?: { role?: string } }).type === "message" &&
        (e as { message?: { role?: string } }).message?.role === "assistant",
    );
  } catch {
    // Defensive: if it cannot be inspected, apply affinity (standard).
    return true;
  }
}

/**
 * Ordered candidates of a tier.
 *
 * Enabled providers → order follows two modes:
 *
 *  - Without `tierProviderPriorities[tier]` (standard behavior):
 *      affinity with the current provider (continuity/caching) → provider
 *      priority → list order. Affinity is omitted on cold start (first
 *      session turn, no history).
 *  - With a tier-specific map: the tier priority RULES (overrides the
 *      general one only for that tier); affinity breaks ties; list order
 *      is the last criterion.
 */
function orderedCandidates(
  cfg: AutoModelConfig,
  tier: TierId,
  ctx: { model?: Model<any> },
  applyAffinity = true,
  isHealthy: (provider: string) => boolean = () => true,
): ModelEntry[] {
  const entries = (cfg.tiers[tier] || []).filter(
    (e) => cfg.providers[e.provider]?.enabled !== false && isHealthy(e.provider),
  );
  const current = ctx.model;
  const tierMap = cfg.tierProviderPriorities[tier];
  const hasTierMap = !!tierMap && Object.keys(tierMap).length > 0;
  const affinity = (provider: string) =>
    applyAffinity && current && provider === current.provider ? 1 : 0;
  const effectivePriority = (provider: string) =>
    tierMap?.[provider] ?? cfg.providers[provider]?.priority ?? 999;

  return [...entries].sort((a, b) => {
    if (hasTierMap) {
      // Explicit tier priorities rule; affinity only breaks ties.
      const pa = effectivePriority(a.provider);
      const pb = effectivePriority(b.provider);
      if (pa !== pb) return pa - pb;
      const aAff = affinity(a.provider);
      const bAff = affinity(b.provider);
      if (aAff !== bAff) return bAff - aAff;
      return entries.indexOf(a) - entries.indexOf(b);
    }
    // Standard: affinity (continuity/caching) rules.
    const aAff = affinity(a.provider);
    const bAff = affinity(b.provider);
    if (aAff !== bAff) return bAff - aAff;
    const pa = effectivePriority(a.provider);
    const pb = effectivePriority(b.provider);
    if (pa !== pb) return pa - pb;
    return entries.indexOf(a) - entries.indexOf(b);
  });
}

/**
 * Best candidate of the tier with configured auth (preview).
 * The before_agent_start handler iterates the WHOLE list as a real fallback.
 */
function pickModel(
  cfg: AutoModelConfig,
  tier: TierId,
  ctx: {
    model?: Model<any>;
    modelRegistry: {
      find(p: string, id: string): Model<any> | undefined;
      getAvailable(): Model<any>[];
    };
  },
  applyAffinity = true,
  isHealthy: (provider: string) => boolean = () => true,
): PickResult {
  const ordered = orderedCandidates(cfg, tier, ctx, applyAffinity, isHealthy);
  if (ordered.length === 0) {
    return { model: null, reason: `tier "${tier}" has no models with an enabled provider` };
  }

  const available = new Set(
    ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`),
  );
  for (const entry of ordered) {
    const m = ctx.modelRegistry.find(entry.provider, entry.model);
    if (!m) continue;
    if (!available.has(`${entry.provider}/${entry.model}`)) continue; // no auth
    return { model: m, entry, reason: "ok" };
  }
  return {
    model: null,
    reason: `tier "${tier}": no authenticated candidates among: ${ordered
      .map((e) => `${e.provider}/${e.model}`)
      .join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Router state
// ---------------------------------------------------------------------------

interface TurnTiming {
  /** ms of scoring (signals + score + tier). */
  scoringMs: number;
  /** ms of candidate ordering. */
  selectMs: number;
  /** ms of pi.setModel (0 if we were already on the model). */
  setModelMs: number;
  /** total ms of the before_agent_start handler. */
  totalMs: number;
}

interface LastDecision {
  tier: TierId;
  score: number;
  signals: ScoreSignals;
  /** Signal with the highest weighted contribution (explains the tier). */
  dominant: SignalKey;
  modelId: string;
  forced: boolean;
  /** true if the turn was a cold start (no history → no affinity). */
  coldStart: boolean;
  /** % of context used at decision time (null if unknown). */
  contextPercent: number | null;
  timing: TurnTiming;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Testing hooks (extra exports: harmless for the pi loader, which uses the
// default export; they allow validating scoring with `node --experimental-strip-types`)
// ---------------------------------------------------------------------------

export const __test = {
  isSubagentProcess,
  TIER_ORDER,
  DEFAULT_CONFIG,
  computeSignals,
  weightedScore,
  resolveTier,
  orderedCandidates,
  pickModel,
  hasAssistantHistory,
  classifyError,
  httpStatusReason,
  cooldownMsFor,
  isProviderHealthy,
  dominantSignal,
  SIGNAL_ICONS,
  aggregateUsage,
  clampTierToBudget,
  parsePinSpec,
  mergeConfigs,
  nextRescueCandidate,
  hysteresisTier,
  classifyPrompt,
  analyzeCalibration,
  tierForModel,
  usageKey,
  tokenEstimate,
  scoreStructure,
  scoreContext,
  scoreCode,
  scoreAgentic,
  scoreCriticality,
  scoreOutput,
};

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let cfg: AutoModelConfig = loadConfig();
  let enabled = cfg.enabled;
  let skipNextTurn = false;
  let forcedTier: TierId | null = null;
  let lastDecision: LastDecision | null = null;
  let lastWarned: string | null = null;
  let lastCwd: string | undefined;

  /** Manual pin: fixed model that overrides routing (maximum priority). */
  let pinnedModel: { provider: string; model: string } | null = null;

  // --- Mid-turn rescue ------------------------------------------------------
  let lastPrompt = "";
  let lastCandidates: ModelEntry[] = [];
  let lastTurnLocked = true; // pin / bypass / no decision → no rescue
  let rescueBudget = 2; // max retries per real user prompt
  let rescueCount = 0;

  // --- Anti-flip-flop hysteresis --------------------------------------------
  let activeTier: TierId | null = null; // tier anchored by routing
  let activeTierTurns = 0; // consecutive routed turns on the anchored tier

  // --- Provider health ------------------------------------------------------
  let health: HealthMap = {};
  let healthNotified = new Set<string>();

  // --- Usage and cost -------------------------------------------------------
  let usageAll: UsageMap = {};
  let usageSession: UsageMap = {};
  let budgetDay = { date: "", cost: 0 };
  let budgetNotified = { session: false, day: false };

  const loadBudget = () => {
    try {
      if (existsSync(BUDGET_FILE)) {
        const parsed = JSON.parse(readFileSync(BUDGET_FILE, "utf-8")) as { date?: string; cost?: number };
        if (parsed && typeof parsed.cost === "number") {
          budgetDay = { date: parsed.date ?? "", cost: parsed.cost };
        }
      }
    } catch (err) {
      console.error(`[auto-model-router] error reading ${BUDGET_FILE}:`, err);
    }
  };

  const saveBudget = () => {
    try {
      writeFileSync(BUDGET_FILE, JSON.stringify(budgetDay, null, 2), "utf-8");
    } catch (err) {
      console.error(`[auto-model-router] error writing ${BUDGET_FILE}:`, err);
    }
  };

  const sessionCost = () => {
    let total = 0;
    for (const u of Object.values(usageSession)) total += u.cost;
    return total;
  };

  // --- Calibration (implicit user signals) --------------------------------
  let calibSamples: CalibrationSample[] = [];

  const loadSamples = (): CalibrationSample[] => {
    try {
      if (existsSync(CALIB_LOG)) {
        const lines = readFileSync(CALIB_LOG, "utf-8").trim().split("\n").filter(Boolean);
        const out: CalibrationSample[] = [];
        for (const line of lines.slice(-1000)) {
          try {
            out.push(JSON.parse(line) as CalibrationSample);
          } catch {
            // corrupt line → ignore
          }
        }
        return out;
      }
    } catch (err) {
      console.error(`[auto-model-router] error reading ${CALIB_LOG}:`, err);
    }
    return [];
  };

  const logSample = (s: Omit<CalibrationSample, "ts">) => {
    const full: CalibrationSample = { ...s, ts: Date.now() };
    calibSamples.push(full);
    if (calibSamples.length > 1200) calibSamples = calibSamples.slice(-1000);
    try {
      appendFileSync(CALIB_LOG, JSON.stringify(full) + "\n");
    } catch (err) {
      console.error(`[auto-model-router] error writing ${CALIB_LOG}:`, err);
    }
  };

  const loadUsage = (): UsageMap => {
    try {
      if (existsSync(USAGE_FILE)) {
        const parsed = JSON.parse(readFileSync(USAGE_FILE, "utf-8")) as UsageMap;
        return parsed && typeof parsed === "object" ? parsed : {};
      }
    } catch (err) {
      console.error(`[auto-model-router] error reading ${USAGE_FILE}:`, err);
    }
    return {};
  };

  const saveUsage = (u: UsageMap) => {
    try {
      writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2), "utf-8");
    } catch (err) {
      console.error(`[auto-model-router] error writing ${USAGE_FILE}:`, err);
    }
  };

  const recordUsage = (
    provider: string,
    modelId: string,
    u: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: number | { total?: number };
    },
  ) => {
    const cost = typeof u.cost === "object" && u.cost ? (u.cost.total ?? 0) : (u.cost ?? 0);
    const norm = {
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      totalTokens: u.totalTokens ?? 0,
      cost,
    };
    aggregateUsage(usageSession, provider, modelId, norm);
    aggregateUsage(usageAll, provider, modelId, norm);
    saveUsage(usageAll);

    // Daily budget counter
    const dayKey = new Date().toISOString().slice(0, 10);
    if (budgetDay.date !== dayKey) {
      budgetDay = { date: dayKey, cost: 0 };
    }
    budgetDay.cost += cost;
    saveBudget();
  };

  const loadHealth = (): HealthMap => {
    try {
      if (existsSync(HEALTH_FILE)) {
        const parsed = JSON.parse(readFileSync(HEALTH_FILE, "utf-8")) as HealthMap;
        const now = Date.now();
        const pruned: HealthMap = {};
        for (const [p, h] of Object.entries(parsed)) {
          if (h && h.degradedUntil > now) pruned[p] = h;
        }
        return pruned;
      }
    } catch (err) {
      console.error(`[auto-model-router] error reading ${HEALTH_FILE}:`, err);
    }
    return {};
  };

  const saveHealth = (h: HealthMap) => {
    try {
      writeFileSync(HEALTH_FILE, JSON.stringify(h, null, 2), "utf-8");
    } catch (err) {
      console.error(`[auto-model-router] error writing ${HEALTH_FILE}:`, err);
    }
  };

  const degradeProvider = (
    ctx: { ui: { notify(t: string, lvl?: string): void } },
    provider: string,
    reason: HealthReason,
    error: string,
  ) => {
    const now = Date.now();
    const until = now + cooldownMsFor(cfg, reason);
    const prev = health[provider];
    health[provider] = {
      degradedUntil: until,
      reason,
      lastError: error.slice(0, 200),
      hits: (prev?.hits ?? 0) + 1,
    };
    saveHealth(health);
    if (!healthNotified.has(`${provider}:${reason}`)) {
      healthNotified.add(`${provider}:${reason}`);
      const till = new Date(until).toLocaleTimeString();
      ctx.ui.notify(
        `⚠️ Auto-model: provider "${provider}" degraded (${reason}) until ${till} — it will be skipped in routing`,
        "warning",
      );
    }
  };

  const isHealthy = (provider: string) => isProviderHealthy(health, provider);

  /**
   * pi.setModel with a defensive guard: if the extension runtime is not
   * available (it rejects with "Extension runtime not initialized" during
   * startup/reload/replaced-session windows), degrade gracefully instead of
   * propagating an error that would break the turn.
   */
  const safeSetModel = async (m: Model<any>): Promise<boolean> => {
    try {
      return await pi.setModel(m);
    } catch (err) {
      console.error(`[auto-model-router] pi.setModel unavailable (${m.provider}/${m.id}):`, err);
      return false;
    }
  };

  // -----------------------------------------------------------------------
  // message_end — records usage/cost + detects provider errors
  // -----------------------------------------------------------------------
  pi.on("message_end", async (event, ctx) => {
    const m = event.message as unknown as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
      provider?: string;
      model?: string | { id?: string };
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
        cost?: number | { total?: number };
      };
    };
    if (!m || m.role !== "assistant") return;

    // Usage/cost of ALL responses (success or error)
    if (m.usage) {
      const modelId = typeof m.model === "string" ? m.model : m.model?.id;
      if (m.provider && modelId) recordUsage(m.provider, modelId, m.usage);
    }

    // Health: only classifiable errors
    if (m.stopReason !== "error" && !m.errorMessage) return;
    const provider = m.provider ?? ctx.model?.provider;
    if (!provider) return;
    const reason = classifyError(m.errorMessage ?? "");
    if (!reason) return;
    degradeProvider(ctx, provider, reason, m.errorMessage ?? "");

    // 🚑 Mid-turn rescue: recoverable error → next candidate of the tier
    // (healthy and enabled) + retry of the same prompt. Health already
    // degraded the failed provider, so the retry does not go back to it. The
    // failed PROVIDER is also skipped explicitly (not just the failed model)
    // so provider-wide quota/outage errors move to the next real provider.
    if (lastTurnLocked || rescueBudget <= 0 || !lastPrompt) return;
    const failedKey = usageKey(
      provider,
      typeof m.model === "string" ? m.model : m.model?.id ?? "",
    );
    const next = nextRescueCandidate(
      lastCandidates,
      failedKey,
      isHealthy,
      (p) => cfg.providers[p]?.enabled !== false,
      [provider],
    );
    if (!next) return;
    const nm = ctx.modelRegistry.find(next.provider, next.model);
    if (!nm) return;
    const ok = await safeSetModel(nm);
    if (!ok) return;
    rescueBudget--;
    rescueCount++;
    console.error(`[auto-model-router] RESCUE ${failedKey} (${reason}) -> ${nm.provider}/${nm.id}`);
    ctx.ui.notify(
      `🚑 Rescue: ${failedKey} failed (${reason}) → switching provider to ${nm.provider}/${nm.id} and retrying (${rescueBudget} rescues left)`,
      "warning",
    );
    try {
      pi.sendUserMessage(lastPrompt);
    } catch (err) {
      console.error(`[auto-model-router] error during rescue retry:`, err);
    }
  });

  // -------------------------------------------------------------------------
  // after_provider_response — early, reliable provider-outage detection
  // -------------------------------------------------------------------------
  // Pi surfaces provider outages here at the HTTP layer (event.status) BEFORE
  // the response is consumed, so a quota-exhausted provider (429) or an
  // overloaded one (5xx) is degraded immediately regardless of how the error
  // later surfaces (or fails to surface) as a message. Once degraded, routing
  // skips that provider and picks the next one in priority order, so the session
  // never stays stuck on the dead provider.
  pi.on("after_provider_response", (event, ctx) => {
    if (isSubagentProcess()) return;
    if (!enabled) return;
    const reason = httpStatusReason(event.status);
    if (!reason) return;
    // ctx.model may be typed without provider in this event; read defensively.
    const provider = (ctx as { model?: { provider?: string } }).model?.provider;
    if (!provider) return;
    degradeProvider(ctx as never, provider, reason, `HTTP ${event.status}`);
  });

  const warn = (ctx: { ui: { notify(t: string, lvl?: string): void } }, msg: string) => {
    if (lastWarned === msg) return;
    lastWarned = msg;
    ctx.ui.notify(`⚠️ Auto-model: ${msg}`, "warning");
  };

  const setStatus = (
    ctx: { model?: Model<any>; ui: { setStatus(id: string, text: string): void } },
    extra?: string,
  ) => {
    const cur = ctx.model;
    const label = lastDecision ? `🔀 ${lastDecision.tier} · ${lastDecision.modelId}` : `⏸ auto-model`;
    ctx.ui.setStatus("auto-model", extra ? `${label} ${extra}` : label);
  };

  // -------------------------------------------------------------------------
  // input — handles !! (bypass) and @@tier (forced level) prefixes
  // -------------------------------------------------------------------------
  pi.on("input", async (event: InputEvent, _ctx) => {
    if (isSubagentProcess()) return { action: "continue" as const };
    if (event.source === "extension") return { action: "continue" as const };
    if (!enabled) return { action: "continue" as const };
    // New real user input → rescue budget renewed
    rescueBudget = 2;

    let text = event.text.trimStart();

    if (text.startsWith("!!")) {
      skipNextTurn = true;
      text = text.slice(2).trimStart();
      if (!text) return { action: "continue" as const };
      return { action: "transform" as const, text };
    }

    const forced = text.match(/^@@(sota\+|sota|workhorses\+|workhorses|lightweights\+|lightweights)\b/);
    if (forced) {
      const tier = forced[1] as TierId;
      if (!cfg.tiers[tier] || cfg.tiers[tier].length === 0) {
        return { action: "continue" as const };
      }
      forcedTier = tier;
      text = text.slice(forced[0].length).trimStart();
      if (!text) return { action: "continue" as const };
      return { action: "transform" as const, text };
    }

    return { action: "continue" as const };
  });

  // -------------------------------------------------------------------------
  // before_agent_start — classifies and switches model when appropriate
  // -------------------------------------------------------------------------
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
    if (isSubagentProcess()) return;
    if (!enabled) return;
    // No rescue by default (pin/bypass/no decision); routing unlocks it
    lastTurnLocked = true;

    // 📌 Active pin: the pinned model outranks all routing (auto, @@tier,
    // budget). Make sure it is active and exit.
    if (pinnedModel) {
      const m = ctx.modelRegistry.find(pinnedModel.provider, pinnedModel.model);
      const current = ctx.model;
      if (m && (!current || current.provider !== m.provider || current.id !== m.id)) {
        const ok = await safeSetModel(m);
        if (ok) {
          ctx.ui.notify(`📌 Pin: ${m.provider}/${m.id}`, "info");
        } else {
          ctx.ui.notify(`❌ Pin: no API key for ${m.provider}/${m.id}`, "error");
        }
      }
      ctx.ui.setStatus("auto-model", `📌 ${pinnedModel.provider}/${pinnedModel.model}`);
      return;
    }

    const t0 = performance.now();
    const willSkip = skipNextTurn;
    skipNextTurn = false;
    const force = forcedTier;
    forcedTier = null;
    const prompt = event.prompt ?? "";

    if (willSkip) {
      // Implicit signal: the user used !! and skipped routing on this prompt
      try {
        const n = classifyPrompt(prompt);
        logSample({
          kind: "bypass",
          routerTier: n.tier,
          score: n.score,
          dominant: n.dominant,
          excerpt: prompt.slice(0, 60),
        });
      } catch {
        // not critical
      }
      return;
    }

    const imageCount = event.images?.length ?? 0;
    const usage = ctx.getContextUsage();
    const opts = event.systemPromptOptions;
    const signals = computeSignals(
      prompt,
      imageCount,
      usage,
      opts?.selectedTools,
      opts?.skills?.length ?? 0,
      opts?.contextFiles?.length ?? 0,
    );
    const score = weightedScore(signals, cfg.scoring.weights);
    const dominant = dominantSignal(signals, cfg.scoring.weights);

    let tier: TierId;
    let hystBlocked = false;
    if (force) {
      tier = force;
      // Implicit signal: the user forced a level different from the router's natural one
      const natural = resolveTier(
        score,
        signals,
        SHORT_OUTPUT_RE.test(prompt),
        cfg.scoring.thresholds,
      );
      if (natural !== force) {
        logSample({
          kind: "override",
          routerTier: natural,
          forcedTier: force,
          score,
          dominant,
          excerpt: prompt.slice(0, 60),
        });
      }
    } else {
      const quickIntent = SHORT_OUTPUT_RE.test(prompt);
      tier = resolveTier(score, signals, quickIntent, cfg.scoring.thresholds);
      // Anti-flip-flop hysteresis: blocks premature downgrades
      const hyst = hysteresisTier(
        tier,
        activeTier,
        activeTierTurns,
        cfg.hysteresis.minDowngradeTurns,
      );
      if (hyst.blocked) {
        tier = hyst.tier;
        hystBlocked = true;
      }
    }

    // Budget: hard cap when the session or day limit was exceeded
    const clamp = clampTierToBudget(tier, cfg, sessionCost(), budgetDay.cost);
    if (clamp.over) {
      const key = clamp.reason ?? "session";
      if (!budgetNotified[key]) {
        budgetNotified[key] = true;
        ctx.ui.notify(
          `💸 ${clamp.reason} budget exceeded — capped at [${cfg.budget.capTier}]` +
            (clamp.clamped ? ` (${tier} → ${clamp.tier})` : ""),
          "warning",
        );
      }
      tier = clamp.tier;
    }
    const t1 = performance.now();

    // We iterate the WHOLE tier list: if setModel fails (no auth, model
    // unavailable), we fall through to the next candidate until one works.
    // On cold start (first turn, no history) affinity is omitted.
    const applyAffinity = hasAssistantHistory(ctx.sessionManager);
    const candidates = orderedCandidates(cfg, tier, ctx, applyAffinity, isHealthy);
    if (candidates.length === 0) {
      warn(ctx, `tier "${tier}" has no models with an enabled provider`);
      return;
    }
    // State for the mid-turn rescue
    lastPrompt = prompt;
    lastCandidates = candidates;
    lastTurnLocked = false;
    const t2 = performance.now();

    const current = ctx.model;
    let chosen: { model: Model<any>; entry: ModelEntry } | null = null;
    for (const entry of candidates) {
      const m = ctx.modelRegistry.find(entry.provider, entry.model);
      if (!m) continue;

      // We are already on the right model → refresh status and done
      if (current && current.provider === m.provider && current.id === m.id) {
        chosen = { model: m, entry };
        break;
      }

      const ok = await safeSetModel(m);
      if (ok) {
        chosen = { model: m, entry };
        break;
      }
    }

    if (!chosen) {
      warn(
        ctx,
        `tier "${tier}": could not activate any candidate (${candidates
          .map((e) => e.provider + "/" + e.model)
          .join(", ")})`,
      );
      return;
    }
    const t3 = performance.now();

    const { model, entry } = chosen;

    if (entry.thinking) {
      try {
        pi.setThinkingLevel(entry.thinking);
      } catch {
        // the level clamps itself; not critical
      }
    }

    const totalMs = t3 - t0;
    // Hysteresis anchor: same tier → +1 turn; change (upgrade/allowed
    // downgrade/budget cap) → new anchor
    if (tier === activeTier) {
      activeTierTurns++;
    } else {
      activeTier = tier;
      activeTierTurns = 0;
    }
    lastDecision = {
      tier,
      score,
      signals,
      dominant,
      modelId: `${model.provider}/${model.id}`,
      forced: !!force,
      coldStart: !applyAffinity,
      contextPercent: usage?.percent ?? null,
      timing: {
        scoringMs: t1 - t0,
        selectMs: t2 - t1,
        setModelMs: t3 - t2,
        totalMs,
      },
      timestamp: Date.now(),
    };

    const hystNote =
      hystBlocked && activeTier
        ? ` · 🧲 hysteresis (downgrade blocked ${activeTierTurns}/${cfg.hysteresis.minDowngradeTurns})`
        : "";
    ctx.ui.notify(
      `${force ? "🎯" : "🔀"} [${tier}] ${model.provider}/${model.id} (score ${score.toFixed(2)} · ${SIGNAL_ICONS[dominant]} ${dominant})${hystNote}`,
      "info",
    );
    setStatus(ctx);
  });

  // -------------------------------------------------------------------------
  // model_select — keep the status bar in sync
  // -------------------------------------------------------------------------
  pi.on("model_select", (event, ctx) => {
    if (pinnedModel) {
      ctx.ui.setStatus("auto-model", `📌 ${pinnedModel.provider}/${pinnedModel.model}`);
      return;
    }
    ctx.ui.setStatus("auto-model", `${enabled ? "🔀" : "⏸"} ${event.model.provider}/${event.model.id}`);
  });

  // -------------------------------------------------------------------------
  // session_start — initial state
  // -------------------------------------------------------------------------
  pi.on("session_start", (_event, ctx) => {
    if (isSubagentProcess()) return;
    lastCwd = ctx.cwd;
    cfg = loadConfig(ctx.isProjectTrusted() ? ctx.cwd : undefined);
    enabled = cfg.enabled;
    lastWarned = null;
    pinnedModel = null;
    health = loadHealth();
    healthNotified = new Set();
    usageAll = loadUsage();
    usageSession = {};
    loadBudget();
    budgetNotified = { session: false, day: false };
    activeTier = null;
    activeTierTurns = 0;
    calibSamples = loadSamples();
    const degraded = Object.entries(health).filter(([, h]) => h.degradedUntil > Date.now());
    if (degraded.length > 0) {
      ctx.ui.notify(
        `⚠️ Degraded providers: ${degraded
          .map(([p, h]) => `${p} (${h.reason}, until ${new Date(h.degradedUntil).toLocaleTimeString()})`)
          .join(", ")}`,
        "warning",
      );
    }
    ctx.ui.setStatus("auto-model", enabled ? "🔀 auto-model" : "⏸ auto-model");
    ctx.ui.notify(
      `🔀 Auto Model Router ${enabled ? "active" : "inactive"} — ${cfg.tiers["sota+"].length}+${cfg.tiers.sota.length}+${cfg.tiers["workhorses+"].length}+${cfg.tiers.workhorses.length}+${cfg.tiers["lightweights+"].length}+${cfg.tiers.lightweights.length} models across ${TIER_ORDER.length} tiers. "!!" bypasses, "@@tier" forces.`,
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Command: /auto-model
  // -------------------------------------------------------------------------
  pi.registerCommand("auto-model", {
    description:
      "Auto model router: status/scoring, on|off, reload, config, score <text>",
    handler: async (args: string, ctx) => {
      const cmd = (args || "").trim().split(/\s+/)[0] || "";
      const rest = (args || "").trim().slice(cmd.length).trim();

      switch (cmd) {
        case "on":
          enabled = true;
          ctx.ui.notify("🔀 Auto Model Router enabled", "info");
          break;
        case "off":
          enabled = false;
          ctx.ui.notify("⏸ Auto Model Router disabled", "info");
          break;
        case "reload":
          cfg = loadConfig(lastCwd);
          enabled = cfg.enabled;
          ctx.ui.notify(`♻️ Configuration reloaded (enabled=${cfg.enabled})`, "info");
          break;
        case "config": {
          const projectPath = lastCwd ? join(lastCwd, ".pi", "auto-model.json") : null;
          const lines = [
            `Global config: ${CONFIG_PATH}`,
            projectPath
              ? `Project config: ${projectPath}${existsSync(projectPath) ? " (active)" : " (does not exist — global only)"}`
              : "Project config: (no cwd)",
            `Active providers: ${Object.entries(cfg.providers)
              .filter(([, p]) => p.enabled)
              .map(([k]) => k)
              .join(", ")}`,
          ];
          for (const id of TIER_ORDER) {
            const names = (cfg.tiers[id] || [])
              .filter((e) => cfg.providers[e.provider]?.enabled)
              .map((e) => `${e.provider}/${e.model}`);
            const tmap = cfg.tierProviderPriorities[id];
            const prio =
              tmap && Object.keys(tmap).length
                ? ` [${Object.entries(tmap)
                    .map(([p, n]) => `${p}=${n}`)
                    .join(", ")}]`
                : "";
            lines.push(`${id}: ${names.length ? names.join(" · ") : "—"}${prio}`);
          }
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
        case "score": {
          if (!rest) {
            ctx.ui.notify("Usage: /auto-model score <text to evaluate>", "warning");
            break;
          }
          const signals = computeSignals(rest, 0, undefined, undefined, 0, 0);
          const score = weightedScore(signals, cfg.scoring.weights);
          const tier0 = resolveTier(score, signals, SHORT_OUTPUT_RE.test(rest), cfg.scoring.thresholds);
          const clamp = clampTierToBudget(tier0, cfg, sessionCost(), budgetDay.cost);
          const tier = clamp.tier;
          const picked = pickModel(cfg, tier, ctx);
          const dominant = dominantSignal(signals, cfg.scoring.weights);
          const parts = Object.entries(signals)
            .map(([k, v]) => `${k}=${v.toFixed(2)}${k === dominant ? " ←" : ""}`)
            .join(" ");
          ctx.ui.notify(
            `🧪 score=${score.toFixed(3)} → tier [${tier}] · ${SIGNAL_ICONS[dominant]} ${dominant}${clamp.over ? " · 💸 budget exceeded" : ""}\n${parts}\n→ ${picked.model ? `${picked.model.provider}/${picked.model.id}` : picked.reason}`,
            "info",
          );
          break;
        }
        case "debug": {
          const cur = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "—";
          if (!lastDecision) {
            ctx.ui.notify(
              `🔍 debug: no decision recorded yet — send a prompt and repeat.
Current model: ${cur} · enabled: ${enabled} · config: ${CONFIG_PATH}`,
              "info",
            );
            break;
          }
          const t = lastDecision.timing;
          const d = lastDecision.dominant;
          const ctxInfo =
            lastDecision.contextPercent === null
              ? "unknown"
              : `${(lastDecision.contextPercent * 100).toFixed(0)}%`;
          ctx.ui.notify(
            `🔍 debug — last decision\n` +
              `tier: [${lastDecision.tier}]${lastDecision.forced ? " (forced)" : ""} · score ${lastDecision.score.toFixed(3)} · ${SIGNAL_ICONS[d]} ${d}\n` +
              `model: ${lastDecision.modelId}\n` +
              `⏱️  scoring ${t.scoringMs.toFixed(1)}ms · select ${t.selectMs.toFixed(1)}ms · setModel ${t.setModelMs.toFixed(1)}ms · total ${t.totalMs.toFixed(1)}ms\n` +
              `🧊 cold start: ${lastDecision.coldStart ? "yes (no affinity)" : "no (affinity active)"} · ctx ${ctxInfo} · 🚑 ${rescueCount} rescues · 🧲 anchor [${activeTier ?? "—"}] ${activeTierTurns}t\n` +
              `signals: ${Object.entries(lastDecision.signals)
                .map(([k, v]) => `${k}=${v.toFixed(2)}${k === d ? " ←" : ""}`)
                .join(" ")}\n` +
              `current model: ${cur} · enabled: ${enabled} · config: ${CONFIG_PATH}`,
            "info",
          );
          break;
        }
        case "health": {
          const now = Date.now();
          const degraded = Object.entries(health).filter(([, h]) => h.degradedUntil > now);
          if (rest === "clear") {
            health = {};
            saveHealth(health);
            healthNotified = new Set();
            ctx.ui.notify("♻️ Provider health reset", "info");
            break;
          }
          if (degraded.length === 0) {
            ctx.ui.notify("✅ Provider health: all operational", "info");
            break;
          }
          ctx.ui.notify(
            `🩺 Degraded providers:\n${degraded
              .map(
                ([p, h]) =>
                  `${p}: ${h.reason} (hits ${h.hits}, until ${new Date(h.degradedUntil).toLocaleTimeString()}) — ${h.lastError.slice(0, 120)}`,
              )
              .join("\n")}\n/auto-model health clear to reset`,
            "warning",
          );
          break;
        }
        case "calibrate": {
          if (rest === "clear") {
            calibSamples = [];
            try {
              writeFileSync(CALIB_LOG, "", "utf-8");
            } catch (err) {
              console.error(`[auto-model-router] error clearing ${CALIB_LOG}:`, err);
            }
            ctx.ui.notify("🧮 Calibration history reset", "info");
            break;
          }
          const report = analyzeCalibration(calibSamples, cfg);
          if (report.total === 0) {
            ctx.ui.notify(
              `🧮 Calibration: no signals yet. Use @@tier when the router misses the level (and !! to bypass it) — they are collected in ${CALIB_LOG}`,
              "info",
            );
            break;
          }
          const lines: string[] = [
            `🧮 Calibration — ${report.total} signals (${report.overrides} overrides · ${report.bypasses} bypass)`,
            `  Undershoots (you asked for more capability): ${report.under} · Overshoots: ${report.over}`,
          ];
          const sig = Object.entries(report.perSignal)
            .filter(([, v]) => v.under + v.over > 0)
            .map(([k, v]) => `  ${SIGNAL_ICONS[k as SignalKey]} ${k}: ↓${v.under} ↑${v.over}`);
          if (sig.length > 0) lines.push(`  By dominant signal:\n${sig.join("\n")}`);
          if (report.weightSuggestions.length > 0) {
            lines.push(`  Weight suggestions (not applied):`);
            for (const w of report.weightSuggestions) {
              lines.push(
                `    ${SIGNAL_ICONS[w.signal]} ${w.signal}: ${w.from} → ${w.to} (Δ${w.delta > 0 ? "+" : ""}${w.delta})`,
              );
            }
          } else {
            lines.push(`  Weights: no suggestions (balanced signals)`);
          }
          for (const h of report.boundaryHints) lines.push(`  ⚠️ ${h}`);
          lines.push(`  (copy the Δs to scoring.weights, or /auto-model calibrate clear to reset)`);
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
        case "usage": {
          if (rest === "clear") {
            usageAll = {};
            usageSession = {};
            saveUsage(usageAll);
            ctx.ui.notify("📊 Uso y coste reiniciados", "info");
            break;
          }
          const fmt = (n: number) =>
            n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${n}`;
          const money = (c: number) => `$${c.toFixed(2)}`;
          const summarize = (map: UsageMap) => {
            let totalCost = 0;
            let totalTokens = 0;
            let totalCalls = 0;
            const tiers: Record<string, { calls: number; cost: number }> = {};
            for (const [key, u] of Object.entries(map)) {
              totalCost += u.cost;
              totalTokens += u.totalTokens;
              totalCalls += u.calls;
              const [p, m] = key.split("/");
              const tier = tierForModel(cfg, p, m);
              const t = (tiers[tier] ??= { calls: 0, cost: 0 });
              t.calls += u.calls;
              t.cost += u.cost;
            }
            const top = Object.entries(map)
              .sort((a, b) => b[1].cost - a[1].cost)
              .slice(0, 5);
            return { totalCost, totalTokens, totalCalls, tiers, top };
          };
          const all = summarize(usageAll);
          const sess = summarize(usageSession);
          const b = cfg.budget;
          const overSess = b.maxCostPerSession > 0 && sess.totalCost >= b.maxCostPerSession;
          const overDay = b.maxCostPerDay > 0 && budgetDay.cost >= b.maxCostPerDay;
          const budgetLine =
            b.maxCostPerSession > 0 || b.maxCostPerDay > 0
              ? `💸 Presupuesto: sesión ${money(sess.totalCost)}/${money(b.maxCostPerSession)} · día ${money(budgetDay.cost)}/${money(b.maxCostPerDay)} — techo [${b.capTier}]${overSess || overDay ? " ⚠️ SUPERADO" : ""}`
              : `💸 Presupuesto: sin límite (configura budget.maxCostPerSession/maxCostPerDay)`;
          const tierLines = TIER_ORDER.map((t) => {
            const s = all.tiers[t];
            return s ? `  ${t}: ${s.calls} llamadas · ${money(s.cost)}` : null;
          })
            .filter((x): x is string => !!x)
            .join("\n");
          const topLines = all.top.length
            ? all.top
                .map(([k, u]) => `  ${k}: ${u.calls} llamadas · ${fmt(u.totalTokens)} tok · ${money(u.cost)}`)
                .join("\n")
            : "  (sin datos todavía)";
          ctx.ui.notify(
            `📊 Uso — todo el tiempo\n` +
              `  Total: ${money(all.totalCost)} · ${fmt(all.totalTokens)} tokens · ${all.totalCalls} llamadas\n` +
              `  Por tier:\n${tierLines}\n` +
              `  Top modelos:\n${topLines}\n` +
              `📈 Sesión actual: ${money(sess.totalCost)} · ${fmt(sess.totalTokens)} tokens · ${sess.totalCalls} llamadas\n` +
              `${budgetLine}\n` +
              `(/auto-model usage clear para reiniciar)`,
            "info",
          );
          break;
        }
        case "pin": {
          const spec = parsePinSpec(rest);
          if (!spec) {
            ctx.ui.notify("Uso: /auto-model pin <provider/model> (ej. anthropic/claude-opus-4-8)", "warning");
            break;
          }
          const m = ctx.modelRegistry?.find?.(spec.provider, spec.model);
          if (!m) {
            ctx.ui.notify(
              `❌ Pin: modelo "${spec.provider}/${spec.model}" no está en el catálogo de pi`,
              "warning",
            );
            break;
          }
          const ok = await safeSetModel(m);
          if (!ok) {
            ctx.ui.notify(`❌ Pin: sin API key para ${spec.provider}/${spec.model}`, "error");
            break;
          }
          pinnedModel = spec;
          ctx.ui.notify(`📌 Modelo pineado: ${spec.provider}/${spec.model} — el router queda bloqueado hasta /auto-model unpin`, "info");
          ctx.ui.setStatus("auto-model", `📌 ${spec.provider}/${spec.model}`);
          break;
        }
        case "unpin": {
          if (!pinnedModel) {
            ctx.ui.notify("📌 No hay ningún modelo pineado", "info");
            break;
          }
          pinnedModel = null;
          ctx.ui.notify("📌 Pin retirado — el router reanuda su selección automática", "info");
          ctx.ui.setStatus("auto-model", enabled ? "🔀 auto-model" : "⏸ auto-model");
          break;
        }
        default: {
          const cur = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "—";
          const degraded = Object.entries(health).filter(([, h]) => h.degradedUntil > Date.now());
          const healthLine =
            degraded.length > 0
              ? `\n⚠️ Degradados: ${degraded.map(([p, h]) => `${p} (${h.reason})`).join(", ")}`
              : "";
          const parts = lastDecision
            ? `\nÚltimo: [${lastDecision.tier}] ${lastDecision.modelId} (score ${lastDecision.score.toFixed(3)} · ${SIGNAL_ICONS[lastDecision.dominant]} ${lastDecision.dominant}${lastDecision.forced ? ", forzado" : ""})` +
              `\n  ${Object.entries(lastDecision.signals)
                .map(([k, v]) => `${k}=${v.toFixed(2)}`)
                .join(" ")}` +
              `\n  ⏱️ ${lastDecision.timing.totalMs.toFixed(1)}ms total (scoring ${lastDecision.timing.scoringMs.toFixed(1)} · select ${lastDecision.timing.selectMs.toFixed(1)} · setModel ${lastDecision.timing.setModelMs.toFixed(1)})` +
              ` · 🧊 ${lastDecision.coldStart ? "cold-start" : "afinidad"}`
            : "";
          const pinLine = pinnedModel ? `\n📌 Pineado: ${pinnedModel.provider}/${pinnedModel.model} (/auto-model unpin para liberar)` : "";
          ctx.ui.notify(
            `🔀 Auto Model Router: ${enabled ? "ON" : "OFF"}\nModelo actual: ${cur}${parts}${healthLine}${pinLine}\nSubcomandos: on | off | reload | config | score <texto> | debug | health | pin | unpin | usage | calibrate`,
            "info",
          );
        }
      }
    },
  });
}
