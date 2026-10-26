// proxy-bridge/model-trials.mjs
//
// Model trials: evidence before a background process moves to a cheaper model.
//
// A cheaper model is only a saving if it still does the job. "Haiku is cheaper"
// was true when consolidator-insight moved off it, and the move back was right:
// its insights were oversimplified and dropped detail. A trial answers the
// question for real traffic instead of by reputation. For a while (days, up to a
// number of samples), a sampled share of the process's calls is ALSO sent to the
// candidate model in the background. The caller only ever gets the incumbent's
// answer; the candidate's is stored beside it. A strong judge then compares each
// pair blind, twice with the order swapped (a judge favours whichever answer it
// reads first), for the thing that went wrong before: details kept, nothing
// invented, nothing vague. Structural checks run beside it for free: the same
// output format, the same units (insight blocks, JSON items, headed sections).
//
// The verdict is a recommendation, never an action: accepting a trial is a
// separate, explicit step (server.mjs, PATCH of the route's band).
//
// Store: <data>/llm-proxy/trials/<id>.json (definition + status) and
// <id>.samples.jsonl (append-only: one `sample` line per pair, `judgement`
// lines as they arrive). Prompts and outputs are redacted before they are
// written (raw-bodies.mjs patterns); the caller passes the redactor.
//
// No daemon state and no server import, so the unit tests and glass (which
// reads a coding machine's trials read-only) can use it directly.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TRIAL_DEFAULTS = Object.freeze({
  /** Share of the process's calls that are also sent to the candidate. */
  samplePct: 0.25,
  /** How long the trial collects, at most. */
  days: 3,
  /** And how many pairs, at most — whichever comes first. */
  maxSamples: 40,
  /** A verdict needs at least this many judged pairs. */
  minSamples: 20,
  /** Share of judged pairs where the candidate is at least as good. */
  passRate: 0.9,
  /** Mean share of the incumbent's important details the candidate keeps. */
  minRetention: 0.9,
  /** The request is cut to this many characters for the judge (head + tail). */
  judgeChars: 60_000,
});

export function trialsDir(dataDir) {
  return path.join(dataDir, 'llm-proxy', 'trials');
}

const trialFile = (dir, id) => path.join(dir, `${id}.json`);
const samplesFile = (dir, id) => path.join(dir, `${id}.samples.jsonl`);
const ID = /^[a-z0-9][a-z0-9-]{0,120}$/;

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

const modelOk = (m) => m && typeof m.provider === 'string' && m.provider && typeof m.complexity === 'string'
  && m.complexity && typeof m.model === 'string' && m.model;

/**
 * Starts a trial. One running trial per process: two would split its calls and
 * leave both short of samples.
 *
 * @param {string} dir trialsDir(...)
 * @param {{ process: string, routeKey?: string, incumbent: object, candidate: object,
 *   samplePct?: number, days?: number, maxSamples?: number, minSamples?: number,
 *   passRate?: number, minRetention?: number }} spec
 *   incumbent / candidate: { provider, complexity, model }
 */
