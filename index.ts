/**
 * Auto Model Router v2 — extension global de pi
 * ==============================================
 *
 * Selecciona automáticamente el modelo más apropiado para cada tarea,
 * en función de una taxonomía de 6 niveles (tiers):
 *
 *     sota+ / sota / workhorses+ / workhorses / lightweights+ / lightweights
 *
 * Cada tier define UNA LISTA de candidatos {provider, model} y los providers
 * se pueden habilitar/deshabilitar en la configuración. Si un provider está
 * deshabilitado, sus modelos se excluyen de la permutación (por ejemplo: SOTA
 * tiene claude-fable-5 (anthropic) y gemini-3.1-pro-preview (google), pero si
 * anthropic está deshabilitado, se usará gemini-3.1-pro-preview).
 *
 * La selección del nivel NO es trivial (no se basa solo en la longitud del
 * prompt): calcula un score de complejidad multicomponente:
 *
 *   - structure  : tamaño estimado en tokens + imágenes adjuntas
 *   - context    : presión del contexto de la sesión (getContextUsage)
 *   - code       : densidad de código (bloques ```, diffs, paths, verbos)
 *   - agentic    : profundidad agéntica (tools activas, skills, contextFiles,
 *                  indicadores multi-paso en el prompt)
 *   - criticality: riesgo (producción, deploy, migración, seguridad, dinero…)
 *   - output     : formato esperado de salida (informe largo vs. una línea)
 *
 * Los pesos y umbrales son configurables (~/.pi/agent/auto-model.json).
 *
 * Uso:
 *   - Automático en cada prompt (si "enabled": true).
 *   - Prefijo "!!"  → salta el router este turno.
 *   - Prefijo "@@tier" (ej. "@@sota haz X") → fuerza un nivel concreto.
 *   - /auto-model                 → estado + último desglose de scoring
 *   - /auto-model on|off          → toggle
 *   - /auto-model reload          → recarga la configuración
 *   - /auto-model config          → muestra la ruta de configuración
 *   - /auto-model score <texto>   → simula el scoring sin enviar nada
 *
 * Configuración: ~/.pi/agent/auto-model.json (opcional; si falta, usa los
 * defaults embebidos). Ver config.example.json en este directorio.
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
// Tipos de configuración
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
  /** Nivel de thinking opcional al seleccionar este modelo. */
  thinking?: ThinkingLevel;
}

export interface ProviderConfig {
  enabled: boolean;
  /** Menor = preferido dentro del tier (empate con affinity del provider). */
  priority?: number;
}

export interface AutoModelConfig {
  enabled: boolean;
  providers: Record<string, ProviderConfig>;
  tiers: Record<TierId, ModelEntry[]>;
  /**
   * Prioridades de provider específicas por tier. Sobrescriben la priority
   * general de `providers` SOLO para ese tier; los providers no listados en
   * el mapa de un tier usan su priority general. Vacío → todo usa la general.
   */
  tierProviderPriorities: Partial<Record<TierId, Record<string, number>>>;
  /** Salud de providers: cooldowns por tipo de error. */
  health: {
    cooldownMs: Record<HealthReason, number>;
  };
  /**
   * Presupuesto: límites de coste con techo de tier. 0 = deshabilitado.
   * Cuando el coste de sesión o día supera el límite, el routing se techa
   * en `capTier` (el nivel de capacidad máximo permitido) — aplica también
   * a tiers forzados con @@tier (guardarraíl duro).
   */
  budget: {
    maxCostPerSession: number;
    maxCostPerDay: number;
    capTier: TierId;
  };
  /**
   * Histéresis anti-flip-flop: para BAJAR de tier, el tier actual debe haberse
   * mantenido al menos `minDowngradeTurns` turnos rutados. Las subidas son
   * siempre inmediatas. 0 = deshabilitado.
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
  /** Epoch ms hasta el que el provider está degradado. */
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
// Defaults embebidos (se pueden sobreescribir con ~/.pi/agent/auto-model.json)
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
// Carga de configuración (merge profundo sobre defaults)
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
 * Config efectiva para un proyecto: defaults embebidos → archivo global
 * (~/.pi/agent/auto-model.json) → archivo de proyecto (./.pi/auto-model.json).
 * El proyecto solo se aplica cuando cwd se pasa (proyecto de confianza).
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
    console.error(`[auto-model-router] error leyendo ${CONFIG_PATH}:`, err);
  }
  if (cwd) {
    const projectPath = join(cwd, ".pi", "auto-model.json");
    try {
      if (existsSync(projectPath)) {
        project = JSON.parse(readFileSync(projectPath, "utf-8"));
      }
    } catch (err) {
      console.error(`[auto-model-router] error leyendo ${projectPath}:`, err);
    }
  }
  return mergeConfigs(global, project);
}

