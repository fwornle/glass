// proxy-bridge/usage-api.mjs
//
// The read endpoints the dashboard polls: token-usage summary / cost / recent
// and the per-run context breakdown + context turns. Shared by server.mjs and
// glass's daemon; neither routes nor forwards anything.

import { getSummary, getRecent, getCost, getAccounts, accountOf } from '../dist/token-usage.js';

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  return res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const dbMissing = (res) => json(res, 503, { error: 'token-usage DB not initialized' });
const at = (req, route) => req.url === route || req.url?.startsWith(`${route}?`);

// scope = fg | bg | both (default). Restricts EVERY aggregate to one side of the
// foreground/background split, so the headline, the breakdowns and the stacked
// series always describe the same set of rows. An unrecognised value falls back
// to `both` rather than 400-ing: this is a view filter, and refusing to render is
// a worse answer than rendering everything.
const scopeOf = (url) => {
  const raw = url.searchParams.get('scope');
  return raw === 'fg' || raw === 'bg' ? raw : 'both';
};

/**
 * @param {{ tokenDb: () => object|null, measurement: object,
 *           accounts?: { excluded: () => string[], setExcluded?: (list: string[]) => void } }} deps
 *   tokenDb returns the live handle (null while the DB is unavailable → 503).
 *   accounts is the host's saved "which accounts count" selection (coding: the
 *   proxy's cost settings; glass: ~/.glass/cost.json). Without it nothing is
 *   excluded and the selection is read-only.
 * @returns {(req, res) => boolean} serves a read and returns true, or returns false
 */
export function createUsageApi({ tokenDb, measurement, accounts }) {
  const savedExcluded = () => {
    try { return (accounts?.excluded() ?? []).map(accountOf).filter(Boolean); } catch { return []; }
  };
  // The saved selection applies to every read by default, so every consumer —
  // dashboard, status line, coordinator — sees the same filtered data without
  // having to know the setting. `?exclude=a,b` overrides it for one request, and
  // a bare `?exclude=` asks for everything.
  const excludeOf = (url) => (url.searchParams.has('exclude')
    ? url.searchParams.get('exclude').split(',').map((a) => accountOf(a)).filter(Boolean)
    : savedExcluded());

  return function handleUsageRead(req, res) {
    // The account selection: GET lists every account with rows (unfiltered, so a
    // hidden one can be switched back on) and the excluded ones; PUT saves them.
    if (at(req, '/api/token-usage/accounts')) {
      const handle = tokenDb();
      if (!handle?.db) { dbMissing(res); return true; }
      const view = () => ({ accounts: getAccounts(handle), excluded: savedExcluded(), writable: Boolean(accounts?.setExcluded) });
      if (req.method === 'GET') { json(res, 200, view()); return true; }
      if (req.method === 'PUT') {
        if (!accounts?.setExcluded) { json(res, 405, { error: 'this host has no writable account selection' }); return true; }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const list = JSON.parse(body || '{}').excluded;
            if (!Array.isArray(list) || !list.every((a) => typeof a === 'string')) {
              return json(res, 400, { error: 'body must be { "excluded": ["<account>", …] }' });
            }
            accounts.setExcluded([...new Set(list.map(accountOf).filter(Boolean))]);
            json(res, 200, view());
          } catch (err) {
            json(res, 400, { error: err.message });
          }
        });
        return true;
      }
      return false;
    }

    if (req.method !== 'GET') return false;

    if (req.url?.startsWith('/api/token-usage/summary')) {
      const handle = tokenDb();
      if (!handle) { dbMissing(res); return true; }
      try {
        const url = new URL(req.url, 'http://localhost');
        // `hours=all` is a sentinel for "everything in the DB" — picks a
        // 10-year window which trivially covers the full retained history.
        // Anything else parses as an integer (defaulting to 24h).
        const hoursParam = url.searchParams.get('hours') || '24';
        const hours = hoursParam === 'all' ? 10 * 365 * 24 : parseInt(hoursParam, 10);
        // bucketMinutes is optional — if omitted, getSummary scales the bucket
        // size to the window so the timeline series stays under ~500 rows.
        const bucketRaw = url.searchParams.get('bucketMinutes');
        const bucketMinutes = bucketRaw ? parseInt(bucketRaw, 10) : undefined;
        // cells=1 adds the priceable bucket × process × provider × model table
        // the dashboard's €/$ view needs; off by default (see SummaryCell).
        const cells = url.searchParams.get('cells') === '1';
        json(res, 200, getSummary(handle, { hours, bucketMinutes, scope: scopeOf(url), cells, exclude: excludeOf(url) }));
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return true;
    }

    if (req.url?.startsWith('/api/token-usage/cost')) {
      const handle = tokenDb();
      if (!handle?.db) { dbMissing(res); return true; }
      try {
        const url = new URL(req.url, 'http://localhost');
        json(res, 200, getCost(handle, { months: parseInt(url.searchParams.get('months') || '6', 10), exclude: excludeOf(url), byDay: url.searchParams.get('by') === 'day' }));
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return true;
    }

    if (req.url?.startsWith('/api/token-usage/recent')) {
      const handle = tokenDb();
      if (!handle) { dbMissing(res); return true; }
      try {
        const url = new URL(req.url, 'http://localhost');
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        // Optional ?process=<name> filter — applied in-memory after getRecent.
        // Used by the health coordinator to find the last successful call for
        // a specific cognitive process (e.g. observation-writer) without
        // adding a SQL-level filter; widening the limit covers the case where
        // a busier process dominates the global tail.
        const processFilter = url.searchParams.get('process');
        const recent = getRecent(handle, { limit: processFilter ? Math.max(limit, 200) : limit, scope: scopeOf(url), exclude: excludeOf(url) });
        if (processFilter) recent.data = recent.data.filter((r) => r.process === processFilter).slice(0, limit);
        json(res, 200, recent);
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return true;
    }

    // Phase 78: captured context-window breakdown (real per-category bytes +
    // prompt-cache boundary). With ?task_id=<id> → that measured RUN's own
    // captured buffer; without → the latest live-session capture.
    if (at(req, '/api/context-breakdown')) {
      try {
        const u = new URL(req.url, 'http://localhost');
        json(res, 200, measurement.readBreakdown(u.searchParams.get('task_id')));
      } catch (err) {
        json(res, 404, { error: 'no context breakdown captured for this run yet', detail: err.message });
      }
      return true;
    }

    // Phase 84-04 (D-10): per-turn context array for one measured run.
    // Graceful-empty ({ contextTurns: [] }) on a missing / partly-written file or
    // a traversal task_id — NEVER 500 (the UI polls this during a live run).
    if (at(req, '/api/context-turns')) {
      try {
        const u = new URL(req.url, 'http://localhost');
        json(res, 200, { contextTurns: measurement.readContextTurns(u.searchParams.get('task_id')) });
      } catch {
        json(res, 200, { contextTurns: [] });
      }
      return true;
    }

    return false;
  };
}
