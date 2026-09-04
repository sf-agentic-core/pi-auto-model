// Smoke test del scoring del Auto Model Router.
// Uso: node --experimental-strip-types extensions/auto-model-router/test-score.mjs
// (o desde el repo: node --experimental-strip-types extensions/auto-model-router/score-smoke.mjs)
import { __test } from "./index.ts";

const {
  TIER_ORDER,
  DEFAULT_CONFIG,
  computeSignals,
  weightedScore,
  resolveTier,
  pickModel,
} = __test;

const ctxStub = {
  model: undefined,
  modelRegistry: {
    find(p, id) {
      // Fingimos que todos los modelos del catálogo existen
      const known = new Set();
      for (const tier of TIER_ORDER) {
        for (const e of DEFAULT_CONFIG.tiers[tier]) known.add(`${e.provider}/${e.model}`);
      }
      return known.has(`${p}/${id}`) ? { provider: p, id, name: id } : undefined;
    },
    getAvailable() {
      // Todos los modelos del catálogo tienen auth en el stub
      const out = [];
      for (const tier of TIER_ORDER) {
        for (const e of DEFAULT_CONFIG.tiers[tier]) {
          out.push({ provider: e.provider, id: e.model, name: e.model });
        }
      }
      return out;
    },
  },
};

const cases = [
  {
    label: "trivial: 'qué es 2+2'",
    prompt: "qué es 2+2",
  },
  {
    label: "quick: 'resume esto en una línea'",
    prompt: "resume esto en una línea: el mercado está subiendo",
  },
  {
    label: "lista: 'dame una lista rápida de comandos git'",
    prompt: "dame una lista rápida de comandos git",
  },
  {
    label: "medium: 'explica cómo funciona el rate limiting'",
    prompt: "explica cómo funciona el rate limiting en una API REST",
  },
  {
    label: "code: 'implementa una función que valide emails'",
    prompt:
      "implementa una función que valide emails en TypeScript, con tests:\n```ts\nfunction isValidEmail(s: string): boolean {}\n```\narchivo: src/utils/email.ts",
  },
  {
    label: "refactor multi-paso",
    prompt:
      "refactoriza el módulo de auth. Primero lee src/auth/*.ts, luego separa la lógica de tokens en un servicio propio y actualiza los tests. Hay varios archivos implicados.",
  },
  {
    label: "critical: 'cambia el puerto en producción'",
    prompt: "cambia el puerto del servicio en producción y haz deploy, sin backup",
  },
  {
    label: "sota: 'diseña la arquitectura completa del sistema'",
    prompt:
      "diseña la arquitectura completa del sistema de pagos: escribe un informe detallado con el plan, migración de la base de datos, estrategia de seguridad y propuesta formal (RFC)",
  },
  {
    label: "debug con diff",
    prompt: "debug este fallo:\ndiff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -10,7 +10,7 @@\n me da un 500 al llamar a /api/orders",
  },
  {
    label: "sota natural: microservicio completo",
    prompt:
      "implementa un microservicio de pagos completo: diseña el esquema de base de datos, escribe los endpoints REST con validación y manejo de errores en Go, crea los tests de integración con mocks, documenta la API con OpenAPI y planifica el rollout por fases. Múltiples archivos implicados: internal/api/*.go, internal/domain/*.go, migrations/*.sql",
  },
  {
    label: "workhorse natural: refactor con contexto",
    prompt:
      "refactoriza el handler de autenticación para extraer la lógica de refresh tokens a un servicio separado. Lee primero src/auth/handler.ts, src/auth/tokens.ts y src/auth/types.ts, propón el nuevo diseño y aplica los cambios con tests actualizados.",
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const signals = computeSignals(c.prompt, 0, undefined, ["read", "bash", "edit", "write"], 0, 0);
  const score = weightedScore(signals, DEFAULT_CONFIG.scoring.weights);
  const quickIntent = /(resume|en una l[ií]nea|r[aá]pido|quick|lista r[aá]pida|tl;dr)/i.test(c.prompt);
  const tier = resolveTier(score, signals, quickIntent, DEFAULT_CONFIG.scoring.thresholds);
  const picked = pickModel(DEFAULT_CONFIG, tier, ctxStub);
  const sig = Object.entries(signals)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(" ");
  const ok = !!picked.model;
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "✅" : "❌"} [${tier.padEnd(12)}] score=${score.toFixed(3)} | ${sig}\n   "${c.label}" → ${picked.model ? `${picked.model.provider}/${picked.model.id}` : picked.reason}`,
  );
}

// --- Test 2: filtrado por providers habilitados ----------------------------
// SOTA+ con anthropic deshabilitado → cae en github-copilot/gpt-5.6-sol
// (priority 1 del mapa específico de sota+).
{
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.providers.anthropic.enabled = false;
  const picked = pickModel(cfg, "sota+", ctxStub);
  const ok =
    !!picked.model &&
    picked.model.provider === "github-copilot" &&
    picked.model.id === "gpt-5.6-sol";
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "✅" : "❌"} provider-filter: anthropic OFF en sota+ → ${picked.model ? `${picked.model.provider}/${picked.model.id}` : picked.reason}`,
  );
}

