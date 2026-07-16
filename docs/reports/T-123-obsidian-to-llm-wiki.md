---
type: research
task: T-123
date: 2026-07-16
status: delivered
inbox_item: i_01kxntg4yfatc5c99e
---

# T-123: Alimentar llm-wiki desde una fuente Obsidian

> Reporte de investigación. Entregable principal publicado en inbox (`i_01kxntg4yfatc5c99e`).
> Este fichero es el artefacto versionado equivalente para trazabilidad en el repo.

## Resumen ejecutivo

omp-deck ya implementa Karpathy-style llm-wiki sobre cualquier directorio de Markdown con
frontmatter YAML y `[[wikilinks]]`. Un vault de Obsidian es compatible en ≥95% con el
formato que `KbService` ya consume: misma sintaxis de wikilinks, mismo esquema de
frontmatter, mismo YAML. La integración más directa — apuntar `OMP_DECK_KB_ROOT` al vault —
requiere añadir `.obsidian` a la lista de exclusión y cero código adicional. Las únicas
funciones de Obsidian que hoy no se indexan (tags inline, aliases, block refs) son mejoras
no bloqueantes. **Recomendación: implementar el montaje directo (Opción A), con una tarea de
seguimiento pequeña para las tres deltas de parsing.**

---

## Estado actual de llm-wiki en omp-deck

### Cómo se alimenta hoy

| Paso | Código | Comportamiento |
|------|--------|----------------|
| Resolución de raíz | `resolveKbRoot()` en `kb-service.ts` | Lee `OMP_DECK_KB_ROOT`; por defecto `~/kb` |
| Instanciación | `new KbService({ root: resolveKbRoot() })` en `index.ts` | Constructor solo almacena la ruta absoluta; sin validación |
| Índice (lazy) | `ensureIndex()` → `buildIndex()` → `walk()` | Walk recursivo al primer request; sólo indexa `.md` |
| Filtrado | `SKIP_DIR_NAMES` + `OMP_DECK_KB_EXCLUDE_DIRS` (CSV env) | Hardcoded: `.git`, `node_modules`, `.venv`, `dist`, `build`, etc. |
| Frontmatter | `parseFrontmatter()` con npm `yaml` | Extrae bloque `---…---`; tolera CRLF; devuelve `frontmatter.tags` y `frontmatter.name` |
| Wikilinks | `WIKILINK_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g` | Excluye bloques de código; soporta stem, subpath, label; ambiguous-stems protegidos |
| Protocolo `kb://` | `KbProtocolHandler` registrado en startup | El tool `read` resuelve `kb://<ruta>` contra el mismo root que el REST |
| Watcher | `startKbWatcher(kbService)` en `index.ts` | `existsSync(root)` explícito al arranque: si el root no existe, retorna no-op con `log.warn` |

### Gap de validación al arrancar

El startup **no tiene health gate**, y tiene un riesgo de enmascaramiento activo:

1. **`seedKbTemplates(resolveKbRoot())`** se ejecuta **antes** de `new KbService()`.
   Hace `mkdir(root, { recursive: true })` y escribe `README.md` + plantillas de
   `kb/system/`, `kb/integrations/`, `kb/rules/`. Si `OMP_DECK_KB_ROOT` apunta a una
   ruta inexistente (p.ej. un vault Obsidian aún sin montar), el servidor **la crea y
   la puebla con plantillas del deck** antes de que `KbService` arranque.

2. `startKbWatcher` comprueba `existsSync(root)` explícitamente. Si el root no existe
   retorna no-op inmediato con `log.warn` — no observa ningún directorio padre. Pero
   tras el seed, el root siempre existe, así que el watcher arrancará sobre el
   directorio recién creado (con plantillas, no con el vault real).

3. El primer request al cockpit devuelve `{ exists: true, fileCount: N }` donde N son
   las plantillas sembradas. El CTA de "Create starter kb" no aparece. **El usuario ve
   un kb aparentemente funcional con contenido del deck, no su vault de Obsidian.**

---

## Deltas: Obsidian vs asunciones actuales de llm-wiki

| Feature | llm-wiki/KbService | Obsidian vault | Estado |
|---------|-------------------|----------------|--------|
| Frontmatter YAML `---` | ✅ parseado con npm `yaml` | ✅ idéntico | Compatible |
| `[[wikilinks]]` stem | ✅ resolución por stem | ✅ idéntico | Compatible |
| `[[target|alias]]` labels | ✅ soportado | ✅ idéntico | Compatible |
| `frontmatter.tags: [...]` | ✅ indexado | ✅ idéntico | Compatible |
| Archivos `.md` en árbol | ✅ walk recursivo | ✅ idéntico | Compatible |
| `.obsidian/` config dir | ❌ NO en SKIP_DIR_NAMES | ✅ siempre presente | **Gap — 1 línea** |
| Tags inline `#tag` | ❌ no indexados | ✅ usados frecuentemente | Delta (nice-to-have) |
| `aliases:` frontmatter | ❌ ignorado por KbService | ✅ Obsidian los usa para resolución | Delta (nice-to-have) |
| Block refs `[[file#^blockid]]` | ❌ produce wikilink unresolved | ✅ referencia a bloque | Delta (graceful: incrementa `unresolvedCount`) |
| Archivos adjuntos (PNG, PDF…) | ✅ walk solo coge `.md` | ✅ carpeta `Assets/` | Compatible (ignorados) |
| `![[embed]]` | Regex extrae `[[embed]]` del prefijo `!` | ✅ embeds de Obsidian | Semi-gap: procesado como wikilink, `!` queda en texto |

