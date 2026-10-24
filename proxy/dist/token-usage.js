/**
 * Token Usage Tracking
 *
 * Persists every successful LLM completion to a per-consumer SQLite DB so
 * dashboards can answer "who burned which tokens on what". Lives in the
 * standalone @rapid/llm-proxy package so coding-side and OKB-side instances
 * each get their own DB (path resolved from LLM_PROXY_DATA_DIR at startup).
 *
 * Schema:
 *   id              INTEGER PRIMARY KEY
 *   timestamp       TEXT   ISO-8601 UTC
 *   provider        TEXT   'claude-code' | 'copilot' | 'anthropic' | 'openai' | 'groq'
 *   model           TEXT   resolved API/CLI model name (e.g. 'claude-sonnet-4-20250514')
 *   process         TEXT   caller cognitive process ('observation-writer', 'consolidator',
 *                          'health-coordinator', 'okb-ingest', …). 'unknown' if caller
 *                          didn't tag the request.
 *   subscription    TEXT   billing context ('copilot-subscription', 'max-subscription',
 *                          'api-key'). Defaulted by provider when caller omits it.
 *   input_tokens    INTEGER  from API/CLI response when present
 *   output_tokens   INTEGER  from API/CLI response when present
 *   total_tokens    INTEGER  input + output
 *   latency_ms      INTEGER  wall-clock for the proxy round trip
 *   prompt_preview  TEXT     first ~120 chars of the first user message,
 *                            for at-a-glance attribution in the dashboard
 *   tokens_estimated INTEGER 0 when input/output came from a real usage payload,
 *                            1 when they were locally estimated (e.g. fallback path).
 *                            Dashboards use this to mark "estimated" entries.
 */
import { openDb } from '../proxy-bridge/db-open.cjs';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// ---------------------------------------------------------------------------
// Phase 36 — per-(window, user_hash) JSON exports mirror LSL conventions.
// USER_HASH and LSL_TIMEZONE read ONCE at module init from env vars exported
// by the launchd wrapper (start-llm-proxy.sh, Plan 36-02). LSL_TIMEZONE
// fallback to 'Europe/Berlin' is defense-in-depth — wrapper is authoritative.
// ---------------------------------------------------------------------------
const COORDINATOR_URL = process.env.HEALTH_COORDINATOR_URL || 'http://127.0.0.1:3034';
// 'off' = there is no coordinator (glass): the window is always computed
// locally and nothing shells out to curl.
const COORDINATOR_OFF = COORDINATOR_URL === 'off';
const WINDOW_CACHE_TTL_MS = 30_000;
let _cachedWindow = null;
let _cachedWindowAt = 0;
const USER_HASH_RAW = (process.env.LLM_PROXY_USER_HASH || 'unknown').trim() || 'unknown';
const USER_HASH = /^[a-z][a-z0-9]{5}$/.test(USER_HASH_RAW) ? USER_HASH_RAW : 'unknown';
const LSL_TIMEZONE = process.env.LSL_TIMEZONE || 'Europe/Berlin';
// session_duration cached once at init (default 60 min). Resolves CODING_REPO
// from env, else the coding checkout next to _work/ (<A>/_work/rapid-llm-proxy/
// {src,dist} → <A>/coding), the same guess bin/start-llm-proxy.sh makes.
let _sessionDurationMs = 3_600_000;
try {
    const repoRoot = process.env.CODING_REPO
        || path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'coding');
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'live-logging-config.json'), 'utf-8'));
    const durMin = cfg?.live_logging?.session_duration;
    if (typeof durMin === 'number' && durMin > 0) {
        _sessionDurationMs = durMin * 60_000;
    }
}
catch { /* default 60 min — config unreadable */ }
// Reuse a single Intl.DateTimeFormat (constructor is the slow part; formatToParts
// is fast). Pulls timeZone from the wrapper-exported LSL_TIMEZONE so the proxy's
// view of "local hour" matches the statusline + coordinator even though launchd
// gives the child process UTC by default.
const _intlFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: LSL_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
});
function _localPartsOf(d) {
    const parts = _intlFmt.formatToParts(d);
    const get = (t) => parts.find(p => p.type === t)?.value || '00';
    // Intl 'hour:2-digit hour12:false' can emit '24' for midnight on some engines.
    // Normalise to 00..23.
    let hour = parseInt(get('hour'), 10);
    if (hour === 24)
        hour = 0;
    return { year: get('year'), month: get('month'), day: get('day'), hour, minute: parseInt(get('minute'), 10) };
}
/**
 * Resolve the token-usage DB path. Consumer projects (coding, OKB) set
 * LLM_PROXY_DATA_DIR to their own .data dir so each instance owns its data.
 * LLM_PROXY_TOKEN_DB_PATH overrides the full path if needed (test isolation).
 *
 * @param overrideDataDir explicit data dir override (test seam)
 */
export function resolveTokenDbPath(overrideDataDir) {
    const explicit = process.env.LLM_PROXY_TOKEN_DB_PATH;
    if (explicit)
        return explicit;
    const dataDir = overrideDataDir
        || process.env.LLM_PROXY_DATA_DIR
        || path.join(process.cwd(), '.data');
    return path.join(dataDir, 'llm-proxy', 'token-usage.db');
}
/**
 * Resolve the path of the legacy git-trackable monolithic JSON export.
 *
 * @deprecated Phase 36 replaces the single-file export with per-(window,user_hash)
 * files under `<baseDir>/YYYY/MM/`. New code uses {@link resolveTokenExportDir}
 * and {@link exportToHourFile}. This function is retained so any external caller
 * that still resolves the old path keeps working until Plan 36-05's migration
 * removes the legacy file entirely.
 */
export function resolveTokenExportPath(overrideDataDir) {
    const explicit = process.env.LLM_PROXY_TOKEN_EXPORT_PATH;
    if (explicit)
        return explicit;
    const dataDir = overrideDataDir
        || process.env.LLM_PROXY_DATA_DIR
        || path.join(process.cwd(), '.data');
    return path.join(dataDir, 'llm-proxy-export', 'token-usage.json');
}
/**
 * Resolve the BASE directory for per-(window, user_hash) JSON exports.
 * Files live at `<dir>/YYYY/MM/YYYY-MM-DD_HHMM-HHMM_<hash6>.json` (LSL convention).
 *
 * Honors `LLM_PROXY_TOKEN_EXPORT_DIR` env override first, then derives from
 * `LLM_PROXY_DATA_DIR`, then cwd. Mirrors {@link resolveTokenDbPath}'s
 * resolution order so dashboards and the writer always agree on location.
 */
export function resolveTokenExportDir(overrideDataDir) {
    const explicit = process.env.LLM_PROXY_TOKEN_EXPORT_DIR;
    if (explicit)
        return explicit;
    const dataDir = overrideDataDir
        || process.env.LLM_PROXY_DATA_DIR
        || path.join(process.cwd(), '.data');
    return path.join(dataDir, 'llm-proxy-export');
}
/**
 * Compute the current `HHMM-HHMM` time-window from a Date, using the local hour
 * via Intl.DateTimeFormat with the wrapper-exported timezone. Right-exclusive:
 * 09:00:00 → '0900-1000', 09:59:59 → '0900-1000', 10:00:00 → '1000-1100'.
 *
 * Default session_duration is 60 min; if config/live-logging-config.json
 * specifies a different value it was cached at module init.
 */
function computeWindowLocally(now) {
    const { hour } = _localPartsOf(now);
    const sessionHours = Math.max(1, Math.round(_sessionDurationMs / 3_600_000));
    const startHour = Math.floor(hour / sessionHours) * sessionHours;
    const endHour = (startHour + sessionHours) % 24;
    const fmt = (h) => `${h.toString().padStart(2, '0')}00`;
    return `${fmt(startHour)}-${fmt(endHour)}`;
}
/**
 * Resolve the current LSL time-window. Calls the coordinator's /health/state
 * first (Plan 36-01 publishes `lsl_meta.current_window`), with a 1-2s timeout
 * and a 30s in-memory cache. Falls back to local recompute via
 * {@link computeWindowLocally} on coordinator-unreachable.
 *
 * Cache is warmed at module init via setImmediate so the first logCall after
 * boot doesn't pay the 1-2s execSync curl tax.
 */
