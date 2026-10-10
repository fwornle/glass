/**
 * Measurement-span lifecycle (TELEM-02).
 *
 * The second half of the cross-agent token-attribution contract. A measurement
 * "span" is an operator- (or PLAN-) opened window during which proxy requests
 * are stamped with the active `task_id`. This module owns the ENTIRE span
 * lifecycle and is the SINGLE place that parses `.data/active-measurement.json`:
 *
 *   - getActiveMeasurement() — THE only JSON parser of the active-span file.
 *     Returns the open span or null; NEVER throws (it is called on the proxy
 *     write hot-path by Plan 68-03), and warns (non-fatal) on a corrupt file.
 *   - startMeasurement()     — writes the open span (started_at = now).
 *   - stopMeasurement()      — sets ended_at and atomically archives the span to
 *     `.data/measurements/<task_id>.json` (temp-write + fs.renameSync), then
 *     removes the active-span file.
 *
 * Span files sit next to the token DB: their data dir is resolved with the same
 * order as resolveTokenDbPath (LLM_PROXY_DATA_DIR → cwd/.data), so the running
 * daemon (LLM_PROXY_DATA_DIR=/Users/.../coding/.data) writes the active span to
 * <dataDir>/active-measurement.json and archives to <dataDir>/measurements/.
 *
 * All logging uses process.stderr.write (repo lints no-console-log).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
/** Maximum staleness before a still-open span is flagged on read. */
const STALE_SPAN_MS = 24 * 60 * 60 * 1000;
/** Conservative cap on a sanitized task_id length (filename safety). */
const MAX_TASK_ID_LEN = 200;
/** Allowed task_id charset after sanitization. */
const SAFE_TASK_ID = /^[A-Za-z0-9._-]+$/;
/** Allowed agent charset (lowercased) for per-agent span filenames. */
const SAFE_AGENT = /^[a-z0-9-]+$/;
/**
 * Sanitize an agent label for use in a per-agent span filename
 * (`active-measurement.<agent>.json`). Lowercases, trims, and enforces
 * `[a-z0-9-]`. Returns '' for a missing/blank agent (→ caller uses the global
 * span file). Throws on a non-empty but unsanitizable agent so a bad label can
 * never escape the data dir.
 */
export function sanitizeAgent(raw) {
    if (raw == null || raw === '')
        return '';
    if (typeof raw !== 'string') {
        throw new Error(`[measurement] agent must be a string, got ${typeof raw}`);
    }
    const base = path.basename(raw.trim().toLowerCase());
    if (!base)
        return '';
    if (base.length > 40 || !SAFE_AGENT.test(base)) {
        throw new Error(`[measurement] agent contains illegal characters (allowed: a-z 0-9 -): ${JSON.stringify(raw)}`);
    }
    return base;
}
/**
 * True when a span was opened by the always-on AUTO reconciler (an ambient
 * per-agent slot), as opposed to a deliberately-opened manual `measure start`
 * or experiment/comparison span. The reconciler stamps `meta.auto === true`.
 *
 * Used by resolveLiveTaskId to let a deliberate measurement window outrank the
 * ambient auto slot instead of being shadowed by it.
 */
export function isAutoSpan(span) {
    return !!span
        && !!span.meta
        && span.meta.auto === true;
}
/**
 * Resolve the on-disk locations of the active span + the archive directory.
 * Mirrors resolveTokenDbPath's data-dir resolution order exactly so the span
 * files live alongside the token DB.
 *
 * @param overrideDataDir explicit data dir override (test seam)
 * @param agent optional agent label. When non-empty the active-span file is the
 *   per-agent slot `active-measurement.<agent>.json` (Option B — one live span
 *   per coding agent); when empty it is the shared/global `active-measurement.json`
 *   (manual measurement + experiments). The archive dir is shared.
 */
export function resolveMeasurementPaths(overrideDataDir, agent) {
    const dataDir = overrideDataDir
        || process.env.LLM_PROXY_DATA_DIR
        || path.join(process.cwd(), '.data');
    const safeAgent = sanitizeAgent(agent);
    const activeFile = safeAgent
        ? `active-measurement.${safeAgent}.json`
        : 'active-measurement.json';
    return {
        dataDir,
        activePath: path.join(dataDir, activeFile),
        archiveDir: path.join(dataDir, 'measurements'),
    };
}
/**
 * The security gate for task_id → filename interpolation (T-68-02-01).
 *
 * Allows only `[A-Za-z0-9._-]`; rejects path separators, traversal segments
 * (`.`/`..`), the empty string, and over-long ids. Throws a clear Error on an
 * unsanitizable id — the start/stop CLIs surface it; the reader never builds a
 * filename from an untrusted id so it does not call this.
 *
 * @param raw the candidate task_id (operator- or PLAN-derived)
 * @returns the sanitized task_id (path.basename'd as defense-in-depth)
 */