---

## Opciones de integración evaluadas

### Opción A — Montaje directo del vault (recomendada)

Apuntar `OMP_DECK_KB_ROOT=/ruta/al/vault/obsidian` y añadir `.obsidian` a `SKIP_DIR_NAMES`.

**Cambios de código necesarios:**
- `kb-service.ts`: añadir `".obsidian"` y `".trash"` a `SKIP_DIR_NAMES` — 1 línea.
- `index.ts`: antes de `seedKbTemplates`, comprobar si el root ya contiene contenido
  del usuario (`.obsidian/` presente o `.md` pre-existentes) y omitir el seed en ese
  caso — evita el riesgo de enmascaramiento descrito arriba.

**Pros:**
- Cero latencia. Single source of truth. Watcher ya existente invalida el índice.
- Esfuerzo mínimo: 2–3 líneas de código + var de entorno.

**Contras:**
- Tags inline `#tag` no se indexan hasta implementar parser adicional.
- Aliases de Obsidian no se usan para wikilink resolution.
- Block refs generan ruido de `unresolvedCount` en logs.

**Esfuerzo:** bajo. **Mantenimiento:** mínimo. **Frescura:** inmediata.

---

### Opción B — Script de sync periódico (patrón `kb_sync.py`)

Copia y normaliza el vault Obsidian → `~/kb` en cron o pre-start hook.

**Pros:** Puede resolver todas las deltas de parsing. Desacopla el vault del deck.

**Contras:** Latencia de sync. Dual source of truth. Mantenimiento del script. Primer
sync lento en vaults grandes.

**Esfuerzo:** medio. **Mantenimiento:** alto. **Frescura:** con lag.

---

### Opción C — Watcher en tiempo real con transformación incremental

Watcher sobre el vault que en cada cambio copia y normaliza sólo el fichero modificado.

**Pros:** Frescura casi inmediata. Puede aplicar transformaciones incrementales.

**Contras:** Dual source of truth. Casos edge complejos (renombrados, borrados).
Implementación más compleja.

**Esfuerzo:** alto. **Mantenimiento:** alto. **Frescura:** buena.

---

## Recomendación

**Implementar Opción A (montaje directo).**

El único gap bloqueante es `.obsidian/` en la lista de exclusión (1 línea). El riesgo
principal es el enmascaramiento de `seedKbTemplates` ante un path incorrecto, resoluble
con una comprobación de 5 líneas. El resto son deltas deferibles. Las Opciones B y C
añaden complejidad operacional sin beneficio material.

---

## Riesgos y preguntas abiertas

1. **`seedKbTemplates` ante path incorrecto**: si `OMP_DECK_KB_ROOT` está mal, el
   servidor crea el directorio y siembra plantillas, enmascarando la misconfiguration.
2. **Escritura bidireccional concurrente**: last-write-wins. Riesgo bajo en uso típico.
3. **Obsidian Sync / iCloud**: ficheros de conflicto aparecerán en el árbol del cockpit.
   Cubiertos por `OMP_DECK_KB_EXCLUDE_DIRS` si se nombran.
4. **Tags inline**: `#tag` en cuerpo no se indexan. ¿Bloqueante para el caso concreto?
5. **Aliases de wikilinks**: ¿cuántos links dependen de resolución por alias en el vault?

---

## Prerrequisitos y siguientes pasos

### Prerrequisitos

- [ ] Confirmar ruta del vault Obsidian objetivo (`OMP_DECK_KB_ROOT=?`).
- [ ] Verificar que el vault ya existe en esa ruta antes de arrancar el servidor.
- [ ] Medir porcentaje de tags inline vs frontmatter tags en el vault real.
- [ ] Decidir si aliases son blocking o deferrable.
- [ ] Verificar si Obsidian Sync está activo.

### Pasos accionables (Opción A)

1. **T-nueva (bajo, ~30 min)**: Añadir `".obsidian"` y `".trash"` a `SKIP_DIR_NAMES`
   en `kb-service.ts`. Documentar `OMP_DECK_KB_EXCLUDE_DIRS` en `docs/configuration.md`.
2. **T-nueva (bajo, ~30 min)**: Guard en `seedKbTemplates` — omitir seed si el root
   apunta a un vault externo (presencia de `.obsidian/` o `.md` pre-existentes).
3. **T-nueva (bajo, ~15 min)**: Log ERROR en `index.ts` si el root configurado no
   existe tras el seed (actualmente sólo `log.warn` en el watcher).
4. **Configurar**: Setear `OMP_DECK_KB_ROOT=/ruta/vault` en el entorno de arranque.
5. **T-nueva (medio, deferrable, ~2–4h)**: Parser de tags inline `#tag`.
6. **T-nueva (medio, deferrable, ~3–5h)**: Soporte de `aliases:` frontmatter en
   resolución de wikilinks.

### Estimación core (pasos 1–4)

| Tarea | Esfuerzo |
|-------|----------|
| SKIP_DIR_NAMES + docs | 30 min |
| Guard en seedKbTemplates | 30 min |
| Log ERROR startup | 15 min |
| Config entorno | 5 min |
| **Total** | **~80 min** |
