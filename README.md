# 🔀 Auto Model Router v2

Extensión global de pi que selecciona automáticamente el modelo más apropiado para
cada tarea, sin cambiar de modelo manualmente entre prompts.

## Taxonomía de niveles

| Tier            | Perfil                              | Ejemplos (default)                            |
|-----------------|-------------------------------------|-----------------------------------------------|
| `sota+`         | Frontera, razonamiento profundo     | claude-fable-5, claude-opus-4-8, gemini-3.1-pro-preview |
| `sota`          | Tareas complejas de alta calidad    | claude-sonnet-5, gemini-3-pro-preview, gpt-5.5 |
| `workhorses+`   | Trabajo de ingeniería pesado        | claude-sonnet-4-6, gemini-2.5-pro, gpt-5.3-codex, glm-5p2 |
| `workhorses`    | Desarrollo y debugging habitual     | claude-sonnet-4-5, gemini-3.5-flash, deepseek-v4-pro, kimi-k2p7-code |
| `lightweights+` | Tareas medianas de bajo coste       | claude-haiku-4-5, gemini-3-flash-preview, gpt-5.4-mini |
| `lightweights`  | Triviales (chat, listas, one-liners)| gemini-2.5-flash, gpt-5-mini, gpt-oss-20b |

Cada tier es una **lista ordenada de candidatos** `{provider, model}`. La extensión
**permuta solo sobre los providers habilitados** en la configuración: si un provider
está deshabilitado, sus modelos se descartan aunque estén listados.

## Scoring multicomponente (no trivial)

El nivel NO se decide por longitud del prompt. Se calcula un score ponderado 0..1 a
partir de 6 señales independientes:

| Señal         | Peso | Qué mide                                                                 |
|---------------|------|--------------------------------------------------------------------------|
| `structure`   | 0.15 | Tamaño estimado en tokens + imágenes adjuntas                            |
| `context`     | 0.18 | Presión del contexto de la sesión (`ctx.getContextUsage()`)              |
| `code`        | 0.22 | Densidad de código: bloques ```, diffs, rutas de archivo, verbos técnicos |
| `agentic`     | 0.15 | Profundidad agéntica: tools activas, skills, contextFiles, multi-paso    |
| `criticality` | 0.20 | Riesgo: producción, deploy, migración, seguridad, dinero, datos          |
| `output`      | 0.10 | Formato esperado: informe largo vs. una línea                            |

Reglas de piso/techo coherentes:
- **Criticality ≥ 0.7** → piso en `sota` (seguridad manda: un cambio de producción
  "rápido" sigue mereciendo un modelo serio).
- **Intención explícita de rapidez** (`rápido`, `en una línea`, `tl;dr`…) → techo en
  `workhorses` (no gastar SOTA en trivialidades).
- El piso de criticality **gana** al techo de rapidez.

## Selección dentro del tier

1. Se filtran los candidatos por **providers habilitados**.
2. **Prioridad del provider**: la prioridad efectiva de cada provider es la del
   mapa `tierProviderPriorities[tier]` si existe (por provider, con fallback a
   la general para los no listados), o la `priority` general de `providers` si
   el tier no tiene mapa específico.
3. **Afinidad del provider** (desempate): si el modelo actual pertenece a un
   provider de este tier, se prefiere ese candidato (continuidad de provider →
   mejor prompt caching). OJO: si el tier tiene `tierProviderPriorities`
   explícito, la prioridad específica MANDA y la afinidad solo desempata.
4. **Orden de lista** como último criterio.

`pi.setModel()` falla silenciosamente si no hay API key → se intenta el siguiente
candidato. Si ninguno es usable, se mantiene el modelo actual (no se rompe nada).
Además, `pickModel` prefiltra por providers con auth configurada
(`modelRegistry.getAvailable()`), así que un provider habilitado en la config pero
sin key en el box nunca bloquea el routing.

## Uso — dónde y cómo se usa cada control

> **Importante:** los controles de la extensión solo existen si la extensión está
> cargada. Tras instalar o actualizar la extensión, ejecuta **`/reload`** en la
> sesión de pi (o reinicia pi) para que se cargue y aparezca `/auto-model` en el
> autocompletado de comandos.

### 🖱️ Slash commands (se escriben en la barra de input de pi, con autocompletado)

| Comando | Dónde/Qué hace |
|---|---|
| `/auto-model` | Estado: ON/OFF, modelo actual, último tier + desglose de scoring |
| `/auto-model on` | Activa el routing automático (solo esta sesión) |
| `/auto-model off` | Desactiva el routing (solo esta sesión) — eliges el modelo a mano |
| `/auto-model reload` | Recarga `~/.pi/agent/auto-model.json` desde disco sin reiniciar |
| `/auto-model config` | Muestra providers activos, tiers efectivos y prioridades por tier |
| `/auto-model score <texto>` | Simula el scoring con un texto de ejemplo → tier + modelo (sin enviar nada) |
| `/auto-model debug` | Diagnóstico de la última decisión: timing del router (scoring/select/setModel/total en ms), arranque en frío sí/no, % de contexto ocupado, señales (la dominante marcada con ←), ruta de config |
| `/auto-model health` | Estado de salud de los providers; `/auto-model health clear` reinicia la salud |
| `/auto-model usage` | Dashboard de uso y coste (total/tier/top modelos + sesión actual); `/auto-model usage clear` reinicia |
| `/auto-model pin <provider/model>` | Fija un modelo manualmente (bloquea el router hasta `/auto-model unpin`) |
| `/auto-model unpin` | Retira el pin y el router reanuda su selección |
| `/model` | Comando nativo de pi: selector interactivo para cambiar de modelo a mano |

### ⌨️ Prefijos de prompt (se escriben al inicio de un mensaje NORMAL, no con `/`)

| Prefijo | Ejemplo | Qué hace |
|---|---|---|
| `!!` | `!! explícame X` | Omite el router **este turno** — pi usa el modelo activo |
| `@@tier` | `@@sota+ diseña la arquitectura` | Fuerza un nivel concreto este turno (`@@sota`, `@@workhorses+`, `@@lightweights`, …) |

Estos prefijos se procesan en el evento `input` de la extensión y se eliminan del
prompt antes de llegar al modelo.

### 🎛️ Otras vías

| Vía | Qué hace |
|---|---|
| `Ctrl+P` | Cicla modelos en la sesión (puedes limitar el ciclo con `enabledModels` en settings.json) |
| `pi --model provider/model` | Modelo inicial al arrancar pi |
| `~/.pi/agent/auto-model.json` → `"enabled"` | ON/OFF persistente entre sesiones (se carga en cada `session_start`) |

### 🔁 Cómo alternar entre auto y manual

```
Auto ──(!! prompt)──────────► un turno manual
Auto ──(/auto-model off)────► manual indefinido ──(/auto-model on)──► Auto
Auto ──(@@sota prompt)──────► un turno forzado a ese nivel
Manual ──(enabled:true + /auto-model reload)──► Auto
```

**Ojo:** con el router ON, si cambias de modelo a mano (`/model` o `Ctrl+P`), en el
siguiente prompt sin `!!` el router reevalúa y puede volver a su elección. Para
mantener un modelo manual durante varios turnos: `/auto-model off` → eliges →
terminas → `/auto-model on`.

El estado se refleja en el status bar de pi: **`🔀`** = routing activo, **`⏸`** = parado.

Cada notificación de routing incluye la **señal dominante** — la que más contribución
ponderada aportó al score (`🚨 criticality`, `💻 code`, `🧮 context`, …):
`🔀 [sota] github-copilot/gpt-5.6-terra (score 0.66 · 🚨 criticality)`. Así la
decisión del tier deja de ser una caja negra.

El comando `/auto-model` (sin argumentos) muestra el timing de la última decisión;
`/auto-model debug` añade el detalle completo. El router en sí tarda <1ms en el
scoring y milisegundos en `setModel` — si notas segundos entre la notificación de
`session_start` y la de routing, es la preparación de arranque de pi (descubrimiento
de recursos, system prompt) en el primer turno, no el router.

### 🩺 Salud de providers (detección de fallos)

El router monitoriza errores de provider en `message_end` y los **degrada con
cooldown**: un provider con fallos se excluye del routing hasta que el cooldown
expira, y se recupera solo. Clasificación de errores y cooldowns (configurables en
`health.cooldownMs`):

| Categoría | Ejemplos | Cooldown por defecto |
|---|---|---|
| `auth` | 401/403, API key inválida, servicio deshabilitado | 1h |
| `rate-limit` | 429, quota, too many requests | 10 min |
| `server` | 502/503, overloaded | 2 min |
| `network` | timeout, ECONNREFUSED, fetch failed | 2 min |

Los errores de **contexto** (`context_length_exceeded`) NO degradan al provider
(pi los gestiona con compactación). El estado se persiste en
`~/.pi/agent/auto-model-health.json` (sobrevive a reinicios) y se muestra en la
notificación de `session_start`, en `/auto-model` y en `/auto-model health`.

### 📊 Uso y coste

Cada respuesta de assistant registra tokens y coste real (calculado por pi con los
precios del catálogo) en `~/.pi/agent/auto-model-usage.json`, acumulado por modelo.
`/auto-model usage` muestra:

- **Total** (todo el tiempo): coste, tokens y llamadas.
- **Por tier**: cuántas llamadas y coste por nivel (`sota+`…`lightweights`).
- **Top modelos**: los 5 que más coste acumulan.
- **Sesión actual**: solo esta sesión de pi.

`/auto-model usage clear` reinicia el contador.

### 💸 Presupuesto (budget cap)

Guardarraíl financiero sobre los datos de uso: cuando el coste de la **sesión** o
del **día** supera el límite configurado, el routing se **techa en `capTier`**
(nivel de capacidad máximo permitido). Es un guardarraíl duro: aplica también a
tiers forzados con `@@tier`.

```json
"budget": {
  "maxCostPerSession": 0.5,
  "maxCostPerDay": 2.0,
  "capTier": "workhorses"
}
```

`0` en un límite = deshabilitado. El contador diario se persiste en
`~/.pi/agent/auto-model-budget.json`. Al superarse, notifica una vez
(`💸 Presupuesto de sesión superado — techo en [workhorses]`) y el estado se
refleja en `/auto-model usage`.

### 📌 Pin de modelo

`/auto-model pin <provider/model>` fija un modelo concreto y **bloquea el router**
hasta `/auto-model unpin`: ni el scoring, ni `@@tier`, ni el presupuesto cambian de
modelo mientras esté activo (el pin es prioridad máxima). Útil para sesiones donde
quieres control total (p.ej. debugging con un modelo específico). El pin es por
sesión (se resetea al reiniciar pi) y el status bar muestra `📌`.

**Precedencia de decisión**: `pin` (manual, gana a todo) → `presupuesto` (guardarraíl
financiero) → `@@tier` (fuerza nivel) → scoring automático.

### 🎯 Harness de evaluación (corpus etiquetado)

`eval-score.mjs` ejecuta el pipeline estático del classifier (`classifyPrompt`,
determinista: sin salud/presupuesto/histéresis) sobre `eval-corpus.json` y reporta
**accuracy exacta, banda ±1, precision/recall por tier y matriz de confusión**.

```
node --experimental-strip-types extensions/auto-model-router/eval-score.mjs
```

El corpus tiene dos secciones:

- **`regression`**: comportamiento actual considerado correcto → **gate de CI**
  (salida no-cero si exacta < `EVAL_ACCURACY_MIN` (0.9) o banda < `EVAL_BAND_MIN` (0.95)).
- **`aspirational`**: casos donde el classifier **bajo-tira** (tareas pesadas con los
  pesos actuales) → se reportan como gaps documentados sin romper CI — son los
  candidatos a calibración (#9).

El CI (`auto-model-router.yml`) ejecuta smoke + eval en cada PR que toque la
extensión, así un cambio de pesos/umbrales/regex que altere decisiones queda
detectado (y los gaps aspirational se cierran cuando la calibración los resuelve).

### 🧮 Bucle de calibración (señales implícitas)

Cada corrección tuya es una señal de calibración, registrada en
`~/.pi/agent/auto-model-calibration.jsonl` (JSONL, últimas 1000):

- **`@@tier`** forzado → `override`: el nivel natural que el router habría elegido
  vs. el que pediste, con score y señal dominante.
- **`!!`** → `bypass`: el prompt donde saltaste el routing (y el tier natural).

`/auto-model calibrate` analiza esas señales y **sugiere** (sin aplicar):

- Bajo-tiros (pediste más capacidad que el router) y sobre-tiros por señal dominante.
- **Deltas de peso** por señal (`code: 0.25 → 0.28`): más bajo-tiros que sobre-tiros
  en una señal → sube su peso (Δ ±0.01 por muestra, tope ±0.06).
- **Hints de frontera**: si forzaste `sota` con scores muy por debajo del threshold
  (0.66), el umbral puede estar alto.

Ejemplo:
```
🧮 Calibración — 12 señales (9 overrides · 3 bypass)
  Bajo-tiros: 6 · Sobre-tiros: 3
  💻 code: ↓5 ↑1 → sugiere +0.04
  🚨 criticality: ↓1 ↑2 → sugiere -0.01
  ⚠️ 4 subida(s) forzada(s) a sota (score medio 0.44) — threshold de sota (0.66) puede estar alto