export function currentWindow(now) {
    const t = Date.now();
    if (_cachedWindow && (t - _cachedWindowAt) < WINDOW_CACHE_TTL_MS)
        return _cachedWindow;
    let w;
    if (!COORDINATOR_OFF)
        try {
            const raw = execSync(`curl -sf --max-time 1 ${COORDINATOR_URL}/health/state`, { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            const state = JSON.parse(raw);
            w = state?.lsl_meta?.current_window || state?.lsl?.current_window;
            if (w === 'unknown')
                w = undefined;
        }
        catch {
            // Coordinator unreachable — fall through to local compute
        }
    if (!w) {
        w = computeWindowLocally(now);
        if (!COORDINATOR_OFF)
            process.stderr.write(`[token-usage] currentWindow fallback to local compute: ${w}\n`);
    }
    _cachedWindow = w;
    _cachedWindowAt = t;
    return w;
}
// Warm the window cache off-event-loop so the very first logCall after boot
// doesn't block on the 1-2s execSync curl. Catch-and-ignore — if it fails
// here, currentWindow() will retry on the first real call.
setImmediate(() => {
    try {
        currentWindow(new Date());
    }
    catch { /* warm-fail is fine */ }
});
/**
 * Port of `scripts/lsl-paths.js:lslWritePath` (kept inline — proxy stays
 * standalone per CONTEXT.md). Given a base dir and a filename starting with
 * `YYYY-MM-DD_`, returns `<base>/YYYY/MM/<filename>` and ensures the
 * subdirectory exists. Falls back to flat `<base>/<filename>` if the
 * filename doesn't match the date prefix (defensive — shouldn't trigger).
 */
function tokenExportWritePath(baseDir, filename) {
    const m = filename.match(/^(\d{4})-(\d{2})-\d{2}_/);
    if (!m) {
        fs.mkdirSync(baseDir, { recursive: true });
        return path.join(baseDir, filename);
    }
    const targetDir = path.join(baseDir, m[1], m[2]);
    fs.mkdirSync(targetDir, { recursive: true });
    return path.join(targetDir, filename);
}
/**
 * Convert the current local YYYY-MM-DD + integer hour into the UTC ISO-8601
 * string that bounds the right-exclusive `[windowStart, windowEnd)` SELECT
 * range. Uses the same Intl-timezone path as {@link computeWindowLocally}
 * so the boundary matches what the FILENAME's window encodes.
 *
 * Returns null on inputs the engine refuses to parse (defensive).
 */
function _localBoundaryToUtcIso(localYmd, localHour) {
    // Construct a UTC moment that, when projected back into LSL_TIMEZONE, lands
    // exactly at localHour:00 on localYmd. We do this by binary-searching the
    // 25-hour window centred on the naive UTC interpretation, but in practice
    // a simpler approach works: compute the offset between LSL_TIMEZONE and UTC
    // at the candidate moment, then subtract.
    // Probe: take "localYmd HH:00 UTC" as a starting point, project into the
    // timezone, observe how far off the hour we are, correct, and accept.
    const [yyyy, mm, dd] = localYmd.split('-').map(n => parseInt(n, 10));
    if (!yyyy || !mm || !dd)
        return null;
    const naive = new Date(Date.UTC(yyyy, mm - 1, dd, localHour, 0, 0));
    const projected = _localPartsOf(naive);
    // Offset = how many hours the projection is AHEAD of localHour (positive →
    // timezone is east of UTC, so the naive UTC moment lands LATER in local time
    // than intended and we need to push the UTC moment EARLIER).
    let offsetHours = projected.hour - localHour;
    // Handle date wrap (e.g. local 00 vs projected 23 of previous day).
    if (projected.day !== dd.toString().padStart(2, '0')) {
        if (parseInt(projected.day, 10) < dd)
            offsetHours -= 24;
        else
            offsetHours += 24;
    }
    return new Date(naive.getTime() - offsetHours * 3_600_000).toISOString();
}
/**
 * Phase 36 writer: emit one JSON file per (window, user_hash) under
 * `<baseDir>/YYYY/MM/`. Right-exclusive timestamp filter `[windowStart, windowEnd)`.
 * Safety-merge against any existing file by `(user_hash, id)` so a teammate's
 * previously-pushed rows survive a local DB reset.
 *
 * Best-effort: any failure writes a non-fatal stderr line and returns.
 * Never throws into the LLM completion hot path.
 */
export function exportToHourFile(handle, now) {
    try {
        const windowStr = currentWindow(now); // 'HHMM-HHMM'
        const startHour = parseInt(windowStr.slice(0, 2), 10);
        const endHour = parseInt(windowStr.slice(5, 7), 10);
        const { year, month, day } = _localPartsOf(now);
        const localYmd = `${year}-${month}-${day}`;
        const filename = `${localYmd}_${windowStr}_${USER_HASH}.json`;
        const windowStart = _localBoundaryToUtcIso(localYmd, startHour);
        // Wrap end across day boundary if window straddles midnight.
        let windowEnd;
        if (endHour <= startHour) {
            // Next day at endHour
            const nextDay = new Date(Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10) + 1));
            const np = _localPartsOf(nextDay);
            windowEnd = _localBoundaryToUtcIso(`${np.year}-${np.month}-${np.day}`, endHour);
        }
        else {
            windowEnd = _localBoundaryToUtcIso(localYmd, endHour);
        }
        if (!windowStart || !windowEnd) {
            process.stderr.write(`[token-usage] exportToHourFile: could not derive UTC boundaries for ${localYmd} ${windowStr}\n`);
            return;
        }
        const dbRows = handle.db.prepare(`
      SELECT id, timestamp, provider, model, process, subscription,
             input_tokens, output_tokens, total_tokens, latency_ms,
             prompt_preview, tokens_estimated, user_hash, model_raw,
             cache_read_tokens, cache_write_tokens
      FROM token_usage
      WHERE timestamp >= ? AND timestamp < ? AND user_hash = ?
      ORDER BY id ASC
    `).all(windowStart, windowEnd, USER_HASH);
        const target = tokenExportWritePath(resolveTokenExportDir(), filename);
        let merged = dbRows;
        try {
            const existing = JSON.parse(fs.readFileSync(target, 'utf-8'));
            if (Array.isArray(existing) && existing.length > 0) {
                const dbKeys = new Set(dbRows.map(r => `${r.user_hash}:${r.id}`));
                const preserved = existing.filter((r) => !dbKeys.has(`${r.user_hash ?? USER_HASH}:${r.id}`));
                if (preserved.length > 0) {
                    merged = [...preserved, ...dbRows];
                }
            }
        }
        catch { /* file doesn't exist yet OR unreadable — overwrite with dbRows */ }
        const content = JSON.stringify(merged, null, 2) + '\n';
        try {
            if (fs.readFileSync(target, 'utf-8') === content)
                return; // no-op write
        }
        catch { /* file doesn't exist yet — write it */ }
        fs.writeFileSync(target, content, 'utf-8');
    }
    catch (err) {
        process.stderr.write(`[token-usage] exportToHourFile failed (non-fatal): ${err.message}\n`);
    }
}
/**
 * Initialise (or open) the token-usage SQLite DB at the resolved path.
 * Creates the directory if missing and ensures the schema + indices exist.
 * If the DB is fresh (empty) AND a JSON export exists at the resolved
 * export path, the export is loaded back into the table — this lets a
 * teammate clone the repo, pull the export from git, and have their proxy
 * see history on first start instead of an empty dashboard.
 */