export function createTrial(dir, spec, now = new Date()) {
  const proc = String(spec?.process || '');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(proc)) throw new Error('process: a process name is required');
  if (!modelOk(spec.incumbent)) throw new Error('incumbent: { provider, complexity, model } is required');
  if (!modelOk(spec.candidate)) throw new Error('candidate: { provider, complexity, model } is required');
  if (spec.candidate.provider === spec.incumbent.provider && spec.candidate.model === spec.incumbent.model) {
    throw new Error(`candidate is the incumbent (${spec.incumbent.provider}/${spec.incumbent.model})`);
  }
  if (listTrials(dir).some((t) => t.process === proc && effectiveStatus(t, countSamples(dir, t.id), now) === 'running')) {
    throw new Error(`a trial for ${proc} is already running`);
  }
  const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const days = num(spec.days, TRIAL_DEFAULTS.days, 0.01, 60);
  const id = `${proc.toLowerCase()}-${stamp(now)}-${crypto.randomBytes(2).toString('hex')}`;
  const trial = {
    id,
    process: proc,
    routeKey: spec.routeKey || `bg-${proc}`,
    incumbent: { provider: spec.incumbent.provider, complexity: spec.incumbent.complexity, model: spec.incumbent.model },
    candidate: { provider: spec.candidate.provider, complexity: spec.candidate.complexity, model: spec.candidate.model },
    samplePct: num(spec.samplePct, TRIAL_DEFAULTS.samplePct, 0.01, 1),
    days,
    maxSamples: Math.round(num(spec.maxSamples, TRIAL_DEFAULTS.maxSamples, 1, 1000)),
    thresholds: {
      minSamples: Math.round(num(spec.minSamples, TRIAL_DEFAULTS.minSamples, 1, 1000)),
      passRate: num(spec.passRate, TRIAL_DEFAULTS.passRate, 0, 1),
      minRetention: num(spec.minRetention, TRIAL_DEFAULTS.minRetention, 0, 1),
    },
    status: 'running',
    createdAt: now.toISOString(),
    endsAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
  };
  writeAtomic(trialFile(dir, id), `${JSON.stringify(trial, null, 2)}\n`);
  return trial;
}

export function readTrial(dir, id) {
  if (!ID.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(trialFile(dir, id), 'utf8')); } catch { return null; }
}

/** Every trial, newest first. A file that does not parse is skipped, not fatal. */
export function listTrials(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readTrial(dir, n.slice(0, -'.json'.length)))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Records a decision on a trial (stopped, accepted, rejected) with what goes with it. */
export function setTrialStatus(dir, id, status, extra = {}, now = new Date()) {
  const t = readTrial(dir, id);
  if (!t) throw new Error(`no trial ${id}`);
  const next = { ...t, ...extra, status, [`${status}At`]: now.toISOString() };
  writeAtomic(trialFile(dir, id), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * What a trial is doing now. A running trial completes on its own when its time
 * is up or it has its samples — no timer has to fire for that to be true.
 */
export function effectiveStatus(trial, sampleCount, now = new Date()) {
  if (trial.status !== 'running') return trial.status;
  if (now.toISOString() >= trial.endsAt || sampleCount >= trial.maxSamples) return 'complete';
  return 'running';
}

export function countSamples(dir, id) {
  let text = '';
  try { text = fs.readFileSync(samplesFile(dir, id), 'utf8'); } catch { return 0; }
  let n = 0;
  for (const line of text.split('\n')) if (line.startsWith('{"kind":"sample"')) n += 1;
  return n;
}

/**
 * The running trial for a process, or null. Called on every completion, so the
 * directory is read at most every `ttlMs`.
 */
export function createTrialLookup(dir, { ttlMs = 5000, now = () => new Date() } = {}) {
  let cache = { at: 0, running: new Map() };
  return function runningTrialFor(processName) {
    const t = now();
    if (t.getTime() - cache.at > ttlMs) {
      const running = new Map();
      for (const trial of listTrials(dir)) {
        if (running.has(trial.process)) continue;
        if (effectiveStatus(trial, countSamples(dir, trial.id), t) === 'running') running.set(trial.process, trial);
      }
      cache = { at: t.getTime(), running };
    }
    return cache.running.get(processName) || null;
  };
}

export function appendTrialLine(dir, id, obj) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(samplesFile(dir, id), `${JSON.stringify(obj)}\n`);
}

/** A trial's pairs, oldest first, each with the judgements that have arrived for it. */
export function readSamples(dir, id) {
  let text = '';
  try { text = fs.readFileSync(samplesFile(dir, id), 'utf8'); } catch { return []; }
  const samples = new Map();
  const judgements = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.kind === 'sample') samples.set(o.sampleId, { ...o, judgements: [] });
    else if (o.kind === 'judgement') judgements.push(o);
  }
  for (const j of judgements) samples.get(j.sampleId)?.judgements.push(j);
  return [...samples.values()];
}

// ── Structure ────────────────────────────────────────────────────────────────