```

Aplica los Δ copiándolos a `scoring.weights` en tu `auto-model.json` (o `.pi/` del
proyecto) y valida con el harness de evaluación (`eval-score.mjs`) — los cambios
que rompan la regression se detectan en CI. `/auto-model calibrate clear` reinicia
el historial.

### 🧲 Histéresis anti-flip-flop

Evita que el router oscile entre tiers en turnos consecutivos (prompt duro → sota,
prompt trivial → lightweights, vuelta a sota…): para **bajar** de tier, el tier
actual debe haberse mantenido al menos `hysteresis.minDowngradeTurns` turnos
rutados; las **subidas son siempre inmediatas** (una tarea dura merece el modelo
fuerte ya). Al bloquearse una bajada, la notificación lo indica
(`🧲 histéresis (bajada bloqueada 1/2)`). `0` deshabilita; el ancla actual aparece
en `/auto-model debug`.

### 🚑 Rescate a mitad de turno

Si el modelo elegido falla con un error recuperable (auth/429/5xx/timeout/modelo
no disponible), el router **degrada al provider** (salud) y **reintenta el mismo
prompt con el siguiente candidato del tier** (sano y habilitado). Máximo 2 rescates
por prompt de usuario real; el reintento no vuelve al modelo fallido porque ya está
degradado. Los errores de contexto (`context_length_exceeded`) NO disparan rescate
(pi los resuelve con compactación). No aplica con `pin` activo ni en turnos con
`!!`. El contador de rescates aparece en `/auto-model debug`.

### 🗂️ Config por proyecto

Además de la config global (`~/.pi/agent/auto-model.json`), cada proyecto puede
llevar su propia config en **`.pi/auto-model.json`** (se carga solo en proyectos de
confianza). La config efectiva es:

```
defaults embebidos → global (~/.pi/agent) → proyecto (./.pi)
```

El merge es profundo por clave: el proyecto solo sobreescribe lo que defina, el
resto cae a la global y a los defaults. Útil para tu ecosistema multirepo —
un dominio conservador puede pinar providers/tiers sin tocar la config global.
`/auto-model config` muestra ambas rutas y si la de proyecto está activa.

## Configuración

`~/.pi/agent/auto-model.json` (opcional). Ver `config.example.json` de este
directorio. La configuración se recarga en `session_start` y con `/auto-model reload`.

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
    "sota+": { "anthropic": 1, "google": 2 },
    "workhorses+": { "google": 1 }
  },
  "scoring": {
    "weights": {
      "structure": 0.15, "context": 0.18, "code": 0.22,
      "agentic": 0.15, "criticality": 0.2, "output": 0.1
    },
    "thresholds": {
      "sota+": 0.82, "sota": 0.66, "workhorses+": 0.5,
      "workhorses": 0.36, "lightweights+": 0.2, "lightweights": 0
    }
  }
}
```