// ---------------------------------------------------------------------------
// Scoring multicomponente (cada señal → [0,1])
// ---------------------------------------------------------------------------

function tokenEstimate(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/** 1) Estructura: tamaño del prompt + imágenes. */
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

/** 2) Contexto: presión del contexto de la sesión. */
function scoreContext(usage: ContextUsage | undefined): number {
  if (!usage || usage.percent === null) return 0.3; // desconocido → leve
  const p = usage.percent;
  if (p < 0.2) return 0.1;
  if (p < 0.4) return 0.3;
  if (p < 0.6) return 0.55;
  if (p < 0.8) return 0.75;
  return 0.95;
}

/** 3) Código: densidad de tareas de ingeniería. */
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

/** 4) Agentic: profundidad de la tarea agéntica. */
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

/** 5) Criticality: riesgo operativo o de datos. */
const CRITICAL_RE =
  /\b(produ[cct]ion|prod\b|deploy|release|rollback|migraci[oó]n|migration|breaking|irreversible|seguridad|security|vulnerabil|exploit|datos sensibles|sensitive data|pii|customer data|datos de clientes|financiero|financial|dinero|money|factura|invoice|contrato|contract|compliance|audit(?:or[ií]a)?|drop table|truncate|rm -rf|borra (la )?(base|tabla|datos)|elimina (la )?(base|tabla|datos)|sin copia de seguridad|no backup)\b/i;

function scoreCriticality(prompt: string): number {
  const matches = (prompt.match(CRITICAL_RE) || []).length;
  return Math.min(1, matches * 0.35);
}

/** 6) Output: formato esperado de la respuesta. */
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
// Salud de providers (dead-provider detection)
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
 * Clasifica un mensaje de error en una categoría de salud de provider.
 * Devuelve null si el error NO es problema del provider (p.ej. desbordamiento
 * de contexto, que pi gestiona con compactación).
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

function isProviderHealthy(health: HealthMap, provider: string, now = Date.now()): boolean {
  const h = health[provider];
  return !h || h.degradedUntil <= now;
}

// ---------------------------------------------------------------------------
// Uso y coste (dashboard)
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

/** Tier al que pertenece un modelo (primera coincidencia de mayor a menor). */
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
 * Parsea una especificación "provider/model" para el pin. Devuelve null si
 * no tiene la forma esperada.
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
 * Siguiente candidato de rescate tras un fallo: el primer modelo del tier
 * posterior al que falló, que esté habilitado y sano. undefined si no hay.
 */
export function nextRescueCandidate(
  candidates: ModelEntry[],
  failedKey: string,
  isHealthy: (provider: string) => boolean,
  isEnabled: (provider: string) => boolean,
): ModelEntry | undefined {
  const idx = candidates.findIndex((e) => usageKey(e.provider, e.model) === failedKey);
  if (idx === -1) return undefined;
  return candidates.slice(idx + 1).find((e) => isEnabled(e.provider) && isHealthy(e.provider));
}

/**
 * Histéresis: decide si una BAJADA de tier se permite o se bloquea.
 * - Sin tier activo, subida o mismo tier → sin cambios (blocked=false).
 * - Bajada con turnos estables >= min → permitida (devuelve el natural).
 * - Bajada con turnos < min → bloqueada (devuelve el tier activo).
 * force ignora la histéresis (se maneja en el handler pasando min=0 o el
 * propio handler evitando llamarla en el camino forzado).
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
  if (natIdx <= actIdx) return { tier, blocked: false }; // misma capacidad o subida
  if (activeTierTurns < minDowngradeTurns) {
    return { tier: activeTier, blocked: true }; // baja bloqueada → mantener
  }
  return { tier, blocked: false }; // baja permitida
}

/**
 * Muestra de calibración: señal implícita del usuario sobre la decisión.
 * - override: el usuario forzó @@tier distinto al natural del router.
 * - bypass: el usuario usó !! y saltó el routing en ese prompt.
 */
export interface CalibrationSample {
  ts: number;
  kind: "override" | "bypass";
  /** Tier natural que el router habría decidido. */
  routerTier: TierId;
  /** override: el tier forzado con @@tier. */
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
  /** Usuario pidió MÁS capacidad que el router (bajo-tiro del router). */
  under: number;
  /** Usuario pidió MENOS capacidad que el router (sobre-tiro). */
  over: number;
  perSignal: Record<SignalKey, { under: number; over: number }>;
  weightSuggestions: WeightSuggestion[];
  boundaryHints: string[];
}

const WEIGHT_DELTA_PER_SAMPLE = 0.01;
const MAX_WEIGHT_DELTA = 0.06;

/**
 * Analiza las correcciones del usuario y sugiere deltas de peso por señal
 * (más bajo-tiros que sobre-tiros en una señal → subir su peso, y al revés).
 * Puro y determinista; no muta la configuración.
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
        `${scores.length} subida(s) forzada(s) a ${target} desde tier inferior (score medio ${med.toFixed(2)}) — el threshold de ${target} (${thr}) puede estar alto; revisa también el peso de la señal dominante.`,
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
  /** true si el presupuesto está superado (independiente de si hubo clamp). */
  over: boolean;
  /** true si el tier se rebajó por el techo. */
  clamped: boolean;
  reason: "session" | "day" | null;
}