const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) || []);
function jaccard(a, b) {
  const A = words(a); const B = words(b);
  if (!A.size && !B.size) return 1;
  let both = 0;
  for (const w of A) if (B.has(w)) both += 1;
  return both / (A.size + B.size - both);
}

/**
 * The answer as units: repeated XML-tagged blocks with a topic/title/name
 * (consolidator's <insight>), a JSON array of objects, headed Markdown sections,
 * or else the whole text as one unit.
 *
 * @returns {{ format: 'xml'|'json'|'markdown'|'text', units: { title: string, body: string }[] }}
 */
export function extractUnits(text) {
  const s = String(text || '');
  const xml = [...s.matchAll(/<([a-z][\w-]*)>\s*<(topic|title|name)>([\s\S]*?)<\/\2>([\s\S]*?)<\/\1>/gi)];
  if (xml.length) {
    // Inner tags become line breaks, so a summary's own sections stay readable.
    const body = (raw) => raw.replace(/<[^>]+>/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
    return { format: 'xml', units: xml.map((m) => ({ title: m[3].trim(), body: body(m[4]) })) };
  }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  try {
    const parsed = JSON.parse(fenced ? fenced[1] : s);
    const arr = Array.isArray(parsed) ? parsed : null;
    if (arr && arr.every((x) => x && typeof x === 'object')) {
      return { format: 'json', units: arr.map((x) => ({ title: String(x.topic || x.title || x.name || ''), body: JSON.stringify(x) })) };
    }
  } catch { /* not JSON */ }
  const parts = s.split(/^#{1,3}\s+(.+)$/m);
  if (parts.length >= 3) {
    const units = [];
    for (let i = 1; i < parts.length; i += 2) units.push({ title: parts[i].trim(), body: (parts[i + 1] || '').trim() });
    return { format: 'markdown', units };
  }
  return { format: 'text', units: s.trim() ? [{ title: '', body: s.trim() }] : [] };
}

/**
 * The two answers' shapes against each other. `pairs` aligns each incumbent unit
 * with the most similar candidate unit, which is what the side-by-side view
 * shows row by row: similar titles (word overlap ≥ 0.5), or — two models name
 * the same insight differently — similar bodies (≥ 0.5).
 */
export function structuralMetrics(incumbentText, candidateText) {
  const inc = extractUnits(incumbentText);
  const cand = extractUnits(candidateText);
  const free = new Set(cand.units.map((_, i) => i));
  const pairs = inc.units.map((u, i) => {
    let best = -1; let score = 0; let title = 0;
    for (const j of free) {
      const t = inc.format === 'text' ? 1 : jaccard(u.title, cand.units[j].title);
      const b = jaccard(u.body, cand.units[j].body);
      if (t < 0.5 && b < 0.5) continue;
      if (t + b > score) { score = t + b; best = j; title = t; }
    }
    if (best >= 0) { free.delete(best); return { incumbent: i, candidate: best, titleMatch: title }; }
    return { incumbent: i, candidate: null, titleMatch: 0 };
  });
  for (const j of free) pairs.push({ incumbent: null, candidate: j, titleMatch: 0 });
  const matched = pairs.filter((p) => p.incumbent != null && p.candidate != null);
  const ratio = (a, b) => (a > 0 ? b / a : (b > 0 ? Infinity : 1));
  const bodyRatios = matched.map((p) => ratio(inc.units[p.incumbent].body.length, cand.units[p.candidate].body.length));
  return {
    formatIncumbent: inc.format,
    formatCandidate: cand.format,
    formatMatch: inc.format === cand.format,
    unitsIncumbent: inc.units.length,
    unitsCandidate: cand.units.length,
    unitRecall: inc.units.length ? matched.length / inc.units.length : (cand.units.length ? 0 : 1),
    lengthRatio: ratio(String(incumbentText || '').length, String(candidateText || '').length),
    bodyRatio: bodyRatios.length ? bodyRatios.reduce((a, b) => a + b, 0) / bodyRatios.length : null,
    pairs,
    unitsA: inc.units,
    unitsB: cand.units,
  };
}

// ── Judge ────────────────────────────────────────────────────────────────────

function clip(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n[… ${s.length - max} characters left out …]\n\n${s.slice(-half)}`;
}

/** The request as text: the messages' text parts, in order, with their roles. */
export function requestText(body) {
  const part = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n') : '');
  const sys = body?.system ? `[system]\n${part(body.system)}\n\n` : '';
  return sys + (Array.isArray(body?.messages) ? body.messages : [])
    .map((m) => `[${m?.role || 'user'}]\n${part(m?.content)}`)
    .join('\n\n');
}

/**
 * The judge's instructions for one order of a pair. Answer 1 and Answer 2 are
 * anonymous; the caller swaps them for the second call.
 */
export function buildJudgePrompt({ request, first, second, maxChars = TRIAL_DEFAULTS.judgeChars }) {
  return [
    'Two assistants answered the same request. Judge which answer serves the requester better.',
    '',
    'What matters, in this order:',
    '1. Completeness of the specific details the request supports: names, numbers, file paths, causes, decisions, caveats. An answer that summarises away detail is worse, however tidy.',
    '2. Faithfulness: nothing stated that the request does not support.',
    '3. Specificity: concrete statements, not generic ones.',
    '4. The output format the request asks for.',
    'Length is not quality in itself, and neither is style.',
    '',
    'Respond with ONE JSON object and nothing else:',
    '{"verdict": "1" | "2" | "equal",',
    ' "kept_by_2": <0..1: share of the important details in Answer 1 that Answer 2 also gives>,',
    ' "kept_by_1": <0..1: share of the important details in Answer 2 that Answer 1 also gives>,',
    ' "detail_1": <1..5>, "detail_2": <1..5>, "faithful_1": <1..5>, "faithful_2": <1..5>,',
    ' "missing_from_2": [<important details Answer 2 lacks, short phrases, at most 5>],',
    ' "missing_from_1": [<important details Answer 1 lacks, at most 5>],',
    ' "reason": "<one or two sentences>"}',
    'Use "equal" when neither answer is meaningfully better for the requester.',
    '',
    '=== REQUEST ===',
    clip(request, maxChars),
    '',
    '=== ANSWER 1 ===',
    String(first || ''),
    '',
    '=== ANSWER 2 ===',
    String(second || ''),
  ].join('\n');
}

const unit01 = (v) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : null);
const score15 = (v) => (Number.isFinite(Number(v)) ? Math.min(5, Math.max(1, Number(v))) : null);
const list = (v) => (Array.isArray(v) ? v.map(String).slice(0, 5) : []);

/** The judge's JSON, from a reply that may wrap it in prose or a fence; null when absent. */
export function parseJudgement(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let o;
  try { o = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  const verdict = String(o.verdict ?? '').trim().toLowerCase();
  if (!['1', '2', 'equal'].includes(verdict)) return null;
  return {
    verdict,
    kept_by_2: unit01(o.kept_by_2),
    kept_by_1: unit01(o.kept_by_1),
    detail_1: score15(o.detail_1),
    detail_2: score15(o.detail_2),
    faithful_1: score15(o.faithful_1),
    faithful_2: score15(o.faithful_2),
    missing_from_2: list(o.missing_from_2),
    missing_from_1: list(o.missing_from_1),
    reason: String(o.reason || '').slice(0, 600),
  };
}

/**
 * A judgement in the trial's terms. `order` says what Answer 1 was:
 * 'ic' — incumbent first, 'ci' — candidate first.
 */
export function orient(j, order) {
  const incFirst = order === 'ic';
  const pick = (k1, k2) => (incFirst ? [j[k1], j[k2]] : [j[k2], j[k1]]);
  const winner = j.verdict === 'equal' ? 'equal'
    : (j.verdict === '1') === incFirst ? 'incumbent' : 'candidate';
  const [detailIncumbent, detailCandidate] = pick('detail_1', 'detail_2');
  const [faithfulIncumbent, faithfulCandidate] = pick('faithful_1', 'faithful_2');
  return {
    winner,
    // The candidate's share of the incumbent's important details.
    retention: incFirst ? j.kept_by_2 : j.kept_by_1,
    reverseRetention: incFirst ? j.kept_by_1 : j.kept_by_2,
    detailIncumbent,
    detailCandidate,
    faithfulIncumbent,
    faithfulCandidate,
    missingFromCandidate: incFirst ? j.missing_from_2 : j.missing_from_1,
    missingFromIncumbent: incFirst ? j.missing_from_1 : j.missing_from_2,
    reason: j.reason,
  };
}

const mean = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/**
 * One pair's verdict from its oriented judgements: `equivalent` or
 * `candidate-better` when every order agrees the candidate is at least as good,
 * `worse` when every order prefers the incumbent, `inconsistent` when the orders
 * disagree (the judge followed position, not content), null while pending.
 */
export function pairVerdict(oriented) {
  if (!oriented.length) return null;
  const w = oriented.map((o) => o.winner);
  if (w.every((x) => x === 'candidate')) return 'candidate-better';
  if (w.every((x) => x !== 'incumbent')) return 'equivalent';
  if (w.every((x) => x === 'incumbent')) return 'worse';
  return 'inconsistent';
}

/**
 * Where a trial stands: counts, rates, means and the verdict against its
 * thresholds, with the reasons a verdict is not (yet) a pass.
 */
export function summarize(trial, samples, now = new Date()) {
  const status = effectiveStatus(trial, samples.length, now);
  const counts = { 'candidate-better': 0, equivalent: 0, worse: 0, inconsistent: 0 };
  const retention = [];
  const formatMatch = [];
  const unitRecall = [];
  const tokens = { incumbent: { input: 0, output: 0 }, candidate: { input: 0, output: 0 } };
  let judged = 0;
  for (const s of samples) {
    formatMatch.push(s.structure?.formatMatch ? 1 : 0);
    if (Number.isFinite(s.structure?.unitRecall)) unitRecall.push(s.structure.unitRecall);
    for (const side of ['incumbent', 'candidate']) {
      tokens[side].input += Number(s[side]?.tokens?.input) || 0;
      tokens[side].output += Number(s[side]?.tokens?.output) || 0;
    }
    const oriented = (s.judgements || []).filter((j) => j.ok).map((j) => j.oriented);
    const v = pairVerdict(oriented);
    if (!v) continue;
    judged += 1;
    counts[v] += 1;
    const r = mean(oriented.map((o) => o.retention));
    if (r != null) retention.push(r);
  }
  const okRate = judged ? (counts.equivalent + counts['candidate-better']) / judged : null;
  const meanRetention = mean(retention);
  const formatMatchRate = mean(formatMatch);
  const th = trial.thresholds || {};
  const reasons = [];
  if (judged < th.minSamples) reasons.push(`${judged} of ${th.minSamples} judged pairs needed`);
  if (okRate != null && okRate < th.passRate) reasons.push(`candidate at least as good in ${Math.round(okRate * 100)}% of pairs (needs ${Math.round(th.passRate * 100)}%)`);
  if (meanRetention != null && meanRetention < th.minRetention) reasons.push(`keeps ${Math.round(meanRetention * 100)}% of the incumbent's details (needs ${Math.round(th.minRetention * 100)}%)`);
  if (formatMatchRate != null && formatMatchRate < th.passRate) reasons.push(`same output format in ${Math.round(formatMatchRate * 100)}% of pairs`);
  const enough = judged >= th.minSamples;
  // A trial that stopped collecting short of its samples cannot pass; it is not
  // pending either, since no more pairs are coming.
  const verdict = !enough ? (status === 'running' ? 'pending' : 'insufficient') : reasons.length ? 'fail' : 'pass';
  return {
    status,
    samples: samples.length,
    judged,
    counts,
    okRate,
    meanRetention,
    formatMatchRate,
    meanUnitRecall: mean(unitRecall),
    tokens,
    verdict,
    reasons,
  };
}
