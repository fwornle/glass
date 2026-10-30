/**
 * job-class-api.mjs — the read side of job classes: GET /api/job-classes (the
 * tagger's counters), /api/job-classes/summary (tokens and agreement by class)
 * and /api/job-classes/coverage (the coverage map). One implementation for the
 * proxy (server.mjs) and glass's daemon, which serve the same dashboard tab.
 */
import { jobClassCoverage, resolveClass, versionTags } from './job-class.mjs';

const NOT_MINE = Symbol('not a job-class read');

/**
 * Serve a job-class read. Returns true when it answered the request.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} o
 * @param {object} o.tagger       createJobClassTagger(...)
 * @param {object|null} o.db      the token DB handle
 * @param {string} o.referenceDir where the measurement writes `<scope>/reference-<tag>.jsonl`
 * @param {Function} o.config     () => the tagger's config, for the counters' "enabled"
 * @param {Function} o.sinceBootMs
 */
export function handleJobClassRead(req, res, o) {
  return serve(req, res, o) !== NOT_MINE;
}

function serve(req, res, { tagger, db, referenceDir, config, sinceBootMs }) {
// Job classes (job-class.mjs): the tagger's counters, and tokens by class.
// `summary` joins turn_job_class to token_usage on the turn identity, so a
// class's tokens are every call of the turns labelled with it.
if (req.method === 'GET' && (req.url === '/api/job-classes' || req.url?.startsWith('/api/job-classes?'))) {
  let cfg = null;
  try { cfg = config(); } catch { /* reported as enabled:false */ }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ enabled: cfg?.enabled === true, config: cfg, sinceBootMs: sinceBootMs(), ...tagger.stats() }));
}
// How the taxonomy covers each project's prompts: the live labels and the
// offline reference set (coding scripts/measure-job-classes.mjs writes it into
// referenceDir/<scope>/), for the dashboard's coverage map.
// `taxonomy=<tag>` picks a team's taxonomy; without it, the default.
if (req.method === 'GET' && req.url?.startsWith('/api/job-classes/coverage')) {
  const q = new URL(req.url, 'http://x').searchParams;
  const days = Math.min(Math.max(q.get('hours') ? Number(q.get('hours')) / 24 : Number(q.get('days')) || 30, 0.01), 90);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const tag = q.get('taxonomy') || '';
  const tax = tagger.taxonomy(tag);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (!tax) return res.end(JSON.stringify({ days, error: tag ? `no taxonomy ${tag} on this machine` : tagger.stats().taxonomyError || 'job classes are not configured' }));
  try {
    return res.end(JSON.stringify({ days, since, ...jobClassCoverage({ tax, db, referenceDir, since }) }));
  } catch (err) {
    return res.end(JSON.stringify({ days, error: err?.message || String(err) }));
  }
}
if (req.method === 'GET' && req.url?.startsWith('/api/job-classes/summary')) {
  const q = new URL(req.url, 'http://x').searchParams;
  // `hours` is the dashboard's window; `days` the shorthand for a person.
  const days = Math.min(Math.max(q.get('hours') ? Number(q.get('hours')) / 24 : Number(q.get('days')) || 7, 0.01), 90);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  // `taxonomy=<tag>`: the labels of that taxonomy, every version of it, each
  // resolved to the class that holds it now (a merged class's old labels count
  // for the class it was merged into). Without it, every label as stored (one
  // taxonomy until a team shares its own).
  const tag = q.get('taxonomy') || '';
  try {
    if (!db) throw new Error('token DB unavailable');
    const tax = tag ? tagger.taxonomy(tag) : null;
    if (tag && !tax) throw new Error(`no taxonomy ${tag} on this machine`);
    const tags = tax ? versionTags(tax) : [];
    const where = tags.length ? `AND j.taxonomy IN (${tags.map(() => '?').join(',')})` : '';
    const whereJ = where.replace('j.taxonomy', 'taxonomy');
    const resolve = (c) => (tax ? resolveClass(tax, c) : c);
    const merged = new Map();
    for (const r of db.prepare(`
      SELECT j.job_class AS jobClass, COUNT(DISTINCT j.conversation_key || ':' || j.turn_index) AS turns,
             COUNT(t.id) AS calls, COALESCE(SUM(t.input_tokens), 0) AS inputTokens,
             COALESCE(SUM(t.output_tokens), 0) AS outputTokens,
             COALESCE(SUM(t.cache_read_tokens), 0) AS cacheReadTokens
      FROM turn_job_class j
      LEFT JOIN token_usage t ON t.conversation_key = j.conversation_key AND t.turn_index = j.turn_index
      WHERE j.labelled_at >= ? ${where}
      GROUP BY j.job_class`).all(since, ...tags)) {
      // A turn has one label, so turns of two raw classes never overlap and add up.
      const cls = resolve(r.jobClass);
      const m = merged.get(cls) || { jobClass: cls, turns: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      for (const k of ['turns', 'calls', 'inputTokens', 'outputTokens', 'cacheReadTokens']) m[k] += r[k];
      merged.set(cls, m);
    }
    const byClass = [...merged.values()].sort((a, b) => b.turns - a.turns || a.jobClass.localeCompare(b.jobClass));
    // Per class, how often the teacher (on its sampled turns) gave the label
    // the student did: the student's live precision for that class. A separate
    // query, because the join above multiplies each turn by its calls.
    const pc = new Map();
    const agreement = { sampled: 0, agree: 0 };
    for (const r of db.prepare(`
      SELECT job_class AS jobClass, teacher_class AS teacherClass, COUNT(*) AS n
      FROM turn_job_class WHERE teacher_class != '' AND labelled_at >= ? ${whereJ}
      GROUP BY job_class, teacher_class`).all(since, ...tags)) {
      const cls = resolve(r.jobClass);
      const same = cls === resolve(r.teacherClass);
      const p = pc.get(cls) || { sampled: 0, agree: 0 };
      p.sampled += r.n; if (same) p.agree += r.n;
      pc.set(cls, p);
      agreement.sampled += r.n; if (same) agreement.agree += r.n;
    }
    for (const r of byClass) { r.teacherSampled = pc.get(r.jobClass)?.sampled || 0; r.teacherAgree = pc.get(r.jobClass)?.agree || 0; }
    const recent = q.get('recent') ? db.prepare(`
      SELECT conversation_key AS conversationKey, turn_index AS turnIndex, agent, project, job_class AS jobClass,
             teacher_class AS teacherClass, student_model AS studentModel, student_ms AS studentMs,
             prompt_preview AS promptPreview, labelled_at AS labelledAt, taxonomy
      FROM turn_job_class WHERE 1 = 1 ${whereJ} ORDER BY labelled_at DESC LIMIT ?`).all(...tags, Math.min(Number(q.get('recent')) || 20, 200))
      .map((r) => ({ ...r, jobClass: resolve(r.jobClass), teacherClass: r.teacherClass ? resolve(r.teacherClass) : r.teacherClass })) : undefined;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ days, since, taxonomy: tag || null, byClass, agreement, recent }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ days, since, byClass: [], error: err?.message || String(err) }));
  }
}
  return NOT_MINE;
}