> **Nota de modelo:** el campo `thinking` fija el nivel de thinking al seleccionar
> ese modelo. Los niveles no soportados por el modelo se clampan automáticamente.
>
> **`tierProviderPriorities`** (opcional): prioridades de provider **específicas
> por nivel**. Sobrescriben la `priority` general SOLO para ese tier; los
> providers no listados en el mapa de un tier usan su priority general; los tiers
> sin mapa usan la general para todos. Cuando un tier tiene mapa explícito, esa
> prioridad manda sobre la afinidad de provider (la afinidad solo desempata).
> Ejemplo: en `sota+` priorizar anthropic y en `workhorses+` priorizar google.

## Instalación

La extensión vive en `core-agent-library/extensions/auto-model-router/` y se
despliega como symlink a `~/.pi/agent/extensions/` mediante
`scripts/setup.sh` (deploy automático de extensiones gestionadas).

## Releases automatizadas (Release Please)

Los releases se gestionan automáticamente con
[Release Please](https://github.com/googleapis/release-please) mediante el
workflow `.github/workflows/release.yml`. Al hacer push a `main`, Release
Please analiza los commits y:

- Abre (o actualiza) un **PR de release** con el bump de versión en
  `package.json` y `.release-please-manifest.json`, un `CHANGELOG.md`
  generado y las notas del release. También abre PRs separados para
  dependencias si existen (`chore(deps)`).
- Al **mergear el PR de release**, crea el tag `vX.Y.Z` y el **GitHub
  Release** correspondiente.

Para que esto funcione, los commits en `main` deben seguir
[Conventional Commits](https://www.conventionalcommits.org/) (el repositorio
usa merge/squash de PRs):

| Tipo de commit        | Efecto en la versión                     |
|-----------------------|------------------------------------------|
| `feat: ...`           | bump **minor** (`0.1.0` → `0.2.0`)       |
| `fix: ...`            | bump **patch** (`0.1.0` → `0.1.1`)       |
| `feat!:` / `BREAKING CHANGE` | bump **major** (`0.1.0` → `1.0.0`) |
| `chore:`, `docs:`, `refactor:`, `test:`, etc. | sin release |

Reglas prácticas:

- El asunto del commit debe tener el formato `tipo(alcance): descripción`
  (p. ej. `feat(scoring): añade señal de output`).
- Para un cambio que rompe compatibilidad, añade `!` tras el tipo o un pie
  con `BREAKING CHANGE: descripción`.
- Prefiere **squash merge** para que el PR de release vea un único commit
  con el tipo correcto.
- El PR de release es de Release Please: no lo edites a mano; solo
  revísalo y mergealo.