export function sanitizeTaskId(raw) {
    if (typeof raw !== 'string') {
        throw new Error(`[measurement] task_id must be a string, got ${typeof raw}`);
    }
    // Defense-in-depth: strip any directory component first so no separator can
    // survive into the archive filename even if the charset check were bypassed.
    const base = path.basename(raw.trim());
    if (!base || base === '.' || base === '..') {
        throw new Error(`[measurement] task_id resolves to an unsafe path segment: ${JSON.stringify(raw)}`);
    }
    if (base.length > MAX_TASK_ID_LEN) {
        throw new Error(`[measurement] task_id exceeds ${MAX_TASK_ID_LEN} chars (got ${base.length})`);
    }
    if (!SAFE_TASK_ID.test(base)) {
        throw new Error(`[measurement] task_id contains illegal characters (allowed: A-Z a-z 0-9 . _ -): ${JSON.stringify(raw)}`);
    }
    return base;
}
/**
 * THE single reader/parser of the active-span file (Success Criterion 4).
 *
 * @param overrideDataDir explicit data dir override (test seam)
 * @param agent optional agent label → reads that agent's per-agent span slot.
 * @returns the open span, or null when absent / corrupt / shape-invalid.
 *   NEVER throws — a corrupt span must not crash the proxy request path.
 *   A span older than 24h is still returned but emits a one-line stale warning.
 */
