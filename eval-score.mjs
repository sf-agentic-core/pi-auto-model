// Harness de evaluación del classifier del auto-model-router.
//
// Dos secciones en eval-corpus.json:
//  - "regression": comportamiento actual considerado correcto → gate de CI.
//  - "aspirational": casos donde el classifier bajo-tira (pesos actuales);
//    se reportan como gaps documentados, NO rompen CI.
//
// Métricas: accuracy exacta, banda ±1, precision/recall por tier.
//
// Uso:
//   node --experimental-strip-types extensions/auto-model-router/eval-score.mjs
// Salida no-cero si exact < EVAL_ACCURACY_MIN (default 0.9) o banda < 0.95.
import { readFileSync } from "node:fs";
import { __test } from "./index.ts";

const MIN_ACCURACY = Number(process.env.EVAL_ACCURACY_MIN ?? 0.9);
const MIN_BAND = Number(process.env.EVAL_BAND_MIN ?? 0.95);
const TIERS = __test.TIER_ORDER;
const idxOf = Object.fromEntries(TIERS.map((t, i) => [t, i]));

const data = JSON.parse(
  readFileSync(new URL("./eval-corpus.json", import.meta.url), "utf-8"),
);
const regression = data.regression ?? [];
const aspirational = data.aspirational ?? [];

function usageOf(entry) {
  return entry.contextPercent != null
    ? { tokens: 0, contextWindow: 1, percent: entry.contextPercent }
    : undefined;
}

// --- Regression: gate de CI -------------------------------------------------
let exact = 0;
let band = 0;
const total = regression.length;
const confusion = {};
const failures = [];

for (const c of regression) {
  const { tier, score } = __test.classifyPrompt(c.prompt, __test.DEFAULT_CONFIG, usageOf(c));
  const expected = c.expected;
  (confusion[expected] ??= {});
  confusion[expected][tier] = (confusion[expected][tier] ?? 0) + 1;
  const dist = Math.abs(idxOf[tier] - idxOf[expected]);
  if (tier === expected) exact++;
  if (dist <= 1) band++;
  if (tier !== expected) {
    failures.push({
      id: c.id,
      expected,
      got: tier,
      score: score.toFixed(3),
      dist,
      prompt: c.prompt.slice(0, 90).replace(/\n/g, " "),
    });
  }
}

console.log(`=== Eval classifier auto-model-router ===`);
console.log(
  `regression (${total}): exacta ${((exact / total) * 100).toFixed(1)}% (${exact}/${total}) · banda ±1 ${((band / total) * 100).toFixed(1)}%`,
);

console.log("\n--- Precision/recall por tier (regression) ---");
for (const t of TIERS) {
  const tp = confusion[t]?.[t] ?? 0;
  const predicted = TIERS.reduce((acc, p) => acc + (confusion[p]?.[t] ?? 0), 0);
  const actual = TIERS.reduce((acc, e) => acc + (confusion[t]?.[e] ?? 0), 0);
  const precision = predicted ? (tp / predicted) * 100 : null;
  const recall = actual ? (tp / actual) * 100 : null;
  console.log(
    `  ${t.padEnd(13)} P=${precision === null ? "—" : precision.toFixed(0) + "%"} R=${recall === null ? "—" : recall.toFixed(0) + "%"} (n=${actual})`,
  );
}

if (failures.length > 0) {
  console.log("\n--- Fallos de regression ---");
  for (const f of failures) {
    console.log(`  [${f.id}] esperado ${f.expected} · got ${f.got} · dist ${f.dist} · score ${f.score}\n      "${f.prompt}"`);
  }
}

// --- Aspirational: gaps documentados (no rompen CI) -------------------------
if (aspirational.length > 0) {
  console.log("\n--- Gaps aspirational (el classifier bajo-tira; candidatos a calibración #9) ---");
  for (const c of aspirational) {
    const { tier, score } = __test.classifyPrompt(c.prompt, __test.DEFAULT_CONFIG, usageOf(c));
    const ok = tier === c.ideal;
    console.log(
      `  ${ok ? "✅" : "⚠️"} [${c.id}] ideal ${c.ideal} · got ${tier} (score ${score.toFixed(3)})${ok ? "" : ` · dist ${Math.abs(idxOf[tier] - idxOf[c.ideal])}`}`,
    );
    if (!ok && c.note) console.log(`       nota: ${c.note}`);
  }
}

const acc = total ? exact / total : 0;
const bandAcc = total ? band / total : 0;
const pass = acc >= MIN_ACCURACY && bandAcc >= MIN_BAND;
console.log(
  `\n${pass ? "✅" : "❌"} exacta ${(acc * 100).toFixed(1)}% >= ${(MIN_ACCURACY * 100).toFixed(0)}% y banda ${(bandAcc * 100).toFixed(1)}% >= ${(MIN_BAND * 100).toFixed(0)}%`,
);
process.exit(pass ? 0 : 1);