/**
 * Aplica el techo de presupuesto: si el coste de sesión o día supera el límite,
 * el tier se techa en `capTier`. 0 en los límites = deshabilitado. El techo es
 * un guardarraíl duro: puede rebajar incluso tiers forzados.
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
// Resolución del tier
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
 * Señal dominante: la que más contribución ponderada aporta al score
 * (peso × valor). Es la que explica la decisión del tier.
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
 * Pipeline estático del classifier (determinista, para eval/calibración):
 * señales → score → tier (con quickIntent y sin estado de sesión como salud,
 * presupuesto o histéresis). Es lo que el harness de evaluación testea.
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
 * Mapa score → tier. Aplica reglas de piso/techo coherentes:
 *  - criticality alta (>=0.7) impone un piso en sota (la seguridad manda).
 *  - intención explícita de rapidez (SHORT_OUTPUT_RE) impone un techo en
 *    workhorses (nada de gastar SOTA en "resume esto en una línea").
 *  - El piso de criticality gana al techo de rapidez (un cambio de prod
 *    "rápido" sigue mereciendo un modelo serio).
 */
/**
 * Mapa score → tier. Aplica reglas de piso/techo coherentes:
 *  - criticality alta (>=0.7) impone un piso de CAPACIDAD en sota (la seguridad
 *    manda: un cambio de prod "rápido" sigue mereciendo un modelo serio).
 *  - intención explícita de rapidez (SHORT_OUTPUT_RE) impone un techo de
 *    CAPACIDAD en workhorses (no gastar SOTA en trivialidades).
 *
 * OJO: TIER_ORDER va de mayor a menor capacidad (sota+ → lightweights), así que
 * el techo de capacidad = índice MÍNIMO y el piso de capacidad = índice MÁXIMO.
 */