export function initTokenDb(overrideDataDir) {
    const dbPath = resolveTokenDbPath(overrideDataDir);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openDb(dbPath, { requireFrom: import.meta.url });
    db.pragma('journal_mode = WAL');
    // Canonical schema (fresh-install path). Composite PRIMARY KEY (user_hash,
    // id) lets two peers' id=1 rows coexist after cross-user hydrate via git.
    // Note: SQLite forbids AUTOINCREMENT with a composite PK, so per-user id
    // assignment is JS-side via handle.nextLocalId() (see seedLocalSeq below).
    db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id              INTEGER NOT NULL,
      timestamp       TEXT    NOT NULL,
      provider        TEXT    NOT NULL,
      model           TEXT    NOT NULL,
      process         TEXT    NOT NULL DEFAULT 'unknown',
      subscription    TEXT    NOT NULL DEFAULT 'unknown',
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      total_tokens    INTEGER NOT NULL DEFAULT 0,
      latency_ms      INTEGER NOT NULL DEFAULT 0,
      prompt_preview  TEXT    NOT NULL DEFAULT '',
      tokens_estimated INTEGER NOT NULL DEFAULT 0,
      user_hash       TEXT    NOT NULL DEFAULT 'unknown',
      overhead_ms     INTEGER,
      PRIMARY KEY (user_hash, id)
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_usage_process   ON token_usage(process);
    CREATE INDEX IF NOT EXISTS idx_token_usage_provider  ON token_usage(provider);
  `);
    // -----------------------------------------------------------------------
    // Phase 36 schema migration — composite PK transition.
    //
    // The pre-Phase-36 schema declared `id INTEGER PRIMARY KEY AUTOINCREMENT`,
    // which aliases id to ROWID and refuses ON CONFLICT(user_hash, id) (verified
    // empirically — SQLite rejects the conflict target at prepare-time). To
    // enable cross-user merge we must rebuild the table with PRIMARY KEY
    // (user_hash, id). SQLite can't ALTER a PRIMARY KEY in place, so we copy
    // rows into a fresh-schema table, drop the old one, and rename.
    //
    // Idempotent: PRAGMA table_info detects the legacy `pk=1 ON id` shape; on
    // boots after the rebuild, the migration is a silent no-op. Retag of any
    // pre-existing rows from 'unknown' to USER_HASH happens during the COPY
    // so we never have to UPDATE a composite-PK table.
    //
    // wal_checkpoint(TRUNCATE) after the rebuild shrinks .db-wal back to ~0,
    // addressing the dirty-git-status pain (Plan 36-05 also widens .gitignore).
    // -----------------------------------------------------------------------
    let migrationApplied = false;
    let migrationRetagged = 0;
    try {
        const cols = db.prepare(`PRAGMA table_info(token_usage)`).all();
        const idCol = cols.find(c => c.name === 'id');
        const hasUserHash = cols.some(c => c.name === 'user_hash');
        const userHashPkRank = cols.find(c => c.name === 'user_hash')?.pk ?? 0;
        const idPkRank = idCol?.pk ?? 0;
        const compositePk = hasUserHash && userHashPkRank > 0 && idPkRank > 0;
        if (!compositePk) {
            // Use a sentinel name SQLite can't confuse with the live table; bracketed
            // identifier survives the rename step. Underscore-prefixed to mark it as
            // internal-only.
            db.exec('BEGIN');
            db.exec(`
        CREATE TABLE __token_usage_pkrebuild (
          id              INTEGER NOT NULL,
          timestamp       TEXT    NOT NULL,
          provider        TEXT    NOT NULL,
          model           TEXT    NOT NULL,
          process         TEXT    NOT NULL DEFAULT 'unknown',
          subscription    TEXT    NOT NULL DEFAULT 'unknown',
          input_tokens    INTEGER NOT NULL DEFAULT 0,
          output_tokens   INTEGER NOT NULL DEFAULT 0,
          total_tokens    INTEGER NOT NULL DEFAULT 0,
          latency_ms      INTEGER NOT NULL DEFAULT 0,
          prompt_preview  TEXT    NOT NULL DEFAULT '',
          tokens_estimated INTEGER NOT NULL DEFAULT 0,
          user_hash       TEXT    NOT NULL DEFAULT 'unknown',
          PRIMARY KEY (user_hash, id)
        );
      `);
            // Retag during the copy: any row with `user_hash='unknown'` OR a
            // pre-Phase-36 row without that column gets tagged with this machine's
            // USER_HASH. Subsequent hydrate-from-monolith composite keys then align.
            const userHashSelectExpr = hasUserHash
                ? `CASE WHEN user_hash = 'unknown' OR user_hash IS NULL THEN ? ELSE user_hash END`
                : `?`;
            const copyStmt = db.prepare(`
        INSERT INTO __token_usage_pkrebuild (
          id, timestamp, provider, model, process, subscription,
          input_tokens, output_tokens, total_tokens, latency_ms,
          prompt_preview, tokens_estimated, user_hash
        )
        SELECT id, timestamp, provider, model, process, subscription,
               input_tokens, output_tokens, total_tokens, latency_ms,
               prompt_preview, tokens_estimated, ${userHashSelectExpr} AS user_hash
        FROM token_usage
      `);
            const info = copyStmt.run(USER_HASH);
            migrationRetagged = info.changes;
            db.exec(`DROP TABLE token_usage`);
            db.exec(`ALTER TABLE __token_usage_pkrebuild RENAME TO token_usage`);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp)`);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_process   ON token_usage(process)`);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_provider  ON token_usage(provider)`);
            db.exec('COMMIT');
            migrationApplied = true;
        }
        try {
            db.pragma('wal_checkpoint(TRUNCATE)');
        }
        catch (err) {
            process.stderr.write(`[token-usage] wal_checkpoint failed (non-fatal): ${err.message}\n`);
        }
        if (migrationApplied) {
            process.stderr.write(`[token-usage] schema migration: composite PRIMARY KEY (user_hash, id) active, copied ${migrationRetagged} rows\n`);
        }
    }
    catch (err) {
        try {
            db.exec('ROLLBACK');
        }
        catch { /* not in a tx */ }
        process.stderr.write(`[token-usage] schema migration failed (non-fatal): ${err.message}\n`);
    }
    // -----------------------------------------------------------------------
    // Phase 36-06: model_raw column for forensic debugging of canonicalised
    // model names. Idempotent — PRAGMA-guarded ALTER. No index, no UNIQUE.
    // -----------------------------------------------------------------------
    try {
        const cols2 = db.prepare(`PRAGMA table_info(token_usage)`).all();
        if (!cols2.some(c => c.name === 'model_raw')) {
            db.exec(`ALTER TABLE token_usage ADD COLUMN model_raw TEXT`);
        }
    }
    catch (err) {
        process.stderr.write(`[token-usage] model_raw column migration failed (non-fatal): ${err.message}\n`);
    }
    // -----------------------------------------------------------------------
    // Phase 66-03 (PERF-03): overhead_ms column — the worker-pool spawn/queue
    // overhead per call. Idempotent PRAGMA-guarded ALTER (mirrors model_raw
    // above). Placed AS A STANDALONE ALTER after the composite-PK rebuild — NOT
    // inside the rebuild INSERT...SELECT — so a legacy source table without this
    // column never triggers a copy-column-mismatch. Nullable INTEGER: old rows
    // read back NULL and the p50_overhead_ms median excludes them via
    // WHERE overhead_ms IS NOT NULL (T-66-03-03).
    // -----------------------------------------------------------------------
    try {
        const cols3 = db.prepare(`PRAGMA table_info(token_usage)`).all();
        if (!cols3.some(c => c.name === 'overhead_ms')) {
            db.exec(`ALTER TABLE token_usage ADD COLUMN overhead_ms INTEGER`);
        }
    }
    catch (err) {
        process.stderr.write(`[token-usage] overhead_ms column migration failed (non-fatal): ${err.message}\n`);
    }
    // -----------------------------------------------------------------------
    // Phase 68-01 (TELEM-01): six additive cross-agent attribution columns.
    //
    // The v7.4 Performance Measurement System reads/writes per-agent token
    // attribution against this row shape. Five TEXT identifier columns
    // (agent / task_id / tool_call_id / parent_call_id / granularity_tier) and
    // one INTEGER counter (reasoning_tokens). Added as STANDALONE PRAGMA-guarded
    // ALTERs AFTER the composite-PK rebuild — NOT inside the rebuild
    // INSERT...SELECT — exactly like model_raw / overhead_ms above, so a legacy
    // source table without these columns never triggers a copy-column-mismatch.
    //
    // Defaults match the existing convention: TEXT NOT NULL DEFAULT '' (like
    // process / prompt_preview) and INTEGER NOT NULL DEFAULT 0 (like
    // input_tokens). SQLite permits `ADD COLUMN ... NOT NULL DEFAULT <const>`
    // because the constant default backfills existing rows in place — verified
    // against better-sqlite3's bundled SQLite 3.53.x. Each ALTER is
    // PRAGMA-guarded (idempotent: a second startup runs zero ALTERs) and the
    // whole block is wrapped in try/catch with a non-fatal stderr warning, so a
    // failed/locked ALTER never aborts proxy startup (T-68-01-02).
    // -----------------------------------------------------------------------
    try {
        const attributionCols = [
            { name: 'agent', ddl: `ALTER TABLE token_usage ADD COLUMN agent            TEXT    NOT NULL DEFAULT ''` },
            { name: 'task_id', ddl: `ALTER TABLE token_usage ADD COLUMN task_id          TEXT    NOT NULL DEFAULT ''` },
            { name: 'tool_call_id', ddl: `ALTER TABLE token_usage ADD COLUMN tool_call_id     TEXT    NOT NULL DEFAULT ''` },
            { name: 'parent_call_id', ddl: `ALTER TABLE token_usage ADD COLUMN parent_call_id   TEXT    NOT NULL DEFAULT ''` },
            { name: 'granularity_tier', ddl: `ALTER TABLE token_usage ADD COLUMN granularity_tier TEXT    NOT NULL DEFAULT ''` },
            { name: 'reasoning_tokens', ddl: `ALTER TABLE token_usage ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0` },
        ];
        const cols4 = db.prepare(`PRAGMA table_info(token_usage)`).all();
        const existing = new Set(cols4.map(c => c.name));
        for (const col of attributionCols) {
            if (!existing.has(col.name)) {
                db.exec(col.ddl);
            }
        }
    }
    catch (err) {
        process.stderr.write(`[token-usage] attribution column migration failed (non-fatal): ${err.message}\n`);
    }
    // -----------------------------------------------------------------------
    // Phase 82-01 (WIRE-01): prompt-cache token counters. Two additive INTEGER
    // columns (cache_read_tokens / cache_write_tokens). Added as STANDALONE
    // PRAGMA-guarded ALTERs AFTER the composite-PK rebuild — NOT inside the
    // rebuild INSERT...SELECT nor the fresh-install CREATE TABLE — exactly like
    // model_raw / overhead_ms / the attribution columns above, so a legacy source
    // table without these columns never triggers a copy-column-mismatch.
    //
    // Column names+types (INTEGER NOT NULL DEFAULT 0) are BYTE-IDENTICAL to the
    // coding-side lib/lsl/token/token-db.mjs ensureCacheColumns so the two
    // independent migrations are mutually idempotent — whichever runs first adds
    // the columns, the other is a PRAGMA-guarded no-op. Each ALTER is
    // PRAGMA-guarded (a second startup runs zero ALTERs) and the whole block is
    // wrapped in try/catch with a non-fatal stderr warning, so a failed/locked
    // ALTER never aborts proxy startup (T-82-01-01). cache_* are SEPARATE
    // counters — never folded into total_tokens.
    // -----------------------------------------------------------------------
    try {
        const cacheCols = [
            { name: 'cache_read_tokens', ddl: `ALTER TABLE token_usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0` },
            { name: 'cache_write_tokens', ddl: `ALTER TABLE token_usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0` },
        ];
        const cols5 = db.prepare(`PRAGMA table_info(token_usage)`).all();
        const existingCache = new Set(cols5.map(c => c.name));
        for (const col of cacheCols) {
            if (!existingCache.has(col.name)) {
                db.exec(col.ddl);
            }
        }
    }
    catch (err) {
        process.stderr.write(`[token-usage] cache column migration failed (non-fatal): ${err.message}\n`);
    }
    // -----------------------------------------------------------------------
    // Routing-decision columns.
    //
    // Until these existed a row said only where a call LANDED — provider, model,
    // process. That supports a pie chart and nothing else: it cannot tell a
    // fallback from a route change, cannot attribute a call to the route that
    // produced it, and cannot separate "the config never offered this provider"
    // from "the config offered it and it was unreachable". The dashboard's Flow
    // view papered over the gap by INFERRING from provider totals, which is a
    // guess presented as a finding.
    //
    // All of it is already in scope at dispatch (server.mjs builds the full
    // decision via explainRoute) and was simply discarded. These columns are the
    // write-down. Same PRAGMA-guarded, try/caught shape as the blocks above: a
    // second startup runs zero ALTERs, and a locked ALTER never aborts boot.
    //
    // routing_source is provenance, and it is load-bearing: 'live' means observed
    // at dispatch, 'backfill' means reconstructed afterwards against a config that
    // may since have changed. Without it a reconstruction is indistinguishable
    // from a record, which is exactly the confusion these columns exist to end.
    // -----------------------------------------------------------------------
    try {
        const routingCols = [
            { name: 'route_key', ddl: `ALTER TABLE token_usage ADD COLUMN route_key      TEXT    NOT NULL DEFAULT ''` },
            { name: 'route_band', ddl: `ALTER TABLE token_usage ADD COLUMN route_band     TEXT    NOT NULL DEFAULT ''` },
            { name: 'route_step', ddl: `ALTER TABLE token_usage ADD COLUMN route_step     INTEGER NOT NULL DEFAULT 0` },
            { name: 'offloaded_from', ddl: `ALTER TABLE token_usage ADD COLUMN offloaded_from TEXT    NOT NULL DEFAULT ''` },
            // 0 = the route's own provider served it. >0 = that many fallback hops in.
            // Defaulting to 0 is safe ONLY because routing_source distinguishes a real
            // observed 0 from a legacy row that never recorded anything.
            { name: 'chain_position', ddl: `ALTER TABLE token_usage ADD COLUMN chain_position INTEGER NOT NULL DEFAULT 0` },
            { name: 'attempt_trail', ddl: `ALTER TABLE token_usage ADD COLUMN attempt_trail  TEXT    NOT NULL DEFAULT ''` },
            { name: 'routing_source', ddl: `ALTER TABLE token_usage ADD COLUMN routing_source TEXT    NOT NULL DEFAULT ''` },
        ];
        const cols6 = db.prepare(`PRAGMA table_info(token_usage)`).all();
        const existingRouting = new Set(cols6.map(c => c.name));
        for (const col of routingCols) {
            if (!existingRouting.has(col.name)) {
                db.exec(col.ddl);
            }
        }
        // The behaviour views group by route over a time window; without this the
        // per-route aggregation is a full scan of a table with ~400k rows.
        db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_route ON token_usage(route_key, timestamp)`);
    }
    catch (err) {
        process.stderr.write(`[token-usage] routing column migration failed (non-fatal): ${err.message}\n`);
    }
    // -----------------------------------------------------------------------
    // Turn identity + band provenance. Same PRAGMA-guarded, try/caught, additive
    // shape as every block above: a second startup runs zero ALTERs and a locked
    // ALTER never aborts boot.
    //
    // The routing columns answer "where did this ONE call go, and why". They
    // cannot answer "why did half of my question run on the local box?", because
    // nothing said the two rows were one turn. These three close that:
    // conversation_key + turn_index group the calls, band_source says who chose
    // the band that decided each one's fate.
    //
    // turn_index DEFAULT 0 is safe for the same reason chain_position's 0 is: 0
    // is reserved for "not recorded" and real turns are 1-based, so a legacy row
    // cannot impersonate the first turn of a conversation.
    // -----------------------------------------------------------------------
    try {
        const turnCols = [
            { name: 'conversation_key', ddl: `ALTER TABLE token_usage ADD COLUMN conversation_key TEXT    NOT NULL DEFAULT ''` },
            { name: 'turn_index', ddl: `ALTER TABLE token_usage ADD COLUMN turn_index       INTEGER NOT NULL DEFAULT 0` },
            { name: 'band_source', ddl: `ALTER TABLE token_usage ADD COLUMN band_source      TEXT    NOT NULL DEFAULT ''` },
        ];
        const cols7 = db.prepare(`PRAGMA table_info(token_usage)`).all();
        const existingTurn = new Set(cols7.map(c => c.name));
        for (const col of turnCols) {
            if (!existingTurn.has(col.name)) {
                db.exec(col.ddl);
            }
        }
        // The By-turn view pulls a recent tail and groups it; the index keeps that
        // from becoming a scan once the column is populated across ~400k rows.
        // Partial, because '' (not recorded) is the overwhelming majority today and
        // indexing it would be paying for the rows nobody groups.
        db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_turn
       ON token_usage(conversation_key, turn_index) WHERE conversation_key != ''`);
    }
    catch (err) {
        process.stderr.write(`[token-usage] turn column migration failed (non-fatal): ${err.message}\n`);
    }
    // -----------------------------------------------------------------------
    // project — which repo a call was for (see TokenUsageRow.project). Same shape
    // as every block above: PRAGMA-guarded, additive, non-fatal. Partial index for
    // the per-project rollups, which only ever group recorded rows.
    // -----------------------------------------------------------------------
    try {
        const cols8 = db.prepare(`PRAGMA table_info(token_usage)`).all();
        if (!cols8.some(c => c.name === 'project')) {
            db.exec(`ALTER TABLE token_usage ADD COLUMN project TEXT NOT NULL DEFAULT ''`);
        }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_project
       ON token_usage(project, timestamp) WHERE project != ''`);
    }
    catch (err) {
        process.stderr.write(`[token-usage] project column migration failed (non-fatal): ${err.message}\n`);
    }
    // -----------------------------------------------------------------------
    // Call facts — upstream + call_kind (see TokenUsageRow). Same shape as every
    // block above: PRAGMA-guarded, additive, non-fatal. No index: they are read
    // with a session's rows, which the task_id / timestamp indexes already find.
    // -----------------------------------------------------------------------
    try {
        const cols9 = db.prepare(`PRAGMA table_info(token_usage)`).all();
        const existingFacts = new Set(cols9.map(c => c.name));
        for (const name of ['upstream', 'call_kind']) {
            if (!existingFacts.has(name)) {
                db.exec(`ALTER TABLE token_usage ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
            }
        }
    }
    catch (err) {
        process.stderr.write(`[token-usage] call-facts column migration failed (non-fatal): ${err.message}\n`);
    }
    // -----------------------------------------------------------------------
    // Phase 83-02 (D-11): duplicate-id collision fix — request-id dedup index.
    //
    // The /v1/messages tap (this proxy) and the coding-side adapters
    // (lib/lsl/token/token-db.mjs insertTokenRow) BOTH write rows under the SAME
    // adapter user_hash ('cladpt'/'copadt') from SEPARATE connections, each
    // allocating id via a per-user_hash MAX(id)+1. Historically the proxy seeded
    // its id counter from the MACHINE hash (USER_HASH) even while STAMPING the
    // row's user_hash as the adapter hash — so the two id-spaces overlapped and a
    // concurrent write collided on the composite PK (user_hash, id), silently
    // DROPPING a distinct row (the best-effort try/catch swallowed the UNIQUE
    // throw). The reconcile matcher (Plan 03) makes row identity load-bearing.
    //
    // Fix, part 1 (here — schema): a PARTIAL UNIQUE index on
    // (user_hash, tool_call_id) WHERE tool_call_id != '' so a GENUINE duplicate
    // (the SAME upstream request-id under the SAME hash) is rejected/dedupable,
    // while the many tool_call_id='' background rows stay unconstrained (an empty
    // request-id is NOT an identity — never dedup those). Fix, part 2 (logCall):
    // DB-authoritative coordinated id allocation with retry-on-PK-conflict so two
    // DISTINCT racing rows both survive with distinct ids.
    //
    // PRAGMA-guarded + idempotent + non-fatal: `PRAGMA table_info` confirms the
    // tool_call_id column exists (added by the Phase 68 attribution block above);
    // `PRAGMA index_list` gates the whole block so a second startup is a no-op AND
    // the one-shot repair below never re-runs. Wrapped in try/catch with a
    // [token-usage] stderr line so a locked/failed migration never aborts startup.
    // Before CREATE UNIQUE INDEX, a best-effort in-place repair collapses any
    // PRE-EXISTING (user_hash, tool_call_id) duplicates (keep the earliest rowid —
    // the wire row the reconcile matcher deterministically prefers) so the index
    // build does not fail on legacy colliding rows (82-06 follow-up evidence:
    // duplicate ids exist in the live DB). The index name/shape is safe for the
    // coding-side second writer: insertTokenRowDeduped probes first, and a blind
    // insert of an exact duplicate is caught non-fatally there.
    // -----------------------------------------------------------------------
    try {
        const colsDup = db.prepare(`PRAGMA table_info(token_usage)`).all();
        const hasToolCallId = colsDup.some(c => c.name === 'tool_call_id');
        const indexes = db.prepare(`PRAGMA index_list(token_usage)`).all();
        const REQID_INDEX = 'idx_token_usage_reqid';
        const alreadyBuilt = indexes.some(i => i.name === REQID_INDEX);
        if (hasToolCallId && !alreadyBuilt) {
            // One-shot repair: collapse pre-existing (user_hash, tool_call_id)
            // duplicates among NON-EMPTY request-ids, keeping the earliest rowid.
            // Best-effort — a failure here still lets the CREATE below run (and if the
            // CREATE then fails on residual dupes, the outer catch logs it non-fatally).
            //
            // WR-04 (Phase 83 re-review): before deleting, GAP-FILL the survivor from
            // its doomed duplicates (mirroring MERGE_ON_CACHE semantics): when the
            // survivor (earliest rowid) is cache-less and a later duplicate carries the
            // cache split (the transcript-first / tap-later shape), the split would
            // otherwise be destroyed by the unconditional DELETE. Cache read+write are
            // taken from the SAME donor row (earliest cache-bearing duplicate);
            // reasoning is MAX across the group. Best-effort, runs once per DB
            // lifetime (gated by the index_list check above).
            let repaired = 0;
            try {
                const dupGroups = db.prepare(`
          SELECT user_hash, tool_call_id FROM token_usage
          WHERE tool_call_id != ''
          GROUP BY user_hash, tool_call_id
          HAVING COUNT(*) > 1
        `).all();
                if (dupGroups.length > 0) {
                    const groupRowsStmt = db.prepare(`
            SELECT rowid AS rid, cache_read_tokens, cache_write_tokens, reasoning_tokens
              FROM token_usage WHERE user_hash = ? AND tool_call_id = ? ORDER BY rowid
          `);
                    const mergeStmt = db.prepare(`
            UPDATE token_usage
               SET cache_read_tokens = ?, cache_write_tokens = ?,
                   reasoning_tokens = MAX(reasoning_tokens, ?)
             WHERE rowid = ?
          `);
                    for (const g of dupGroups) {
                        const rows = groupRowsStmt.all(g.user_hash, g.tool_call_id);
                        if (rows.length < 2)
                            continue;
                        const survivor = rows[0];
                        const doomed = rows.slice(1);
                        const survivorCacheLess = (survivor.cache_read_tokens ?? 0) + (survivor.cache_write_tokens ?? 0) === 0;
                        const donor = doomed.find(d => (d.cache_read_tokens ?? 0) + (d.cache_write_tokens ?? 0) > 0);
                        const maxDoomedReasoning = Math.max(0, ...doomed.map(d => d.reasoning_tokens ?? 0));
                        const fillCache = survivorCacheLess && donor !== undefined;
                        if (fillCache || maxDoomedReasoning > (survivor.reasoning_tokens ?? 0)) {
                            mergeStmt.run(fillCache ? (donor.cache_read_tokens ?? 0) : (survivor.cache_read_tokens ?? 0), fillCache ? (donor.cache_write_tokens ?? 0) : (survivor.cache_write_tokens ?? 0), maxDoomedReasoning, survivor.rid);
                        }
                    }
                }
            }
            catch (err) {
                process.stderr.write(`[token-usage] dup-id pre-delete merge skipped (non-fatal): ${err.message}\n`);
            }
            try {
                const info = db.prepare(`
          DELETE FROM token_usage
          WHERE tool_call_id != ''
            AND rowid NOT IN (
              SELECT MIN(rowid) FROM token_usage
              WHERE tool_call_id != ''
              GROUP BY user_hash, tool_call_id
            )
        `).run();
                repaired = info.changes;
            }
            catch (err) {
                process.stderr.write(`[token-usage] dup-id repair skipped (non-fatal): ${err.message}\n`);
            }
            db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${REQID_INDEX} ON token_usage(user_hash, tool_call_id) WHERE tool_call_id != ''`);
            if (repaired > 0) {
                process.stderr.write(`[token-usage] dup-id request-id index built; collapsed ${repaired} pre-existing duplicate row(s)\n`);
            }
        }
    }
    catch (err) {
        process.stderr.write(`[token-usage] dup-id request-id index migration failed (non-fatal): ${err.message}\n`);
    }
    // -----------------------------------------------------------------------
    // insertStmt now binds id explicitly (12th position becomes id; user_hash
    // is the 13th). Composite PK requires the caller to supply id — see
    // handle.nextLocalId() for JS-side assignment.
    // -----------------------------------------------------------------------
    const insertStmt = db.prepare(`
    INSERT INTO token_usage (
      id, timestamp, provider, model, process, subscription,
      input_tokens, output_tokens, total_tokens, latency_ms,
      prompt_preview, tokens_estimated, user_hash, model_raw, overhead_ms,
      agent, task_id, tool_call_id, parent_call_id, granularity_tier, reasoning_tokens,
      cache_read_tokens, cache_write_tokens,
      route_key, route_band, route_step, offloaded_from, chain_position,
      attempt_trail, routing_source,
      conversation_key, turn_index, band_source, project,
      upstream, call_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    // Local id counter for this machine's USER_HASH. Seeded LATE (after
    // hydrate runs, see below) so peer-row imports tagged with USER_HASH
    // (from the legacy monolithic file) don't get overwritten by the first
    // post-init logCall picking the same id.
    let _localIdSeq = 0;
    const seedLocalSeq = () => {
        try {
            const r = db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM token_usage WHERE user_hash = ?`).get(USER_HASH);
            _localIdSeq = r.next;
        }
        catch {
            _localIdSeq = 1;
        }
    };
    const handle = {
        db,
        insertStmt,
        nextLocalId: () => _localIdSeq++,
        // WR-08: monotonic resync after a DB-authoritative retry allocation.
        bumpLocalId: (id) => { if (id >= _localIdSeq)
            _localIdSeq = id + 1; },
    };
    hydrateFromExports(handle, overrideDataDir);
    seedLocalSeq();
    return handle;
}
/**
 * Phase 36 hydration: ALWAYS runs on proxy init (the old `count > 0 → return`
 * early-exit in `restoreFromJsonIfEmpty` was THE BUG — it prevented cross-user
 * merge after `git pull` of a peer's `_<other-hash>.json` file). Idempotency
 * is supplied by ON CONFLICT(user_hash, id) DO NOTHING, NOT by skipping.
 *
 * Walks `<baseDir>/**\/*.json` recursively, parses the 6-char hash suffix
 * from each filename via /_([a-z][a-z0-9]{5})\.json$/, and INSERTs every row
 * with ON CONFLICT(user_hash, id) DO NOTHING — the unique index handles
 * dedup silently.
 *
 * Legacy monolithic `token-usage.json` (no hash suffix in name) is tolerated:
 * its rows get tagged with USER_HASH (this machine's hash). Task 1's retag
 * aligned pre-existing DB rows with USER_HASH so ON CONFLICT(user_hash, id)
 * fires correctly and the monolith re-hydration does NOT duplicate rows.
 * Plan 36-05's migration deletes the legacy file entirely.
 */
export function hydrateFromExports(handle, overrideDataDir) {
    try {
        const baseDir = resolveTokenExportDir(overrideDataDir);
        if (!fs.existsSync(baseDir))
            return; // fresh install — no exports yet
        // Port of scripts/lsl-paths.js:lslListAll(). Recursive walk; skip
        // dot-dirs + node_modules; predicate `.json` (LSL uses `.md`).
        const ignoreDirs = new Set(['.git', 'node_modules']);
        const found = [];
        const walk = (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const e of entries) {
                if (e.isDirectory()) {
                    if (e.name.startsWith('.') || ignoreDirs.has(e.name))
                        continue;
                    walk(path.join(dir, e.name));
                }
                else if (e.name.endsWith('.json')) {
                    found.push(path.join(dir, e.name));
                }
            }
        };
        walk(baseDir);
        const FILENAME_RE = /_([a-z][a-z0-9]{5})\.json$/;
        // Composite PRIMARY KEY (user_hash, id) makes INSERT OR IGNORE silently
        // drop duplicates. Equivalent in behaviour to ON CONFLICT(user_hash, id)
        // DO NOTHING but matches the PK shape directly so SQLite accepts the
        // prepare without the legacy AUTOINCREMENT ambiguity.
        const insertOnConflict = handle.db.prepare(`
      INSERT OR IGNORE INTO token_usage (
        id, timestamp, provider, model, process, subscription,
        input_tokens, output_tokens, total_tokens, latency_ms,
        prompt_preview, tokens_estimated, user_hash, model_raw,
        cache_read_tokens, cache_write_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        let filesRead = 0;
        let rowsAttempted = 0;
        const ingestOne = handle.db.transaction((rows, fileHash) => {
            for (const r of rows) {
                const rowHashRaw = typeof r.user_hash === 'string' ? r.user_hash : '';
                const userHash = /^[a-z][a-z0-9]{5}$/.test(rowHashRaw) ? rowHashRaw : fileHash;
                // model_raw added to the export schema in this commit; older peer
                // files (pre-this-fix) lack the field — fall back to the row's
                // model so model_raw still has a value for forensic queries.
                const modelRaw = typeof r.model_raw === 'string' ? r.model_raw : r.model;
                insertOnConflict.run(r.id ?? null, r.timestamp, r.provider, r.model, r.process || 'unknown', r.subscription || 'unknown', r.input_tokens ?? 0, r.output_tokens ?? 0, r.total_tokens ?? 0, r.latency_ms ?? 0, r.prompt_preview || '', r.tokens_estimated ?? 0, userHash, modelRaw, 
                // WIRE-01 (Plan 82-01): older peer files (pre-this-fix) lack the cache
                // columns — coalesce to 0 so a mixed-vintage export dir hydrates
                // cleanly, exactly like the model_raw fallback above.
                r.cache_read_tokens ?? 0, r.cache_write_tokens ?? 0);
                rowsAttempted++;
            }
        });
        for (const filePath of found) {
            const m = path.basename(filePath).match(FILENAME_RE);
            const fileHash = m ? m[1] : USER_HASH;
            let rows;
            try {
                rows = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
            catch {
                continue;
            }
            if (!Array.isArray(rows))
                continue;
            try {
                ingestOne(rows, fileHash);
            }
            catch (err) {
                process.stderr.write(`[token-usage] hydrate file ${filePath} failed (non-fatal): ${err.message}\n`);
                continue;
            }
            filesRead++;
        }
        process.stderr.write(`[token-usage] hydrate: read ${filesRead} files, attempted ${rowsAttempted} inserts (conflicts silently skipped)\n`);
    }
    catch (err) {
        process.stderr.write(`[token-usage] hydrate failed (non-fatal): ${err.message}\n`);
    }
}
/**
 * Write the full token_usage table to JSON at the resolved export path.
 * The DB stays authoritative; the JSON is a git-trackable snapshot.
 *
 * Safety merge: if the existing export has rows whose ids aren't in the
 * DB (e.g. DB was reset locally), those historic rows are preserved and
 * the merged superset is written back. Mirrors ObservationExporter's
 * "_mergeWithExisting" pattern so a stale local DB can't wipe shared
 * history when several teammates push their exports.
 *
 * @deprecated Phase 36 replaces this with {@link exportToHourFile} which
 * writes per-(window, user_hash) files under `<baseDir>/YYYY/MM/` to
 * eliminate the merge-conflict surface of the monolithic export.
 * Retained so any external caller that still imports it keeps working
 * until Plan 36-05's migration removes the legacy file entirely.
 */
export function exportToJson(handle) {
    try {
        const exportPath = resolveTokenExportPath();
        fs.mkdirSync(path.dirname(exportPath), { recursive: true });
        const dbRows = handle.db.prepare(`
      SELECT id, timestamp, provider, model, process, subscription,
             input_tokens, output_tokens, total_tokens, latency_ms,
             prompt_preview, tokens_estimated, cache_read_tokens, cache_write_tokens
      FROM token_usage
      ORDER BY id ASC
    `).all();
        let merged = dbRows;
        try {
            const existing = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
            if (Array.isArray(existing) && existing.length > dbRows.length) {
                const dbIds = new Set(dbRows.map((r) => r.id));
                const preserved = existing.filter((r) => !dbIds.has(r.id));
                merged = [...preserved, ...dbRows];
                process.stderr.write(`[token-usage] Safety merge: kept ${preserved.length} historic + ${dbRows.length} current = ${merged.length} total\n`);
            }
        }
        catch { /* first export or unreadable — overwrite with dbRows */ }
        const content = JSON.stringify(merged, null, 2) + '\n';
        try {
            if (fs.readFileSync(exportPath, 'utf-8') === content)
                return; // no-op write
        }
        catch { /* file doesn't exist yet — write it */ }
        fs.writeFileSync(exportPath, content, 'utf-8');
    }
    catch (err) {
        process.stderr.write(`[token-usage] export failed (non-fatal): ${err.message}\n`);
    }
}
// Debounce window for the per-(window, user_hash) JSON export. logCall()
// runs once per LLM completion. Per-window keying via Map<window, Timer>
// allows two timers to coexist across an hour boundary — at XX:59:58 we
// key 'XX00-(XX+1)00', at XX:00:01 we key '(XX+1)00-(XX+2)00'. Both flush
// independently to their own file. The SELECT inside exportToHourFile
// filters timestamps right-exclusive so the 09:59:59 row lands in
// `…_0900-1000_…json` even if its flush runs at 10:00:00.something.
const EXPORT_DEBOUNCE_MS = 2000;
const _exportTimers = new Map();
function scheduleExport(handle, now = new Date()) {
    const windowKey = currentWindow(now);
    if (_exportTimers.has(windowKey))
        return;
    const t = setTimeout(() => {
        _exportTimers.delete(windowKey);
        exportToHourFile(handle, now);
    }, EXPORT_DEBOUNCE_MS);
    // Don't keep the process alive just for an export tick.
    t.unref();
    _exportTimers.set(windowKey, t);
}
/**
 * Persist one completion's token-usage row. Best-effort — never throws into
 * the request hot path; failure to log a row must not fail the LLM call.
 */
/**
 * A project id as it may be stored: one path-safe segment, at most 100 chars.
 * Anything else — a path, a header with a newline, '..' — records '' rather
 * than failing the call: a usage row with no project is a gap in a rollup, a
 * dropped row is a gap in the bill.
 */
export function sanitizeProject(value) {
    if (typeof value !== 'string')
        return '';
    const v = value.trim();
    if (!v || v.length > 100 || v === '.' || v === '..')
        return '';
    return /^[A-Za-z0-9._~@+-]+$/.test(v) ? v : '';
}
/**
 * An upstream as it may be stored: host[:port] only. A URL is reduced to its
 * host; userinfo, path and query never reach the row. Anything unparseable
 * records '' (a gap, not a dropped call).
 */
export function sanitizeUpstream(value) {
    if (typeof value !== 'string' || !value.trim())
        return '';
    const v = value.trim();
    try {
        return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`).host;
    }
    catch {
        return '';
    }
}
const CALL_KINDS = new Set(['main', 'subagent', 'side']);
export function logCall(handle, row) {
    try {
        // ATTR-05: per-row user_hash override (e.g. 'cladpt' for the /v1/messages
        // foreground passthrough); defaults to the module USER_HASH for all
        // existing callers.
        const effectiveUserHash = row.user_hash ?? USER_HASH;
        // Bind every column EXCEPT id (supplied per-attempt by the coordinated
        // allocator below). Column order mirrors insertStmt exactly.
        const bindWithId = (id) => {
            handle.insertStmt.run(id, row.timestamp, row.provider, row.model, row.process, row.subscription, row.input_tokens, row.output_tokens, row.total_tokens, row.latency_ms, row.prompt_preview, row.tokens_estimated, effectiveUserHash, row.model_raw ?? row.model, 
            // PERF-03 (Plan 66-03): bind the worker-pool overhead, else NULL. better-
            // sqlite3 requires an explicit null (undefined throws), so coalesce to null
            // for non-pool calls (direct-OAuth / execFile-overflow) and legacy callers.
            row.overhead_ms ?? null, 
            // TELEM-01 (Plan 68-01): cross-agent attribution fields. Coalesced to the
            // column defaults ('' / 0) so legacy callers that omit them write valid
            // rows that read back the empty-string / zero defaults.
            row.agent ?? '', row.task_id ?? '', row.tool_call_id ?? '', row.parent_call_id ?? '', row.granularity_tier ?? '', row.reasoning_tokens ?? 0, 
            // WIRE-01 (Plan 82-01): prompt-cache counters. Coalesced to 0 (the column
            // DEFAULT) so legacy callers that omit them write valid rows; kept SEPARATE
            // from total_tokens so cache-reads never inflate the fresh-input total.
            row.cache_read_tokens ?? 0, row.cache_write_tokens ?? 0, 
            // The routing decision. Coalesced to the column DEFAULTs so every caller
            // that predates these fields keeps writing valid rows.
            //
            // routing_source defaults to '' — NOT 'live'. A caller that does not
            // supply the decision has not observed one, and stamping it 'live' would
            // make an absence look like an observed chain_position of 0 (i.e. "no
            // fallback happened"), which is precisely the false certainty these
            // columns exist to remove.
            row.route_key ?? '', row.route_band ?? '', row.route_step ?? 0, row.offloaded_from ?? '', row.chain_position ?? 0, row.attempt_trail ?? '', row.routing_source ?? '', 
            // Turn identity + band provenance. Coalesced to the column DEFAULTs, so
            // a caller that predates them — or one that genuinely has no messages to
            // key on, like the file adapters — writes "not recorded" rather than a
            // fabricated turn 0 that would group with every other unkeyed row.
            row.conversation_key ?? '', row.turn_index ?? 0, row.band_source ?? '', sanitizeProject(row.project), sanitizeUpstream(row.upstream), CALL_KINDS.has(row.call_kind ?? '') ? row.call_kind : '');
        };
        // D-11: coordinated, DB-authoritative id allocation with retry-on-conflict.
        // For the MACHINE hash the in-process counter (handle.nextLocalId) is a fast
        // first guess. For an ADAPTER hash ('cladpt'/'copadt') — where the coding-side
        // second writer races us — allocate id straight from the ROW's OWN user_hash
        // space via MAX(id)+1 so we never reuse the machine-counter's value (the
        // historic collision). On an id collision (a concurrent writer grabbed the
        // same id) we recompute MAX(id)+1 and retry, so two DISTINCT racing rows both
        // survive with distinct ids.
        //
        // CRITICAL (live-caught): SQLite surfaces a composite-PRIMARY-KEY conflict as
        // error code SQLITE_CONSTRAINT_UNIQUE — the SAME code as a partial-unique-index
        // conflict — so the error CODE alone cannot tell an id-collision (retry) from a
        // request-id duplicate (drop). We disambiguate by PROBE, not code: dedup the
        // genuine (user_hash, tool_call_id) duplicate up front (and re-probe on any
        // constraint failure to close the probe→insert race); a constraint failure
        // that is NOT a request-id duplicate is an id collision → recompute + retry.
        const nextIdStmt = handle.db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM token_usage WHERE user_hash = ?`);
        const dedupStmt = handle.db.prepare(`SELECT 1 AS hit FROM token_usage WHERE user_hash = ? AND tool_call_id = ? LIMIT 1`);
        const tcid = row.tool_call_id ?? '';
        // A non-empty request-id is a genuine identity — dedup it (a real duplicate
        // must never double-count). An EMPTY tool_call_id is NOT an identity (many
        // unrelated background rows share ''), so those are never deduped.
        const isDupRequestId = () => tcid !== '' && !!dedupStmt.get(effectiveUserHash, tcid);
        // WR-03 (Phase 83 re-review): merge-on-cache on a dedup HIT — mirrors the
        // coding-side insertTokenRowDeduped (token-db.mjs). When the EXISTING row is
        // cache-less (e.g. a stop-time transcript row that landed first across a
        // proxy restart) and the INCOMING row carries the real cache split or
        // nonzero reasoning, enrich the existing row IN PLACE instead of silently
        // discarding the richer duplicate. The UPDATE fires only when the existing
        // cache sum is 0, so it is overwrite-once — never additive (no
        // double-count). Best-effort: any failure degrades to the plain drop.
        const mergeOnCacheIfRicher = () => {
            try {
                const existing = handle.db.prepare(`SELECT cache_read_tokens, cache_write_tokens, reasoning_tokens
             FROM token_usage WHERE user_hash = ? AND tool_call_id = ? LIMIT 1`).get(effectiveUserHash, tcid);
                if (!existing)
                    return;
                const existingCacheLess = (existing.cache_read_tokens ?? 0) + (existing.cache_write_tokens ?? 0) === 0;
                const incomingHasCache = (row.cache_read_tokens ?? 0) + (row.cache_write_tokens ?? 0) > 0;
                const incomingHasReasoning = (row.reasoning_tokens ?? 0) > 0;
                if (existingCacheLess && (incomingHasCache || incomingHasReasoning)) {
                    handle.db.prepare(`UPDATE token_usage
                SET cache_read_tokens = ?,
                    cache_write_tokens = ?,
                    reasoning_tokens = MAX(reasoning_tokens, ?)
              WHERE user_hash = ? AND tool_call_id = ?`).run(row.cache_read_tokens ?? 0, row.cache_write_tokens ?? 0, row.reasoning_tokens ?? 0, effectiveUserHash, tcid);
                    scheduleExport(handle);
                }
            }
            catch (err) {
                process.stderr.write(`[token-usage] dedup merge-on-cache failed (non-fatal): ${err.message}\n`);
            }
        };
        if (isDupRequestId()) {
            mergeOnCacheIfRicher();
            return;
        } // duplicate — enrich-or-drop, never double-count
        const MAX_ID_RETRIES = 5;
        for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt++) {
            let id;
            if (effectiveUserHash === USER_HASH && attempt === 0) {
                id = handle.nextLocalId();
            }
            else {
                const r = nextIdStmt.get(effectiveUserHash);
                id = r?.next ?? 1;
            }
            try {
                bindWithId(id);
                // WR-08: after a machine-hash insert whose id was allocated from the DB
                // (a collision retry — attempt > 0), resync the in-process counter so it
                // does not stay permanently behind and pay a failed INSERT + probe on
                // every future call. Monotonic no-op on the fast attempt-0 path.
                if (effectiveUserHash === USER_HASH)
                    handle.bumpLocalId?.(id);
                break; // inserted successfully
            }
            catch (err) {
                const code = err.code;
                if (code && code.startsWith('SQLITE_CONSTRAINT')) {
                    // Close the probe→insert race: if a concurrent writer landed the same
                    // request-id between our up-front probe and this insert, it's now a
                    // genuine duplicate → enrich-or-drop (WR-03), do NOT retry.
                    if (isDupRequestId()) {
                        mergeOnCacheIfRicher();
                        return;
                    }
                    // Otherwise this is an id collision on the composite PK — recompute
                    // MAX(id)+1 and retry so the distinct row survives.
                    if (attempt < MAX_ID_RETRIES - 1)
                        continue;
                }
                throw err;
            }
        }
        // Debounced JSON snapshot — see scheduleExport()'s rationale.
        scheduleExport(handle);
    }
    catch (err) {
        process.stderr.write(`[token-usage] logCall failed (non-fatal): ${err.message}\n`);
    }
}
/**
 * Bucket size scales with the span the timeline covers so the series stays
 * bounded (~300-500 buckets max) no matter whether the caller asks for the
 * last 24h or the full DB. Callers can still override via opts.bucketMinutes.
 */
function defaultBucketMinutes(hours) {
    if (hours <= 24)
        return 2; // ≤720 buckets
    if (hours <= 72)
        return 10; // ≤432
    if (hours <= 168)
        return 30; // ≤336 (7d)
    if (hours <= 720)
        return 120; // ≤360 (30d)
    return 360; // 6h buckets for "all" / multi-month windows
}
/**
 * Aggregate summary over the trailing N-hour window. Shape matches what the
 * coding system-health-dashboard's Token Usage tab consumes.
 *
 * `by_process_hour` / `by_model_hour` are pivoted, zero-filled stacked series
 * (one row per bucket, one column per process/model) so recharts can render
 * them as stacked area charts without further client-side pivoting.
 *
 * `by_model[]` rows additionally carry `p50_latency_ms` (Plan 66-01, median
 * total latency) and `p50_overhead_ms` (Plan 66-03, PERF-03 — median
 * worker-pool spawn/queue overhead, computed only over rows WHERE overhead_ms
 * IS NOT NULL; absent on a model with no non-null overhead rows).
 */
/**
 * The `user_hash` values written by an AGENT ADAPTER rather than by the proxy's
 * own background telemetry — i.e. the rows that represent a human waiting at a
 * prompt.
 *
 * Normal proxy telemetry omits `user_hash` and gets the module-level USER_HASH
 * (the machine hash), which is what makes everything else background. The split
 * is an allow-list rather than "anything that is not the machine hash" for two
 * reasons: a second machine's hash must not read as foreground, and the junk
 * hashes every long-lived telemetry DB accumulates (`seed-demo`, `fake-process`)
 * must not either. Unknown therefore means background, which fails toward
 * understating foreground rather than inflating it.
 *
 * Add a new agent's adapter hash HERE when one is introduced; nothing else
 * needs to change.
 */
export const FOREGROUND_USER_HASHES = ['cladpt', 'opnadt', 'opcadt', 'copadt', 'piadpt'];
/**
 * SQL fragment + bindings restricting a query to one side of the split.
 *
 * Returned as a fragment rather than applied by string interpolation of the
 * hashes so the values stay bound parameters.
 */
export function scopeClause(scope) {
    const list = FOREGROUND_USER_HASHES;
    const holes = list.map(() => '?').join(', ');
    if (scope === 'fg')
        return { sql: ` AND user_hash IN (${holes})`, params: [...list] };
    if (scope === 'bg')
        return { sql: ` AND (user_hash IS NULL OR user_hash NOT IN (${holes}))`, params: [...list] };
    return { sql: '', params: [] };
}
/**
 * Account id ← every other spelling token_usage rows carry for it. Rows written
 * before the account-id change still hold the old wire labels; an exclusion by
 * account must drop those too, or "hide GitHub Copilot" leaves its `copilot`
 * rows behind. Same table as the dashboard's PROVIDER_ALIASES (src/lib/providers.ts).
 */
export const ACCOUNT_ALIASES = {
    'copilot': 'gh-copilot',
    'github-copilot': 'gh-copilot',
    'github': 'gh-copilot',
    'claude-code': 'claude-code-max',
    'anthropic': 'claude-code-max',
    'max-subscription': 'claude-code-max',
};
/** The billed account a provider spelling belongs to (lower-cased). */
export function accountOf(provider) {
    const key = String(provider ?? '').trim().toLowerCase();
    return ACCOUNT_ALIASES[key] ?? key;
}
/**
 * SQL fragment + bindings dropping the rows of the excluded accounts — the
 * operator's "which accounts count" selection. An account id expands to every
 * spelling that maps to it. Empty / absent → no filter.
 */
export function accountClause(exclude) {
    const accounts = new Set((exclude ?? []).map((a) => accountOf(a)).filter(Boolean));
    if (!accounts.size)
        return { sql: '', params: [] };
    const spellings = new Set(accounts);
    for (const [alias, account] of Object.entries(ACCOUNT_ALIASES))
        if (accounts.has(account))
            spellings.add(alias);
    const list = [...spellings];
    return { sql: ` AND LOWER(TRIM(COALESCE(provider, ''))) NOT IN (${list.map(() => '?').join(', ')})`, params: list };
}
/** Both view filters as one fragment: the fg/bg split, then the account selection. */
function viewClause(scope, exclude) {
    const split = scopeClause(scope);
    const accounts = accountClause(exclude);
    return { sql: split.sql + accounts.sql, params: [...split.params, ...accounts.params] };
}
export function getSummary(handle, opts = {}) {
    const hours = opts.hours ?? 24;
    // Foreground/background restriction, applied to EVERY aggregate below so the
    // headline, the breakdowns and the stacked series all describe the same set
    // of rows. A scope that reached only some of them would be worse than none.
    const scope = opts.scope ?? 'both';
    const sc = viewClause(scope, opts.exclude);
    // For very wide windows (e.g. `hours=all` which is internally 10y) the
    // raw start would be far older than any real row — the zero-fill loop
    // would then emit thousands of empty buckets. Clamp to the earliest
    // actual timestamp in the DB so the timeline starts where data exists.
    const rawSince = Date.now() - hours * 3600_000;
    const earliestRow = handle.db.prepare(`SELECT MIN(timestamp) AS earliest FROM token_usage`).get();
    const earliestMs = earliestRow.earliest ? Date.parse(earliestRow.earliest) : rawSince;
    const sinceMs = Math.max(rawSince, earliestMs);
    const since = new Date(sinceMs).toISOString();
    // Size buckets from the span actually shown, not the one requested: on a DB
    // younger than the window, "7 days" and "all" cover the same rows as "48h"
    // and must draw the same chart — not 30-minute or 6-hour buckets smoothed
    // into a handful of points.
    const shownHours = Math.max(0, (Date.now() - sinceMs) / 3600_000);
    const bucketMinutes = Math.max(1, opts.bucketMinutes ?? defaultBucketMinutes(shownHours));
    const bucketSeconds = bucketMinutes * 60;
    const totals = handle.db.prepare(`
    SELECT COUNT(*) AS calls,
           COALESCE(SUM(input_tokens),  0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(total_tokens),  0) AS total_tokens,
           COALESCE(SUM(cache_read_tokens),  0) AS cache_read_tokens,
           COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(ROUND(AVG(latency_ms)), 0) AS avg_latency_ms
    FROM token_usage WHERE timestamp >= ?${sc.sql}
  `).get(since, ...sc.params);
    const by_process = handle.db.prepare(`
    SELECT process,
           COUNT(*) AS calls,
           SUM(input_tokens)  AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(total_tokens)  AS total_tokens,
           SUM(cache_read_tokens)  AS cache_read_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens,
           ROUND(AVG(latency_ms)) AS avg_latency
    FROM token_usage WHERE timestamp >= ?${sc.sql}
    GROUP BY process ORDER BY (total_tokens + cache_read_tokens + cache_write_tokens) DESC
  `).all(since, ...sc.params);
    const by_provider = handle.db.prepare(`
    SELECT provider,
           COUNT(*) AS calls,
           SUM(input_tokens)  AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(total_tokens)  AS total_tokens,
           SUM(cache_read_tokens)  AS cache_read_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens
    FROM token_usage WHERE timestamp >= ?${sc.sql}
    GROUP BY provider ORDER BY (total_tokens + cache_read_tokens + cache_write_tokens) DESC
  `).all(since, ...sc.params);
    const by_model = handle.db.prepare(`
    SELECT model,
           COUNT(*) AS calls,
           SUM(total_tokens) AS total_tokens,
           SUM(cache_read_tokens)  AS cache_read_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens,
           ROUND(AVG(latency_ms)) AS avg_latency
    FROM token_usage WHERE timestamp >= ?${sc.sql}
    GROUP BY model ORDER BY (total_tokens + cache_read_tokens + cache_write_tokens) DESC
  `).all(since, ...sc.params);
    // Same aggregate, split by the ACCOUNT that served it. A bare model name does
    // not say what a call cost: `claude-sonnet-5` on the corporate Copilot
    // contract and the same model on a metered Anthropic key have completely
    // different consequences, and the model-keyed rows above cannot tell them
    // apart. This is what the dashboard's By Model table renders, as
    // `<provider>/<model>`.
    //
    // Kept SEPARATE from by_model rather than replacing it: by_model feeds the
    // zero-filled `by_model_hour` pivot below, whose column keys must stay one per
    // model, so widening its GROUP BY would produce duplicate series keys.
    const by_provider_model = handle.db.prepare(`
    SELECT provider,
           model,
           COUNT(*) AS calls,
           SUM(total_tokens) AS total_tokens,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           -- Without these two a Claude Code row reads as ~800 tokens when the
           -- turn really cost ~470K: on the Anthropic wire almost the entire
           -- prompt arrives as a cache read, and total_tokens counts only fresh
           -- input + output. Every consumer that ranks or sums models needs them.
           SUM(cache_read_tokens)  AS cache_read_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens,
           ROUND(AVG(latency_ms)) AS avg_latency
    FROM token_usage WHERE timestamp >= ?${sc.sql}
    GROUP BY provider, model ORDER BY (total_tokens + cache_read_tokens + cache_write_tokens) DESC
  `).all(since, ...sc.params);
    // Per-model MEDIAN(latency_ms) over the SAME clamped `since` window (D-05).
    // SQLite has no native MEDIAN, so for each by_model row we take the
    // latency_ms at ORDER BY latency_ms LIMIT 1 OFFSET (count-1)/2 — the
    // LOWER-MID element for even counts, the true middle for odd counts.
    // Reported over ALL in-window rows for the model including cold spawns
    // (D-06 — no warm/cold or provider filter; Plan 66-02 owns the per-provider
    // regression threshold). Best-effort like the surrounding aggregates: a
    // malformed/empty DB leaves p50_latency_ms absent rather than throwing into
    // the summary hot path (mirrors logCall's try/catch). ALL values (`since`,
    // model, offset) are passed as bound `?` parameters — never interpolated.
    try {
        const p50Stmt = handle.db.prepare(`
      SELECT latency_ms AS p50_latency_ms
      FROM token_usage
      WHERE model = ? AND timestamp >= ?
      ORDER BY latency_ms
      LIMIT 1 OFFSET ?
    `);
        for (const row of by_model) {
            const model = String(row.model);
            const count = Number(row.calls) || 0;
            if (count <= 0)
                continue;
            const offset = Math.floor((count - 1) / 2);
            const med = p50Stmt.get(model, since, offset);
            if (med && med.p50_latency_ms != null) {
                row.p50_latency_ms = med.p50_latency_ms;
            }
        }
    }
    catch (err) {
        process.stderr.write(`[token-usage] p50 median query failed (non-fatal): ${err.message}\n`);
    }
    // Phase 66-03 (PERF-03): per-model MEDIAN(overhead_ms) — the worker-pool
    // spawn/queue overhead median over the SAME clamped `since` window. Mirrors
    // the p50_latency_ms block above with one CRITICAL difference (WR-02 from
    // 66-REVIEW.md): the median is computed ONLY over rows that HAVE an overhead
    // value (WHERE overhead_ms IS NOT NULL), and the OFFSET uses the COUNT of
    // those non-null rows — NOT row.calls, which counts ALL rows (incl. legacy
    // NULL-overhead and direct/haiku NULL rows). Counting NULLs in the offset
    // would skew the selected element. A model with zero non-null overhead rows
    // leaves p50_overhead_ms absent (no throw). Best-effort try/catch (T-66-03-02);
    // ALL values (`model`, `since`, `offset`) bound as `?` — never interpolated
    // (T-66-03-01 SQLi invariant, preserves the 66-01 T-66-01-01 invariant).
    try {
        const overheadCountStmt = handle.db.prepare(`
      SELECT COUNT(*) AS n
      FROM token_usage
      WHERE model = ? AND timestamp >= ? AND overhead_ms IS NOT NULL
    `);
        const p50OverheadStmt = handle.db.prepare(`
      SELECT overhead_ms AS p50_overhead_ms
      FROM token_usage
      WHERE model = ? AND timestamp >= ? AND overhead_ms IS NOT NULL
      ORDER BY overhead_ms
      LIMIT 1 OFFSET ?
    `);
        for (const row of by_model) {
            const model = String(row.model);
            const cnt = overheadCountStmt.get(model, since);
            const n = Number(cnt?.n) || 0;
            if (n <= 0)
                continue; // no non-null overhead rows -> leave the field absent
            const offset = Math.floor((n - 1) / 2);
            const med = p50OverheadStmt.get(model, since, offset);
            if (med && med.p50_overhead_ms != null) {
                row.p50_overhead_ms = med.p50_overhead_ms;
            }
        }
    }
    catch (err) {
        process.stderr.write(`[token-usage] p50_overhead_ms median query failed (non-fatal): ${err.message}\n`);
    }
    const by_subscription = handle.db.prepare(`
    SELECT subscription,
           COUNT(*) AS calls,
           SUM(total_tokens) AS total_tokens,
           SUM(cache_read_tokens)  AS cache_read_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens
    FROM token_usage WHERE timestamp >= ?${sc.sql}
    GROUP BY subscription ORDER BY (total_tokens + cache_read_tokens + cache_write_tokens) DESC
  `).all(since, ...sc.params);
    // Group only populated buckets in SQL (cheap), then materialise the full
    // series start→now in JS, zero-filling missing buckets. This way the chart
    // shows real gaps as flat zero instead of smooth interpolation across them.
    // `hour` is emitted as full UTC ISO with Z so the dashboard's `new Date()`
    // parse + toLocaleTimeString() correctly shifts to the viewer's local zone.
    const populated = handle.db.prepare(`
    SELECT (strftime('%s', timestamp) / ${bucketSeconds}) * ${bucketSeconds} AS bucket_sec,
           SUM(input_tokens)  AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(cache_read_tokens)  AS cache_read_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens,
           COUNT(*) AS calls
    FROM token_usage WHERE timestamp >= ?${sc.sql}
    GROUP BY bucket_sec ORDER BY bucket_sec
  `).all(since, ...sc.params);
    const bucketMap = new Map();
    for (const b of populated)
        bucketMap.set(Number(b.bucket_sec), b);
    const startSec = Math.floor(Date.parse(since) / 1000 / bucketSeconds) * bucketSeconds;
    const endSec = Math.floor(Date.now() / 1000 / bucketSeconds) * bucketSeconds;
    const by_hour = [];
    for (let s = startSec; s <= endSec; s += bucketSeconds) {
        const b = bucketMap.get(s);
        by_hour.push({
            hour: new Date(s * 1000).toISOString(),
            input_tokens: b?.input_tokens ?? 0,
            output_tokens: b?.output_tokens ?? 0,
            cache_read_tokens: b?.cache_read_tokens ?? 0,
            cache_write_tokens: b?.cache_write_tokens ?? 0,
            calls: b?.calls ?? 0,
        });
    }
    // Stacked-by-process-per-bucket series. Pivoted to row-per-bucket shape so
    // recharts can stack columns directly. process_keys is the column order
    // (ranked by total tokens descending so the largest consumer is the bottom
    // of the stack).
    const processBuckets = handle.db.prepare(`
    SELECT (strftime('%s', timestamp) / ${bucketSeconds}) * ${bucketSeconds} AS bucket_sec,
           process,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens
    FROM token_usage WHERE timestamp >= ?${sc.sql}
    GROUP BY bucket_sec, process
    ORDER BY bucket_sec
  `).all(since, ...sc.params);
    const process_keys = by_process
        .map(p => String(p.process));
    const processBucketMap = new Map();
    for (const row of processBuckets) {
        const k = Number(row.bucket_sec);
        let slot = processBucketMap.get(k);
        if (!slot) {
            slot = {};
            processBucketMap.set(k, slot);
        }
        slot[row.process] = (slot[row.process] || 0) + Number(row.total_tokens || 0);
    }
    const by_process_hour = [];
    for (let s = startSec; s <= endSec; s += bucketSeconds) {
        const row = { hour: new Date(s * 1000).toISOString() };
        const slot = processBucketMap.get(s) || {};
        for (const k of process_keys)
            row[k] = slot[k] || 0;
        by_process_hour.push(row);
    }
    // Same pivoting for model — used by the Evolution tab to show which models
    // were spending tokens over the window.
    const modelBuckets = handle.db.prepare(`
    SELECT (strftime('%s', timestamp) / ${bucketSeconds}) * ${bucketSeconds} AS bucket_sec,
           model,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens
    FROM token_usage WHERE timestamp >= ?${sc.sql}
    GROUP BY bucket_sec, model
    ORDER BY bucket_sec
  `).all(since, ...sc.params);
    const model_keys = by_model
        .map(m => String(m.model));
    const modelBucketMap = new Map();
    for (const row of modelBuckets) {
        const k = Number(row.bucket_sec);
        let slot = modelBucketMap.get(k);
        if (!slot) {
            slot = {};
            modelBucketMap.set(k, slot);
        }
        slot[row.model] = (slot[row.model] || 0) + Number(row.total_tokens || 0);
    }
    const by_model_hour = [];
    for (let s = startSec; s <= endSec; s += bucketSeconds) {
        const row = { hour: new Date(s * 1000).toISOString() };
        const slot = modelBucketMap.get(s) || {};
        for (const k of model_keys)
            row[k] = slot[k] || 0;
        by_model_hour.push(row);
    }
    // Same pivoting for provider — used by the Evolution tab "By Provider" view.
    const providerBuckets = handle.db.prepare(`
    SELECT (strftime('%s', timestamp) / ${bucketSeconds}) * ${bucketSeconds} AS bucket_sec,
           provider,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens
    FROM token_usage WHERE timestamp >= ?${sc.sql}
    GROUP BY bucket_sec, provider
    ORDER BY bucket_sec
  `).all(since, ...sc.params);
    const provider_keys = by_provider
        .map(p => String(p.provider));
    const providerBucketMap = new Map();
    for (const row of providerBuckets) {
        const k = Number(row.bucket_sec);
        let slot = providerBucketMap.get(k);
        if (!slot) {
            slot = {};
            providerBucketMap.set(k, slot);
        }
        slot[row.provider] = (slot[row.provider] || 0) + Number(row.total_tokens || 0);
    }
    const by_provider_hour = [];
    for (let s = startSec; s <= endSec; s += bucketSeconds) {
        const row = { hour: new Date(s * 1000).toISOString() };
        const slot = providerBucketMap.get(s) || {};
        for (const k of provider_keys)
            row[k] = slot[k] || 0;
        by_provider_hour.push(row);
    }
    // Opt-in: the priceable breakdown (see SummaryCell). Absent by default so the
    // token view's payload — polled every 30s — does not grow by a table it never
    // reads.
    const cells = opts.cells
        ? handle.db.prepare(`
        SELECT (strftime('%s', timestamp) / ${bucketSeconds}) * ${bucketSeconds} AS bucket_sec,
               process, provider, model,
               COUNT(*) AS calls,
               SUM(input_tokens)  AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens)  AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens
        FROM token_usage WHERE timestamp >= ?${sc.sql}
        GROUP BY bucket_sec, process, provider, model
        ORDER BY bucket_sec
      `).all(since, ...sc.params).map((c) => ({
            hour: new Date(Number(c.bucket_sec) * 1000).toISOString(),
            process: String(c.process),
            provider: String(c.provider),
            model: String(c.model),
            calls: Number(c.calls) || 0,
            input_tokens: Number(c.input_tokens) || 0,
            output_tokens: Number(c.output_tokens) || 0,
            cache_read_tokens: Number(c.cache_read_tokens) || 0,
            cache_write_tokens: Number(c.cache_write_tokens) || 0,
        }))
        : undefined;
    return {
        hours,
        bucket_minutes: bucketMinutes,
        scope,
        total_calls: totals.calls,
        total_input: totals.input_tokens,
        total_output: totals.output_tokens,
        total_tokens: totals.total_tokens,
        total_cache_read: totals.cache_read_tokens,
        total_cache_write: totals.cache_write_tokens,
        avg_latency_ms: totals.avg_latency_ms,
        by_process, by_provider, by_model, by_provider_model, by_subscription, by_hour,
        process_keys, model_keys, provider_keys, by_process_hour, by_model_hour, by_provider_hour,
        ...(cells ? { cells, local_providers: localProviders(handle) } : {}),
    };
}
/**
 * Providers that have served an OFFLOADED call — the user's own hardware.
 *
 * A pricing read needs to know which accounts cost nothing per token, and the
 * provider id cannot say: glass names the offload target after whatever the
 * user typed (`team-qwen`, `lab-cluster`). `offloaded_from` is set on exactly
 * the rows that target served, so it is the one signal that holds on every
 * installation. Except: coding's router stamps it on a call that was offered to
 * the offload chain and then served by the original provider after all (6.5K
 * gh-copilot rows with offloaded_from = gh-copilot) — so a row only counts when
 * someone else served it.
 */
export function localProviders(handle) {
    return handle.db.prepare(`SELECT DISTINCT provider FROM token_usage WHERE offloaded_from != '' AND provider != offloaded_from`).all().map((r) => r.provider);
}
/**
 * Most-recent rows for the live activity feed. Capped at 500 to keep the
 * dashboard payload bounded.
 */
export function getRecent(handle, opts = {}) {
    const limit = Math.min(opts.limit ?? 50, 500);
    const scope = opts.scope ?? 'both';
    // Same scopeClause the summary and cost endpoints use. Deliberately not a
    // second definition of the split: a board that filtered foreground rows
    // differently from the headline that counts them would be worse than no
    // filter at all.
    //
    // Filtered in SQL rather than after the fact, because the LIMIT applies to
    // the filtered set — filtering 500 mixed rows down in JS yields however many
    // happen to be foreground, which on a machine whose background services
    // outnumber turns ~10:1 is an arbitrarily short and misleading list.
    const { sql, params } = viewClause(scope, opts.exclude);
    const data = handle.db.prepare(`SELECT * FROM token_usage WHERE 1=1${sql} ORDER BY timestamp DESC LIMIT ?`).all(...params, limit);
    return { data, scope };
}
/**
 * Monthly cost breakdown: raw token sums grouped by month × provider × model ×
 * process so the dashboard Cost tab can multiply by the operator-configured
 * price table client-side (prices live in llm-settings.json → cost.modelPrices;
 * edits take effect instantly without a proxy round-trip). No cost math here —
 * this is a pure aggregation.
 *
 * months = how many calendar months back to include (clamped to 1..36). The
 * cutoff is the first day of the month (months-1) back, in UTC (timestamps are
 * ISO-8601 UTC; month bucketing is substr(timestamp,1,7) = 'YYYY-MM').
 */
export function getCost(handle, opts = {}) {
    const months = Math.min(36, Math.max(1, opts.months ?? 6));
    const now = opts.now ?? new Date();
    const cut = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
    const since = cut.toISOString();
    const ac = accountClause(opts.exclude);
    const rows = handle.db.prepare(`
    SELECT
      substr(timestamp,1,7)                     AS month,
      provider,
      model,
      process,
      -- Which side of the foreground/background split this row is on.
      -- Derived here rather than left to the client so the hash convention
      -- (see FOREGROUND_USER_HASHES) lives in exactly one place.
      CASE WHEN user_hash IN (${FOREGROUND_USER_HASHES.map(() => '?').join(', ')}) THEN 'fg' ELSE 'bg' END AS scope,
      COALESCE(subscription,'')                 AS subscription,
      COUNT(*)                                  AS calls,
      SUM(COALESCE(input_tokens,0))             AS input_tokens,
      SUM(COALESCE(output_tokens,0))            AS output_tokens,
      SUM(COALESCE(cache_read_tokens,0))        AS cache_read_tokens,
      SUM(COALESCE(cache_write_tokens,0))       AS cache_write_tokens,
      SUM(CASE WHEN tokens_estimated=1 THEN 1 ELSE 0 END) AS estimated_calls
    FROM token_usage
    WHERE timestamp >= ?${ac.sql}
    GROUP BY month, provider, model, process, scope
    ORDER BY month DESC, input_tokens DESC
  `).all(...FOREGROUND_USER_HASHES, since, ...ac.params);
    return { since, months, generatedAt: now.toISOString(), rows, local_providers: localProviders(handle) };
}
/**
 * Phase 36-06 one-shot backfill: walk all rows whose `model_raw` is NULL
 * (i.e. pre-36-06 rows), apply the supplied canonicalizer to `model`, and
 * record the original spelling in `model_raw`. Wrapped in a single
 * transaction for atomicity + speed; idempotent — subsequent boots find
 * 0 NULL-model_raw rows and exit quickly.
 *
 * The canonicalizer lives in server.mjs (provider-aware) so this function
 * stays in the persistence layer without coupling to provider names.
 */
export function backfillCanonicalModelNames(handle, canonicalizer) {
    const rows = handle.db.prepare(`
    SELECT rowid AS rowid, model FROM token_usage WHERE model_raw IS NULL
  `).all();
    if (rows.length === 0)
        return { scanned: 0, rewritten: 0 };
    const update = handle.db.prepare(`
    UPDATE token_usage SET model = ?, model_raw = ? WHERE rowid = ?
  `);
    let rewritten = 0;
    handle.db.transaction((batch) => {
        for (const r of batch) {
            const raw = r.model;
            const canonical = canonicalizer(raw);
            update.run(canonical, raw, r.rowid);
            if (canonical !== raw)
                rewritten++;
        }
    })(rows);
    return { scanned: rows.length, rewritten };
}
/**
 * Every billed account with rows in the DB, canonical ids, for the account
 * selection — read without any exclusion, so a hidden account stays listed and
 * can be switched back on.
 */
export function getAccounts(handle) {
    const rows = handle.db.prepare(`SELECT provider, COUNT(*) AS calls FROM token_usage GROUP BY provider`).all();
    const byAccount = new Map();
    for (const r of rows) {
        const a = accountOf(r.provider);
        if (a)
            byAccount.set(a, (byAccount.get(a) ?? 0) + r.calls);
    }
    return [...byAccount].map(([account, calls]) => ({ account, calls })).sort((a, b) => b.calls - a.calls);
}