// --- Test 3: afinidad de provider (continuidad) ----------------------------
// Si el modelo actual es de google y google está en el tier, se prefiere google
// aunque anthropic tenga mayor prioridad.
{
  ctxStub.model = { provider: "google", id: "gemini-2.5-pro", name: "gemini-2.5-pro" };
  const picked = pickModel(DEFAULT_CONFIG, "workhorses+", ctxStub);
  const ok = !!picked.model && picked.model.provider === "google";
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "✅" : "❌"} affinity: modelo actual google en workhorses+ → ${picked.model ? `${picked.model.provider}/${picked.model.id}` : picked.reason}`,
  );
  ctxStub.model = undefined;
}

// --- Test 4: prioridad de provider específica por tier -----------------------
// En sota+ se prioriza google (priority 1) sobre anthropic (priority 2), a pesar
// de que el modelo actual es anthropic (la afinidad NO debe ganar a una
// prioridad explícita del tier).
{
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tierProviderPriorities = {
    "sota+": { google: 1, anthropic: 2, "github-copilot": 3, deepseek: 4 },
  };
  ctxStub.model = { provider: "anthropic", id: "claude-fable-5", name: "claude-fable-5" };
  const picked = pickModel(cfg, "sota+", ctxStub);
  const ok =
    !!picked.model && picked.model.provider === "google" && picked.model.id === "gemini-3.1-pro-preview";
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "✅" : "❌"} tier-priority: sota+ prioriza google (anthropic activo) → ${picked.model ? `${picked.model.provider}/${picked.model.id}` : picked.reason}`,
  );
  ctxStub.model = undefined;
}

// --- Test 5: override parcial + fallback a la priority general -----------------
// workhorses+ prioriza google sobre el resto del tier (anthropic baja a 2).
{
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tierProviderPriorities = {
    "workhorses+": { google: 1, anthropic: 2, "github-copilot": 3, deepseek: 4 },
  };
  const picked = pickModel(cfg, "workhorses+", ctxStub);
  const ok = !!picked.model && picked.model.provider === "google" && picked.model.id === "gemini-3.5-flash";
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "✅" : "❌"} tier-priority: workhorses+ prioriza google → ${picked.model ? `${picked.model.provider}/${picked.model.id}` : picked.reason}`,
  );
}

// --- Test 6: tier sin mapa específico → usa la priority general ----------------
// sota sin mapa: general github-copilot=1 → gpt-5.6-terra, no google.
{
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tierProviderPriorities = { "workhorses+": { google: 1 } }; // sota NO está en el mapa
  const picked = pickModel(cfg, "sota", ctxStub);
  const ok = !!picked.model && picked.model.provider === "github-copilot" && picked.model.id === "gpt-5.6-terra";
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "✅" : "❌"} tier-priority-fallback: sota sin mapa → general copilot → ${picked.model ? `${picked.model.provider}/${picked.model.id}` : picked.reason}`,
  );
}

// --- Test 7: arranque en frío (sin historial) → sin afinidad -------------------
// Primer turno: aunque el modelo actual sea google, la priority general manda
// (github-copilot=1) → gpt-5.3-codex, no gemini-2.5-pro.
{
  ctxStub.model = { provider: "google", id: "gemini-2.5-pro", name: "gemini-2.5-pro" };
  const picked = pickModel(DEFAULT_CONFIG, "workhorses+", ctxStub, false);
  const ok =
    !!picked.model && picked.model.provider === "github-copilot" && picked.model.id === "gpt-5.3-codex";
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "✅" : "❌"} cold-start: sin historial → priority pura → ${picked.model ? `${picked.model.provider}/${picked.model.id}` : picked.reason}`,
  );
  ctxStub.model = undefined;
}

// --- Test 8: hasAssistantHistory -------------------------------------------------
{
  const noHistory = { getEntries: () => [{ type: "message", message: { role: "user" } }] };
  const withHistory = {
    getEntries: () => [
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant" } },
    ],
  };
  const ok = __test.hasAssistantHistory(noHistory) === false && __test.hasAssistantHistory(withHistory) === true;
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} hasAssistantHistory: sin assistant → false, con assistant → true`);
}