export function getActiveMeasurement(overrideDataDir, agent) {
    const { activePath } = resolveMeasurementPaths(overrideDataDir, agent);
    let raw;
    try {
        raw = fs.readFileSync(activePath, 'utf-8');
    }
    catch (err) {
        const e = err;
        if (e && e.code === 'ENOENT')
            return null;
        process.stderr.write(`[measurement] active-measurement.json unreadable (non-fatal): ${e?.message ?? String(err)}\n`);
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[measurement] active-measurement.json unreadable (non-fatal): ${msg}\n`);
        return null;
    }
    // Minimal shape validation: task_id + started_at must be non-empty strings.
    if (!parsed || typeof parsed !== 'object'
        || typeof parsed.task_id !== 'string'
        || typeof parsed.started_at !== 'string'
        || !parsed.task_id
        || !parsed.started_at) {
        process.stderr.write('[measurement] active-measurement.json has an invalid span shape (non-fatal); ignoring\n');
        return null;
    }
    const span = parsed;
    // Stale-span policy: still return it, but warn once per read.
    const startedMs = Date.parse(span.started_at);
    if (Number.isFinite(startedMs) && Date.now() - startedMs > STALE_SPAN_MS) {
        process.stderr.write(`[measurement] stale span (>24h) task_id=${span.task_id} started_at=${span.started_at}\n`);
    }
    return span;
}
/**
 * Open a measurement span. Sanitizes task_id, then writes the open span to
 * <dataDir>/active-measurement.json with started_at = now. If a span is already
 * open it is overwritten (with a non-fatal stderr warning so the clobber is
 * never silent — single-operator workflow, see T-68-02-03).
 *
 * @param input span fields (task_id required; goal_sentence / meta optional;
 *   agent optional → writes the per-agent slot instead of the global file)
 * @param overrideDataDir explicit data dir override (test seam)
 * @returns the written span record
 */
export function startMeasurement(input, overrideDataDir) {
    const task_id = sanitizeTaskId(input?.task_id);
    const agent = sanitizeAgent(input?.agent);
    const { dataDir, activePath } = resolveMeasurementPaths(overrideDataDir, agent);
    if (fs.existsSync(activePath)) {
        process.stderr.write(`[measurement] overwriting existing active span at ${activePath}\n`);
    }
    const span = {
        task_id,
        started_at: new Date().toISOString(),
        ...(input.goal_sentence ? { goal_sentence: input.goal_sentence } : {}),
        ...(agent ? { agent } : {}),
        ...(input.meta ? { meta: input.meta } : {}),
    };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(activePath, JSON.stringify(span, null, 2));
    return span;
}
/**
 * Close the active span. Reads it via getActiveMeasurement (the single parser),
 * stamps ended_at = now, atomically archives it to
 * <dataDir>/measurements/<task_id>.json (temp-write + fs.renameSync — the
 * crash-safe primitive), then removes the active-span file.
 *
 * @param overrideDataDir explicit data dir override (test seam)
 * @param agent optional agent label → stops that agent's per-agent slot.
 * @returns the archived span, or null when there was no active span.
 */
export function stopMeasurement(overrideDataDir, agent) {
    const { activePath, archiveDir } = resolveMeasurementPaths(overrideDataDir, agent);
    const active = getActiveMeasurement(overrideDataDir, agent);
    if (!active) {
        process.stderr.write('[measurement] stopMeasurement: no active span to stop\n');
        return null;
    }
    const archived = { ...active, ended_at: new Date().toISOString() };
    // path.basename + sanitizeTaskId give defense-in-depth so no separator in a
    // (hypothetically) tampered active file can escape archiveDir.
    const safeId = path.basename(sanitizeTaskId(archived.task_id));
    const finalPath = path.join(archiveDir, `${safeId}.json`);
    const tempPath = path.join(archiveDir, `${safeId}.json.tmp-${process.pid}`);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(archived, null, 2));
    fs.renameSync(tempPath, finalPath);
    fs.rmSync(activePath, { force: true });
    return archived;
}
/**
 * Clear (delete) a per-agent measurement slot WITHOUT archiving it.
 *
 * This is the reconciler's counterpart to stopMeasurement: always-on ambient
 * spans are just live binding hints (the Run itself is reconstructed
 * independently by the foreground auto-measure daemon + wire tap), so a stale
 * or rotated auto span must be dropped, not archived — archiving would pollute
 * <dataDir>/measurements/ with spurious ambient entries.
 *
 * An `agent` is REQUIRED: this never touches the shared/global
 * `active-measurement.json` (owned by manual measurement + experiments).
 * Returns true when a slot file was removed, false when there was nothing to do.
 */
export function clearAgentSpan(agent, overrideDataDir) {
    const safeAgent = sanitizeAgent(agent);
    if (!safeAgent) {
        process.stderr.write('[measurement] clearAgentSpan: refusing to clear the global slot (agent required)\n');
        return false;
    }
    const { activePath } = resolveMeasurementPaths(overrideDataDir, safeAgent);
    if (!fs.existsSync(activePath)) {
        return false;
    }
    fs.rmSync(activePath, { force: true });
    return true;
}
/**
 * Resolve the task_id to stamp on a live proxy token_usage row (TELEM-03 /
 * Success Criterion 5). This is THE write-path resolution rule, factored here
 * so it lives next to the single reader it consults (getActiveMeasurement) and
 * is testable in one place.
 *
 * Resolution rule (Option B — per-agent slots, with deliberate-span priority):
 *   1. A DELIBERATELY-opened per-agent span (no `meta.auto`) is the most
 *      specific match → return it immediately.
 *   2. A DELIBERATELY-opened global span (`active-measurement.json`, no
 *      `meta.auto`) — i.e. a manual `measure start` or an experiment/comparison
 *      cell — OUTRANKS an always-on AUTO per-agent span. Without this priority
 *      the ambient reconciler slot (`active-measurement.<agent>.json`,
 *      `meta.auto=true`) shadows the experiment window: opencode's
 *      OpenAI-compatible shim requests carry no task_id, so they resolve to the
 *      auto foreground session id and each turn's per-category wire capture is
 *      persisted under the WRONG task_id. The experiment run (looked up by its
 *      `exp-…` composite id) then finds no capture and falls back to the generic
 *      illustrative context band. An explicit measurement must win over ambient
 *      auto.
 *   3. Otherwise the ambient AUTO per-agent span → its task_id. This is the
 *      primary path for always-on measurement: each coding agent's live
 *      foreground session owns its own slot, so concurrent agents never
 *      cross-attribute.
 *   4. Otherwise the global span, if any (pre-Option-B behaviour).
 *   5. No span anywhere → return '' (matches the token_usage.task_id column
 *      DEFAULT from Plan 68-01).
 *
 * For the LIVE write path the active span is by definition OPEN (no ended_at),
 * so "in-window" reduces to "a span is present and started_at <= now". The full
 * started_at <= T <= ended_at window check against archived spans is the
 * backfill sweep's job (scripts/backfill-task-id-by-timestamp.mjs), not this
 * hot-path resolver.
 *
 * Best-effort / never-throw (T-68-03-01): getActiveMeasurement is itself
 * null-safe, but this is wrapped in try/catch as defense-in-depth so a
 * measurement-read failure can NEVER break token logging — on any error we
 * return '' and the row is still logged (unattributed).
 *
 * @param overrideDataDir explicit data dir override (test seam)
 * @param agent optional resolved agent label for the current request.
 * @returns the resolved span's task_id, or '' when no span / on any error.
 */
export function resolveLiveTaskId(overrideDataDir, agent) {
    try {
        const safeAgent = sanitizeAgent(agent);
        const perAgent = safeAgent ? getActiveMeasurement(overrideDataDir, safeAgent) : null;
        // (1) A deliberately-opened per-agent span is the most specific match.
        if (perAgent && !isAutoSpan(perAgent))
            return perAgent.task_id;
        // (2) perAgent is auto (ambient reconciler) or absent → a deliberately-opened
        //     global span (manual `measure start` or an experiment/comparison cell)
        //     must win over the ambient auto slot. This prevents the always-on
        //     reconciler slot from shadowing an active experiment window and
        //     mis-attributing its per-category wire capture to the foreground
        //     session id.
        const global = getActiveMeasurement(overrideDataDir);
        if (global && !isAutoSpan(global))
            return global.task_id;
        // (3) No deliberate span anywhere → Option B ambient fallback:
        //     the agent's own auto span, else the global span, else ''.
        if (perAgent)
            return perAgent.task_id;
        return global ? global.task_id : '';
    }
    catch {
        // getActiveMeasurement should never throw, but if it somehow does, token
        // logging must still proceed with an empty (unattributed) task_id.
        return '';
    }
}
/**
 * Resolve the task_id of a SPECIFIC agent's per-agent span ONLY — never the
 * shared/global span.
 *
 * This is the D-08/WR-01-safe resolver for the INTERACTIVE capture taps
 * (e.g. the header-less `/v1/messages` branch). Those taps must NEVER inherit
 * the global `active-measurement.json`, because a concurrent experiment cell
 * or a stale manual span would cross-attribute interactive foreground tokens
 * (the exact leak D-08 stamps neutral to prevent).
 *
 * Under Option B (per-agent slots) it IS safe — and desirable — for an
 * interactive request to bind to *its own agent's* auto span: that span was
 * opened by the foreground reconciler specifically for this live session, so
 * binding to it captures the real per-category buffer without any risk of
 * adopting another agent's / experiment's window.
 *
 * Returns '' when the agent has no per-agent span (auto-measure off, or no
 * live session yet) — byte-identical to the pre-Option-B neutral stamp.
 *
 * Best-effort / never-throw, same contract as resolveLiveTaskId.
 *
 * @param agent resolved agent label for the current request.
 * @param overrideDataDir explicit data dir override (test seam).
 * @returns the agent's own span task_id, or '' when none / on any error.
 */
export function resolveAgentSpanTaskId(agent, overrideDataDir) {
    try {
        const safeAgent = sanitizeAgent(agent);
        if (!safeAgent)
            return '';
        const perAgent = getActiveMeasurement(overrideDataDir, safeAgent);
        return perAgent ? perAgent.task_id : '';
    }
    catch {
        return '';
    }
}
/**
 * Enumerate every open span in the data dir: the global slot plus each
 * per-agent slot. Used by the auto-measurement reconciler and the dashboard to
 * show/coordinate all live spans. Never throws — a corrupt slot is skipped.
 *
 * @param overrideDataDir explicit data dir override (test seam)
 * @returns array of `{ agent, span }` (agent = null for the global slot).
 */
export function listActiveMeasurements(overrideDataDir) {
    const { dataDir } = resolveMeasurementPaths(overrideDataDir);
    const out = [];
    let entries = [];
    try {
        entries = fs.readdirSync(dataDir);
    }
    catch {
        return out; // data dir absent → no spans
    }
    for (const name of entries) {
        if (name === 'active-measurement.json') {
            const span = getActiveMeasurement(overrideDataDir);
            if (span)
                out.push({ agent: null, span });
            continue;
        }
        const m = /^active-measurement\.([a-z0-9-]+)\.json$/.exec(name);
        if (!m)
            continue;
        const span = getActiveMeasurement(overrideDataDir, m[1]);
        if (span)
            out.push({ agent: m[1], span });
    }
    return out;
}