function resolveTier(
  score: number,
  signals: ScoreSignals,
  quickIntent: boolean,
  thresholds: AutoModelConfig["scoring"]["thresholds"],
): TierId {
  // Índices en el espacio de TIER_ORDER (0 = sota+, 5 = lightweights)
  let minCapabilityIdx = 0; // techo de capacidad (nunca más capaz que esto)
  let maxCapabilityIdx = TIER_ORDER.length - 1; // piso de capacidad

  if (signals.criticality >= 0.7) {
    // Piso: nunca por debajo de sota → índice máximo 1
    maxCapabilityIdx = TIER_ORDER.indexOf("sota");
  } else if (quickIntent) {
    // Techo: nunca por encima de workhorses → índice mínimo 3
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
// Selección de modelo dentro del tier (permutación sobre providers activos)
// ---------------------------------------------------------------------------

interface PickResult {
  model: Model<any> | null;
  entry?: ModelEntry;
  reason: string;
}

/**
 * Candidatos de un tier ordenados: providers habilitados → afinidad con el
 * provider actual → priority del provider → orden de lista.
 */
/**
 * ¿Hay historial de conversación (algún turno de assistant ya completado)?
 * En el primer prompt de una sesión no hay continuidad que conservar, así que
 * la afinidad de provider se salta y mandan las priorities puras (arranque
 * en frío). A partir del segundo turno la afinidad vuelve a aplicar.
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
    // Defensivo: si no se puede inspeccionar, aplicar afinidad (estándar).
    return true;
  }
}

/**
 * Candidatos de un tier ordenados.
 *
 * Providers habilitados → orden según dos modos:
 *
 *  - Sin `tierProviderPriorities[tier]` (comportamiento estándar):
 *      afinidad con el provider actual (continuidad/caching) → priority
 *      del provider → orden de lista. La afinidad se omite en arranque en
 *      frío (primer turno de la sesión, sin historial).
 *  - Con mapa específico del tier: la priority del tier MANDA (sobrescribe
 *      la general solo para ese tier); la afinidad desempata; el orden de
 *      lista es el último criterio.
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
      // Prioridades explícitas del tier mandan; afinidad solo desempata.
      const pa = effectivePriority(a.provider);
      const pb = effectivePriority(b.provider);
      if (pa !== pb) return pa - pb;
      const aAff = affinity(a.provider);
      const bAff = affinity(b.provider);
      if (aAff !== bAff) return bAff - aAff;
      return entries.indexOf(a) - entries.indexOf(b);
    }
    // Estándar: afinidad (continuidad/caching) manda.
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
 * Mejor candidato del tier con auth configurada (previsualización).
 * El handler de before_agent_start itera TODA la lista como fallback real.
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
    return { model: null, reason: `tier "${tier}" sin modelos con provider habilitado` };
  }

  const available = new Set(
    ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`),
  );
  for (const entry of ordered) {
    const m = ctx.modelRegistry.find(entry.provider, entry.model);
    if (!m) continue;
    if (!available.has(`${entry.provider}/${entry.model}`)) continue; // sin auth
    return { model: m, entry, reason: "ok" };
  }
  return {
    model: null,
    reason: `tier "${tier}": sin candidatos autenticados entre: ${ordered
      .map((e) => `${e.provider}/${e.model}`)
      .join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Estado del router
// ---------------------------------------------------------------------------

interface TurnTiming {
  /** ms del scoring (señales + score + tier). */
  scoringMs: number;
  /** ms del ordenado de candidatos. */
  selectMs: number;
  /** ms de pi.setModel (0 si ya estábamos en el modelo). */
  setModelMs: number;
  /** ms totales del handler before_agent_start. */
  totalMs: number;
}

interface LastDecision {
  tier: TierId;
  score: number;
  signals: ScoreSignals;
  /** Señal con mayor contribución ponderada (explica el tier). */
  dominant: SignalKey;
  modelId: string;
  forced: boolean;
  /** true si el turno fue en arranque en frío (sin historial → sin afinidad). */
  coldStart: boolean;
  /** % de contexto ocupado en el momento de la decisión (null si desconocido). */
  contextPercent: number | null;
  timing: TurnTiming;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Hooks de testing (exports extra: inofensivos para el loader de pi, que usa
// el default export; permiten validar el scoring con `node --experimental-strip-types`)
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
// Extensión
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let cfg: AutoModelConfig = loadConfig();
  let enabled = cfg.enabled;
  let skipNextTurn = false;
  let forcedTier: TierId | null = null;
  let lastDecision: LastDecision | null = null;
  let lastWarned: string | null = null;
  let lastCwd: string | undefined;

  /** Pin manual: modelo fijo que sobreescribe el routing (prioridad máxima). */
  let pinnedModel: { provider: string; model: string } | null = null;

  // --- Rescate a mitad de turno -------------------------------------------
  let lastPrompt = "";
  let lastCandidates: ModelEntry[] = [];
  let lastTurnLocked = true; // pin / bypass / sin decisión → sin rescate
  let rescueBudget = 2; // reintentos máximos por prompt de usuario real
  let rescueCount = 0;

  // --- Histéresis anti-flip-flop ------------------------------------------
  let activeTier: TierId | null = null; // tier anclado por el routing
  let activeTierTurns = 0; // turnos rutados consecutivos en el tier anclado

  // --- Salud de providers ------------------------------------------------
  let health: HealthMap = {};
  let healthNotified = new Set<string>();

  // --- Uso y coste ---------------------------------------------------------
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
      console.error(`[auto-model-router] error leyendo ${BUDGET_FILE}:`, err);
    }
  };

  const saveBudget = () => {
    try {
      writeFileSync(BUDGET_FILE, JSON.stringify(budgetDay, null, 2), "utf-8");
    } catch (err) {
      console.error(`[auto-model-router] error escribiendo ${BUDGET_FILE}:`, err);
    }
  };

  const sessionCost = () => {
    let total = 0;
    for (const u of Object.values(usageSession)) total += u.cost;
    return total;
  };

  // --- Calibración (señales implícitas del usuario) -----------------------
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
            // línea corrupta → ignorar
          }
        }
        return out;
      }
    } catch (err) {
      console.error(`[auto-model-router] error leyendo ${CALIB_LOG}:`, err);
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
      console.error(`[auto-model-router] error escribiendo ${CALIB_LOG}:`, err);
    }
  };

  const loadUsage = (): UsageMap => {
    try {
      if (existsSync(USAGE_FILE)) {
        const parsed = JSON.parse(readFileSync(USAGE_FILE, "utf-8")) as UsageMap;
        return parsed && typeof parsed === "object" ? parsed : {};
      }
    } catch (err) {
      console.error(`[auto-model-router] error leyendo ${USAGE_FILE}:`, err);
    }
    return {};
  };

  const saveUsage = (u: UsageMap) => {
    try {
      writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2), "utf-8");
    } catch (err) {
      console.error(`[auto-model-router] error escribiendo ${USAGE_FILE}:`, err);
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

    // Contador diario de presupuesto
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
      console.error(`[auto-model-router] error leyendo ${HEALTH_FILE}:`, err);
    }
    return {};
  };

  const saveHealth = (h: HealthMap) => {
    try {
      writeFileSync(HEALTH_FILE, JSON.stringify(h, null, 2), "utf-8");
    } catch (err) {
      console.error(`[auto-model-router] error escribiendo ${HEALTH_FILE}:`, err);
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
        `⚠️ Auto-model: provider "${provider}" degradado (${reason}) hasta ${till} — se saltará en el routing`,
        "warning",
      );
    }
  };

  const isHealthy = (provider: string) => isProviderHealthy(health, provider);

  /**
   * pi.setModel con guarda defensiva: si el runtime de la extensión no está
   * disponible (rechaza con "Extension runtime not initialized" en ventanas de
   * arranque/reload/sesión reemplazada), degrada con elegancia en vez de
   * propagar un error que rompa el turno.
   */
  const safeSetModel = async (m: Model<any>): Promise<boolean> => {
    try {
      return await pi.setModel(m);
    } catch (err) {
      console.error(`[auto-model-router] pi.setModel no disponible (${m.provider}/${m.id}):`, err);
      return false;
    }
  };

  // -----------------------------------------------------------------------
  // message_end — registra uso/coste + detecta errores de provider
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

    // Uso/coste de TODAS las respuestas (éxito o error)
    if (m.usage) {
      const modelId = typeof m.model === "string" ? m.model : m.model?.id;
      if (m.provider && modelId) recordUsage(m.provider, modelId, m.usage);
    }

    // Salud: solo errores clasificables
    if (m.stopReason !== "error" && !m.errorMessage) return;
    const provider = m.provider ?? ctx.model?.provider;
    if (!provider) return;
    const reason = classifyError(m.errorMessage ?? "");
    if (!reason) return;
    degradeProvider(ctx, provider, reason, m.errorMessage ?? "");

    // 🚑 Rescate a mitad de turno: error recuperable → siguiente candidato
    // del tier (sano y habilitado) + reintento del mismo prompt. La salud ya
    // degradó al provider fallido, así que el reintento no vuelve a él.
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
      `🚑 Rescate: ${failedKey} falló (${reason}) → reintentando con ${nm.provider}/${nm.id} (quedan ${rescueBudget} rescates)`,
      "warning",
    );
    try {
      pi.sendUserMessage(lastPrompt);
    } catch (err) {
      console.error(`[auto-model-router] error en reintento de rescate:`, err);
    }
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
  // input — maneja prefijos !! (bypass) y @@tier (fuerza nivel)
  // -------------------------------------------------------------------------
  pi.on("input", async (event: InputEvent, _ctx) => {
    if (isSubagentProcess()) return { action: "continue" as const };
    if (event.source === "extension") return { action: "continue" as const };
    if (!enabled) return { action: "continue" as const };
    // Nuevo input de usuario real → presupuesto de rescate renovado
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
  // before_agent_start — clasifica y cambia de modelo si procede
  // -------------------------------------------------------------------------
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
    if (isSubagentProcess()) return;
    if (!enabled) return;
    // Por defecto sin rescate (pin/bypass/sin decisión); el routing lo desbloquea
    lastTurnLocked = true;

    // 📌 Pin activo: el modelo pineado manda sobre todo el routing (auto,
    // @@tier, presupuesto). Garantizamos que esté activo y salimos.
    if (pinnedModel) {
      const m = ctx.modelRegistry.find(pinnedModel.provider, pinnedModel.model);
      const current = ctx.model;
      if (m && (!current || current.provider !== m.provider || current.id !== m.id)) {
        const ok = await safeSetModel(m);
        if (ok) {
          ctx.ui.notify(`📌 Pin: ${m.provider}/${m.id}`, "info");
        } else {
          ctx.ui.notify(`❌ Pin: sin API key para ${m.provider}/${m.id}`, "error");
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
      // Señal implícita: el usuario usó !! y saltó el routing en este prompt
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
        // no crítico
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
      // Señal implícita: usuario forzó un nivel distinto al natural del router
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
      // Histéresis anti-flip-flop: bloquea bajadas prematuras
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

    // Presupuesto: techo duro si se superó el límite de sesión o día
    const clamp = clampTierToBudget(tier, cfg, sessionCost(), budgetDay.cost);
    if (clamp.over) {
      const key = clamp.reason ?? "session";
      if (!budgetNotified[key]) {
        budgetNotified[key] = true;
        ctx.ui.notify(
          `💸 Presupuesto de ${clamp.reason} superado — techo en [${cfg.budget.capTier}]` +
            (clamp.clamped ? ` (${tier} → ${clamp.tier})` : ""),
          "warning",
        );
      }
      tier = clamp.tier;
    }
    const t1 = performance.now();

    // Iteramos TODA la lista del tier: si setModel falla (sin auth, modelo
    // no disponible), caemos al siguiente candidato hasta encontrar uno.
    // En arranque en frío (primer turno, sin historial) la afinidad se omite.
    const applyAffinity = hasAssistantHistory(ctx.sessionManager);
    const candidates = orderedCandidates(cfg, tier, ctx, applyAffinity, isHealthy);
    if (candidates.length === 0) {
      warn(ctx, `tier "${tier}" sin modelos con provider habilitado`);
      return;
    }
    // Estado para el rescate a mitad de turno
    lastPrompt = prompt;
    lastCandidates = candidates;
    lastTurnLocked = false;
    const t2 = performance.now();

    const current = ctx.model;
    let chosen: { model: Model<any>; entry: ModelEntry } | null = null;
    for (const entry of candidates) {
      const m = ctx.modelRegistry.find(entry.provider, entry.model);
      if (!m) continue;

      // Ya estamos en el modelo adecuado → refrescar status y listo
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
        `tier "${tier}": no se pudo activar ningún candidato (${candidates
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
        // el nivel se clampa solo; no es crítico
      }
    }

    const totalMs = t3 - t0;
    // Ancla de histéresis: mismo tier → +1 turno; cambio (subida/bajada
    // permitida/techo de presupuesto) → nuevo ancla
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
        ? ` · 🧲 histéresis (bajada bloqueada ${activeTierTurns}/${cfg.hysteresis.minDowngradeTurns})`
        : "";
    ctx.ui.notify(
      `${force ? "🎯" : "🔀"} [${tier}] ${model.provider}/${model.id} (score ${score.toFixed(2)} · ${SIGNAL_ICONS[dominant]} ${dominant})${hystNote}`,
      "info",
    );
    setStatus(ctx);
  });

  // -------------------------------------------------------------------------
  // model_select — mantener status bar sincronizada
  // -------------------------------------------------------------------------
  pi.on("model_select", (event, ctx) => {
    if (pinnedModel) {
      ctx.ui.setStatus("auto-model", `📌 ${pinnedModel.provider}/${pinnedModel.model}`);
      return;
    }
    ctx.ui.setStatus("auto-model", `${enabled ? "🔀" : "⏸"} ${event.model.provider}/${event.model.id}`);
  });

  // -------------------------------------------------------------------------
  // session_start — estado inicial
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
        `⚠️ Providers degradados: ${degraded
          .map(([p, h]) => `${p} (${h.reason}, hasta ${new Date(h.degradedUntil).toLocaleTimeString()})`)
          .join(", ")}`,
        "warning",
      );
    }
    ctx.ui.setStatus("auto-model", enabled ? "🔀 auto-model" : "⏸ auto-model");
    ctx.ui.notify(
      `🔀 Auto Model Router ${enabled ? "activo" : "inactivo"} — ${cfg.tiers["sota+"].length}+${cfg.tiers.sota.length}+${cfg.tiers["workhorses+"].length}+${cfg.tiers.workhorses.length}+${cfg.tiers["lightweights+"].length}+${cfg.tiers.lightweights.length} modelos en ${TIER_ORDER.length} tiers. "!!" omite, "@@tier" fuerza.`,
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Comando: /auto-model
  // -------------------------------------------------------------------------
  pi.registerCommand("auto-model", {
    description:
      "Auto model router: estado/scoring, on|off, reload, config, score <texto>",
    handler: async (args: string, ctx) => {
      const cmd = (args || "").trim().split(/\s+/)[0] || "";
      const rest = (args || "").trim().slice(cmd.length).trim();

      switch (cmd) {
        case "on":
          enabled = true;
          ctx.ui.notify("🔀 Auto Model Router activado", "info");
          break;
        case "off":
          enabled = false;
          ctx.ui.notify("⏸ Auto Model Router desactivado", "info");
          break;
        case "reload":
          cfg = loadConfig(lastCwd);
          enabled = cfg.enabled;
          ctx.ui.notify(`♻️ Configuración recargada (enabled=${cfg.enabled})`, "info");
          break;
        case "config": {
          const projectPath = lastCwd ? join(lastCwd, ".pi", "auto-model.json") : null;
          const lines = [
            `Config global: ${CONFIG_PATH}`,
            projectPath
              ? `Config proyecto: ${projectPath}${existsSync(projectPath) ? " (activa)" : " (no existe — solo global)"}`
              : "Config proyecto: (sin cwd)",
            `Providers activos: ${Object.entries(cfg.providers)
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
            ctx.ui.notify("Uso: /auto-model score <texto a evaluar>", "warning");
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
            `🧪 score=${score.toFixed(3)} → tier [${tier}] · ${SIGNAL_ICONS[dominant]} ${dominant}${clamp.over ? " · 💸 presupuesto superado" : ""}\n${parts}\n→ ${picked.model ? `${picked.model.provider}/${picked.model.id}` : picked.reason}`,
            "info",
          );
          break;
        }
        case "debug": {
          const cur = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "—";
          if (!lastDecision) {
            ctx.ui.notify(
              `🔍 debug: sin decisión registrada todavía — envía un prompt y repite.
Modelo actual: ${cur} · enabled: ${enabled} · config: ${CONFIG_PATH}`,
              "info",
            );
            break;
          }
          const t = lastDecision.timing;
          const d = lastDecision.dominant;
          const ctxInfo =
            lastDecision.contextPercent === null
              ? "desconocido"
              : `${(lastDecision.contextPercent * 100).toFixed(0)}%`;
          ctx.ui.notify(
            `🔍 debug — última decisión\n` +
              `tier: [${lastDecision.tier}]${lastDecision.forced ? " (forzado)" : ""} · score ${lastDecision.score.toFixed(3)} · ${SIGNAL_ICONS[d]} ${d}\n` +
              `modelo: ${lastDecision.modelId}\n` +
              `⏱️  scoring ${t.scoringMs.toFixed(1)}ms · select ${t.selectMs.toFixed(1)}ms · setModel ${t.setModelMs.toFixed(1)}ms · total ${t.totalMs.toFixed(1)}ms\n` +
              `🧊 cold-start: ${lastDecision.coldStart ? "sí (sin afinidad)" : "no (afinidad activa)"} · ctx ${ctxInfo} · 🚑 ${rescueCount} rescates · 🧲 ancla [${activeTier ?? "—"}] ${activeTierTurns}t\n` +
              `señales: ${Object.entries(lastDecision.signals)
                .map(([k, v]) => `${k}=${v.toFixed(2)}${k === d ? " ←" : ""}`)
                .join(" ")}\n` +
              `modelo actual: ${cur} · enabled: ${enabled} · config: ${CONFIG_PATH}`,
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
            ctx.ui.notify("♻️ Salud de providers reiniciada", "info");
            break;
          }
          if (degraded.length === 0) {
            ctx.ui.notify("✅ Salud de providers: todos operativos", "info");
            break;
          }
          ctx.ui.notify(
            `🩺 Providers degradados:\n${degraded
              .map(
                ([p, h]) =>
                  `${p}: ${h.reason} (hits ${h.hits}, hasta ${new Date(h.degradedUntil).toLocaleTimeString()}) — ${h.lastError.slice(0, 120)}`,
              )
              .join("\n")}\n/auto-model health clear para reiniciar`,
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
              console.error(`[auto-model-router] error limpiando ${CALIB_LOG}:`, err);
            }
            ctx.ui.notify("🧮 Historial de calibración reiniciado", "info");
            break;
          }
          const report = analyzeCalibration(calibSamples, cfg);
          if (report.total === 0) {
            ctx.ui.notify(
              `🧮 Calibración: sin señales todavía. Usa @@tier cuando el router falle el nivel (y !! para saltarlo) — se recolectan en ${CALIB_LOG}`,
              "info",
            );
            break;
          }
          const lines: string[] = [
            `🧮 Calibración — ${report.total} señales (${report.overrides} overrides · ${report.bypasses} bypass)`,
            `  Bajo-tiros (pediste más capacidad): ${report.under} · Sobre-tiros: ${report.over}`,
          ];
          const sig = Object.entries(report.perSignal)
            .filter(([, v]) => v.under + v.over > 0)
            .map(([k, v]) => `  ${SIGNAL_ICONS[k as SignalKey]} ${k}: ↓${v.under} ↑${v.over}`);
          if (sig.length > 0) lines.push(`  Por señal dominante:\n${sig.join("\n")}`);
          if (report.weightSuggestions.length > 0) {
            lines.push(`  Sugerencias de pesos (sin aplicar):`);
            for (const w of report.weightSuggestions) {
              lines.push(
                `    ${SIGNAL_ICONS[w.signal]} ${w.signal}: ${w.from} → ${w.to} (Δ${w.delta > 0 ? "+" : ""}${w.delta})`,
              );
            }
          } else {
            lines.push(`  Pesos: sin sugerencias (señales equilibradas)`);
          }
          for (const h of report.boundaryHints) lines.push(`  ⚠️ ${h}`);
          lines.push(`  (copia los Δ a scoring.weights o /auto-model calibrate clear para reiniciar)`);
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