// --- Test 9: classifyError (salud de providers) ---------------------------------
{
  const cases = [
    ["429 Too Many Requests", "rate-limit"],
    ["Error: 429 You have exceeded your quota", "rate-limit"],
    ["Authentication failed: invalid API key (401)", "auth"],
    ["Gemini API has not been used in project X or it is disabled. SERVICE_DISABLED", "auth"],
    ["502 Bad Gateway from upstream", "server"],
    ["Request timed out after 60s", "network"],
    ["fetch failed: ECONNREFUSED", "network"],
    ["context_length_exceeded: prompt too long", null],
    ["", null],
  ];
  let ok = true;
  for (const [err, expected] of cases) {
    const got = __test.classifyError(err);
    if (got !== expected) {
      ok = false;
      console.log(`  ❌ classifyError(${JSON.stringify(err)}) → ${got}, esperado ${expected}`);
    }
  }
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} classifyError: 9 casos (auth/rate-limit/server/network/context/empty)`);
}

// --- Test 10: filtrado por salud + cooldown -------------------------------------
{
  const now = Date.now();
  const health = {
    google: { degradedUntil: now + 600_000, reason: "auth", lastError: "403", hits: 1 },
    deepseek: { degradedUntil: now - 1_000, reason: "server", lastError: "502", hits: 2 }, // expirado
  };
  const ok =
    __test.isProviderHealthy(health, "google", now) === false &&
    __test.isProviderHealthy(health, "deepseek", now) === true &&
    __test.isProviderHealthy(health, "anthropic", now) === true;
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} isProviderHealthy: degradado activo / cooldown expirado / sano`);

  // workhorses+ con google degradado → cae en github-copilot/gpt-5.3-codex (priority 1)
  const picked = pickModel(DEFAULT_CONFIG, "workhorses+", ctxStub, true, (p) =>
    __test.isProviderHealthy(health, p, now),
  );
  const ok2 =
    !!picked.model && picked.model.provider === "github-copilot" && picked.model.id === "gpt-5.3-codex";
  ok2 ? pass++ : fail++;
  console.log(
    `${ok2 ? "✅" : "❌"} health-filter: google degradado en workhorses+ → ${picked.model ? `${picked.model.provider}/${picked.model.id}` : picked.reason}`,
  );
}

// --- Test 11: señal dominante ---------------------------------------------------
{
  const sCrit = computeSignals(
    "cambia el puerto del servicio en producción y haz deploy, sin backup",
    0,
    undefined,
    ["read", "bash", "edit", "write"],
    0,
    0,
  );
  const sCode = computeSignals(
    "implementa una función que valide emails en TypeScript con tests:\n```ts\nfunction isValidEmail(s: string): boolean {}\n```\narchivo: src/utils/email.ts",
    0,
    undefined,
    ["read", "bash", "edit", "write"],
    0,
    0,
  );
  const w = DEFAULT_CONFIG.scoring.weights;
  const dCrit = __test.dominantSignal(sCrit, w);
  const dCode = __test.dominantSignal(sCode, w);
  const ok = dCrit === "criticality" && dCode === "code";
  ok ? pass++ : fail++;
  console.log(
    `${ok ? "✅" : "❌"} dominantSignal: crítico→${dCrit}, código→${dCode} (esperado criticality/code)`,
  );
}

// --- Test 12: agregación de uso y mapeo a tier ----------------------------------
{
  const acc = {};
  __test.aggregateUsage(acc, "github-copilot", "gpt-5.6-terra", {
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
    totalTokens: 165,
    cost: 0.01,
  });
  __test.aggregateUsage(acc, "github-copilot", "gpt-5.6-terra", {
    input: 200,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 300,
    cost: 0.02,
  });
  const u = acc["github-copilot/gpt-5.6-terra"];
  const ok1 =
    u.calls === 2 && u.inputTokens === 300 && u.outputTokens === 150 && u.totalTokens === 465 && Math.abs(u.cost - 0.03) < 1e-9;
  ok1 ? pass++ : fail++;
  console.log(`${ok1 ? "✅" : "❌"} aggregateUsage: 2 llamadas acumuladas correctamente`);

  const t1 = __test.tierForModel(DEFAULT_CONFIG, "github-copilot", "gpt-5.6-terra");
  const t2 = __test.tierForModel(DEFAULT_CONFIG, "google", "no-existe");
  const ok2 = t1 === "sota" && t2 === "unknown";
  ok2 ? pass++ : fail++;
  console.log(`${ok2 ? "✅" : "❌"} tierForModel: gpt-5.6-terra→sota, desconocido→unknown`);
}

// --- Test 13: techo de presupuesto -------------------------------------------------
{
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.budget = { maxCostPerSession: 0.5, maxCostPerDay: 2.0, capTier: "workhorses" };

  // Bajo presupuesto → sin cambios
  const ok1 = __test.clampTierToBudget("sota", cfg, 0.1, 0.5);
  const pass1 = ok1.tier === "sota" && !ok1.over && !ok1.clamped;
  pass1 ? pass++ : fail++;
  console.log(`${pass1 ? "✅" : "❌"} budget: bajo límite → sin clamp (${ok1.tier})`);

  // Sesión superada → sota baja a workhorses
  const ok2 = __test.clampTierToBudget("sota", cfg, 0.6, 0.5);
  const pass2 = ok2.tier === "workhorses" && ok2.over && ok2.clamped && ok2.reason === "session";
  pass2 ? pass++ : fail++;
  console.log(`${pass2 ? "✅" : "❌"} budget: sesión superada → sota→workhorses (${ok2.tier})`);

  // Ya por debajo del techo → sin clamp pero over=true
  const ok3 = __test.clampTierToBudget("lightweights", cfg, 0.6, 0.5);
  const pass3 = ok3.tier === "lightweights" && ok3.over && !ok3.clamped;
  pass3 ? pass++ : fail++;
  console.log(`${pass3 ? "✅" : "❌"} budget: ya bajo techo → sin clamp (${ok3.tier})`);

  // Deshabilitado (0) → nunca aplica
  const cfgOff = structuredClone(DEFAULT_CONFIG);
  cfgOff.budget = { maxCostPerSession: 0, maxCostPerDay: 0, capTier: "workhorses" };
  const ok4 = __test.clampTierToBudget("sota", cfgOff, 99, 99);
  const pass4 = ok4.tier === "sota" && !ok4.over;
  pass4 ? pass++ : fail++;
  console.log(`${pass4 ? "✅" : "❌"} budget: deshabilitado → sin clamp (${ok4.tier})`);
}

// --- Test 14: parsePinSpec --------------------------------------------------------
{
  const ok =
    JSON.stringify(__test.parsePinSpec("anthropic/claude-opus-4-8")) ===
      JSON.stringify({ provider: "anthropic", model: "claude-opus-4-8" }) &&
    JSON.stringify(__test.parsePinSpec("  github-copilot / gpt-5.6-sol ")) ===
      JSON.stringify({ provider: "github-copilot", model: "gpt-5.6-sol" }) &&
    __test.parsePinSpec("sin-slash") === null &&
    __test.parsePinSpec("/model") === null &&
    __test.parsePinSpec("provider/") === null &&
    __test.parsePinSpec("") === null;
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} parsePinSpec: formatos válidos e inválidos`);
}

// --- Test 15: mergeConfigs (proyecto > global > defaults) -------------------------
{
  const globalObj = {
    providers: { anthropic: { enabled: false, priority: 9 }, google: { enabled: false } },
    tiers: { "sota+": [{ provider: "google", model: "gemini-X", thinking: "high" }] },
    budget: { maxCostPerSession: 1.0 },
  };
  const projectObj = {
    providers: { anthropic: { priority: 2 } },
    tiers: { sota: [{ provider: "deepseek", model: "deepseek-v4-pro", thinking: "high" }] },
    budget: { maxCostPerSession: 0.25 },
  };
  const cfg = __test.mergeConfigs(globalObj, projectObj);
  const ok =
    cfg.providers.anthropic.enabled === false && // global gana (proyecto no lo toca)
    cfg.providers.anthropic.priority === 2 && // proyecto gana
    cfg.providers.google.enabled === false && // global
    cfg.providers.deepseek.enabled === true && // default intacto
    cfg.tiers["sota+"][0].model === "gemini-X" && // global reemplazó el tier
    cfg.tiers.sota.length === 1 && cfg.tiers.sota[0].model === "deepseek-v4-pro" && // proyecto
    cfg.tiers.workhorses.length === 4 && // default intacto
    cfg.budget.maxCostPerSession === 0.25 && // proyecto gana
    cfg.budget.capTier === "workhorses" && // default intacto
    cfg.tierProviderPriorities.sota !== undefined; // default intacto
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} mergeConfigs: proyecto > global > defaults`);
}

// --- Test 16: nextRescueCandidate ------------------------------------------------
{
  const candidates = [
    { provider: "a", model: "m1", thinking: "high" },
    { provider: "b", model: "m2", thinking: "high" },
    { provider: "c", model: "m3", thinking: "high" },
  ];
  const ok =
    __test.nextRescueCandidate(candidates, "a/m1", () => true, () => true)?.model === "m2" &&
    __test.nextRescueCandidate(candidates, "b/m2", () => true, () => true)?.model === "m3" &&
    __test.nextRescueCandidate(candidates, "c/m3", () => true, () => true) === undefined &&
    __test.nextRescueCandidate(candidates, "a/m1", (p) => p !== "b", () => true)?.model === "m3" && // b no sano → salta
    __test.nextRescueCandidate(candidates, "a/m1", () => true, (p) => p !== "b")?.model === "m3" && // b deshabilitado → salta
    __test.nextRescueCandidate(candidates, "zz/zz", () => true, () => true) === undefined;
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} nextRescueCandidate: siguiente sano/habilitado tras el fallido`);
}

// --- Test 17: histéresis anti-flip-flop -------------------------------------------
{
  const H = __test.hysteresisTier;
  const ok =
    // sin ancla → sin cambios
    !H("workhorses", null, 0, 2).blocked &&
    // misma capacidad → sin bloqueo
    !H("workhorses", "workhorses", 3, 2).blocked &&
    // subida → inmediata
    !H("sota", "workhorses", 0, 2).blocked &&
    // bajada con turnos < min → bloqueada y mantiene el ancla
    H("lightweights", "sota", 1, 2).blocked && H("lightweights", "sota", 1, 2).tier === "sota" &&
    // bajada con turnos >= min → permitida
    !H("lightweights", "sota", 2, 2).blocked && H("lightweights", "sota", 2, 2).tier === "lightweights" &&
    // min=0 → deshabilitado
    !H("lightweights", "sota", 0, 0).blocked;
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} hysteresisTier: bloquea bajadas prematuras, subidas inmediatas`);
}

// --- Test 18: analyzeCalibration ---------------------------------------------------
{
  const cfg = structuredClone(DEFAULT_CONFIG);
  const mk = (o) => ({
    ts: 1,
    excerpt: "",
    routerTier: o.routerTier,
    score: o.score,
    dominant: o.dominant,
    ...(o.forcedTier ? { kind: "override", forcedTier: o.forcedTier } : { kind: "bypass" }),
  });
  const samples = [
    mk({ routerTier: "workhorses", forcedTier: "sota", score: 0.4, dominant: "code" }), // bajo-tiro code
    mk({ routerTier: "workhorses", forcedTier: "sota", score: 0.42, dominant: "code" }), // bajo-tiro code
    mk({ routerTier: "lightweights+", forcedTier: "workhorses", score: 0.3, dominant: "code" }), // bajo-tiro code
    mk({ routerTier: "sota", forcedTier: "workhorses", score: 0.7, dominant: "criticality" }), // sobre-tiro criticality
    mk({ routerTier: "lightweights", forcedTier: "lightweights", score: 0.1, dominant: "output" }), // sin cambio → ignorado
    mk({ routerTier: "lightweights", score: 0.1, dominant: "output" }), // bypass
  ];
  const r = __test.analyzeCalibration(samples, cfg);
  const ok =
    r.total === 6 &&
    r.overrides === 4 &&
    r.bypasses === 1 &&
    r.under === 3 &&
    r.over === 1 &&
    r.perSignal.code.under === 3 &&
    r.perSignal.criticality.over === 1 &&
    r.weightSuggestions.length === 2 &&
    Math.abs(r.weightSuggestions.find((w) => w.signal === "code").delta - 0.03) < 1e-9 &&
    Math.abs(r.weightSuggestions.find((w) => w.signal === "criticality").delta + 0.01) < 1e-9 &&
    r.boundaryHints.length === 2; // sota:workhorses (0.41<0.66) y workhorses:lightweights+ (0.3<0.36)
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} analyzeCalibration: bajo/sobre-tiros por señal + sugerencias de peso`);
}

console.log(`\n${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
