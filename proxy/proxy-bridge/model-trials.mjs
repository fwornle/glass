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
// A trial can try several candidates (mode 'auto'): the caller lists them in
// order of preference — cheapest first, since the caller owns the prices — and
// each sampled call goes to EVERY candidate still being tried, so their answers
// to the same request sit side by side (one `sample` line per candidate, sharing
// a `requestId`; the request text is stored once, on the first). That costs one
// candidate call per candidate per sampled call, and gives every candidate its
// pairs as fast as a one-candidate trial. Every candidate is judged against the
// same thresholds; the first in the list that passes is the trial's winner. A
// candidate that can no longer pass stops being sampled, and so does one dearer
// than a candidate that has already passed.
//
// The verdict is a recommendation, never an action: accepting a trial is a
// separate, explicit step (server.mjs, PATCH of the route's band or model pin).
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

/** An automatic trial runs at most this many candidates. */
export const AUTO_MAX_CANDIDATES = 4;

const modelOk = (m) => m && typeof m.provider === 'string' && m.provider && typeof m.complexity === 'string'
  && m.complexity && typeof m.model === 'string' && m.model;

/** A trial's candidates in order of preference. A trial from before candidate lists had one `candidate`. */
export function candidatesOf(trial) {
  if (Array.isArray(trial?.candidates) && trial.candidates.length) return trial.candidates;
  return trial?.candidate ? [trial.candidate] : [];
}

/** Which candidate a sample belongs to; samples from before candidate lists belong to the only one. */
const sampleIndex = (s) => (Number.isInteger(s?.candidateIndex) ? s.candidateIndex : 0);

/**
 * Starts a trial. One running trial per process: two would split its calls and
 * leave both short of samples.
 *
 * @param {string} dir trialsDir(...)
 * @param {{ process: string, routeKey?: string, incumbent: object,
 *   candidates?: object[], candidate?: object, mode?: 'auto'|'single',
 *   samplePct?: number, days?: number, maxSamples?: number, minSamples?: number,
 *   passRate?: number, minRetention?: number }} spec
 *   incumbent / each candidate: { provider, complexity, model }. `candidates` in
 *   order of preference (cheapest first); `candidate` is the one-model form.
 *   `maxSamples` is per candidate.
 */
export function createTrial(dir, spec, now = new Date()) {
  const proc = String(spec?.process || '');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(proc)) throw new Error('process: a process name is required');
  if (!modelOk(spec.incumbent)) throw new Error('incumbent: { provider, complexity, model } is required');
  const list = Array.isArray(spec.candidates) ? spec.candidates : spec.candidate ? [spec.candidate] : [];
  if (!list.length) throw new Error('candidate: { provider, complexity, model } is required');
  if (list.length > AUTO_MAX_CANDIDATES) throw new Error(`at most ${AUTO_MAX_CANDIDATES} candidates (got ${list.length})`);
  const seen = new Set();
  for (const c of list) {
    if (!modelOk(c)) throw new Error('candidate: { provider, complexity, model } is required');
    if (c.provider === spec.incumbent.provider && c.model === spec.incumbent.model) {
      throw new Error(`candidate is the incumbent (${spec.incumbent.provider}/${spec.incumbent.model})`);
    }
    const key = `${c.provider}/${c.model}`;
    if (seen.has(key)) throw new Error(`candidate ${key} is listed twice`);
    seen.add(key);
  }
  if (listTrials(dir).some((t) => t.process === proc && effectiveStatus(t, readSamples(dir, t.id), now) === 'running')) {
    throw new Error(`a trial for ${proc} is already running`);
  }
  const mode = spec.mode === 'auto' || (spec.mode == null && list.length > 1) ? 'auto' : 'single';
  if (mode === 'single' && list.length > 1) throw new Error('a single-model trial takes one candidate');
  const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  // Every candidate answers each sampled call, so several need no longer than one.
  const days = num(spec.days, TRIAL_DEFAULTS.days, 0.01, 60);
  const id = `${proc.toLowerCase()}-${stamp(now)}-${crypto.randomBytes(2).toString('hex')}`;
  const trial = {
    id,
    process: proc,
    routeKey: spec.routeKey || `bg-${proc}`,
    mode,
    incumbent: { provider: spec.incumbent.provider, complexity: spec.incumbent.complexity, model: spec.incumbent.model },
    candidates: list.map((c) => ({ provider: c.provider, complexity: c.complexity, model: c.model })),
    // For readers from before candidate lists (glass ≤ 0.1.53, coding's dashboard
    // before 06882880): they read `candidate.model` and crashed without it. They
    // show the first candidate; candidatesOf() reads `candidates` whenever present.
    candidate: { provider: list[0].provider, complexity: list[0].complexity, model: list[0].model },
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
 * is up or no candidate is still being tried — no timer has to fire for that to
 * be true.
 *
 * @param {object[]} samples readSamples(...)
 */
export function effectiveStatus(trial, samples, now = new Date()) {
  if (trial.status !== 'running') return trial.status;
  if (now.toISOString() >= trial.endsAt) return 'complete';
  if (!candidateStates(trial, samples).some((c) => c.state === 'active')) return 'complete';
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
        if (effectiveStatus(trial, readSamples(dir, trial.id), t) === 'running') running.set(trial.process, trial);
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

/**
 * A trial's pairs, oldest first, each with the judgements that have arrived for
 * it. A pair whose request is stored on a sibling (`requestRef`, same sampled
 * call) gets that request back.
 */
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
  for (const s of samples.values()) {
    if (s.request == null && s.requestRef) s.request = samples.get(s.requestRef)?.request ?? '';
  }
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
 * One candidate's pairs against the thresholds: counts, rates, means, and the
 * reasons a verdict is not (yet) a pass. `enough` = it has its judged pairs.
 */
function scoreSamples(th, samples) {
  const counts = { 'candidate-better': 0, equivalent: 0, worse: 0, inconsistent: 0 };
  const retention = [];
  const formatMatch = [];
  const unitRecall = [];
  const tokens = { incumbent: { input: 0, output: 0 }, candidate: { input: 0, output: 0 } };
  let judged = 0;
  let pending = 0;
  for (const s of samples) {
    formatMatch.push(s.structure?.formatMatch ? 1 : 0);
    if (Number.isFinite(s.structure?.unitRecall)) unitRecall.push(s.structure.unitRecall);
    for (const side of ['incumbent', 'candidate']) {
      tokens[side].input += Number(s[side]?.tokens?.input) || 0;
      tokens[side].output += Number(s[side]?.tokens?.output) || 0;
    }
    const oriented = (s.judgements || []).filter((j) => j.ok).map((j) => j.oriented);
    const v = pairVerdict(oriented);
    if (!v) {
      // Both orders asked and neither usable: that pair will not be judged.
      if ((s.judgements || []).length < 2) pending += 1;
      continue;
    }
    judged += 1;
    counts[v] += 1;
    const r = mean(oriented.map((o) => o.retention));
    if (r != null) retention.push(r);
  }
  const okRate = judged ? (counts.equivalent + counts['candidate-better']) / judged : null;
  const meanRetention = mean(retention);
  const formatMatchRate = mean(formatMatch);
  const reasons = [];
  if (judged < th.minSamples) reasons.push(`${judged} of ${th.minSamples} judged pairs needed`);
  if (okRate != null && okRate < th.passRate) reasons.push(`candidate at least as good in ${Math.round(okRate * 100)}% of pairs (needs ${Math.round(th.passRate * 100)}%)`);
  if (meanRetention != null && meanRetention < th.minRetention) reasons.push(`keeps ${Math.round(meanRetention * 100)}% of the incumbent's details (needs ${Math.round(th.minRetention * 100)}%)`);
  if (formatMatchRate != null && formatMatchRate < th.passRate) reasons.push(`same output format in ${Math.round(formatMatchRate * 100)}% of pairs`);
  return {
    samples: samples.length, judged, pending, counts, okRate, meanRetention, formatMatchRate,
    meanUnitRecall: mean(unitRecall), tokens, reasons, enough: judged >= th.minSamples,
  };
}

/**
 * Where each candidate stands. `state`:
 *   active  — still being tried
 *   passed  — has its judged pairs and meets every threshold
 *   failed  — has its judged pairs and misses one
 *   out     — too many pairs worse (or judged inconsistently) to pass at all
 *   skipped — a cheaper candidate earlier in the list has passed
 *   short   — reached maxSamples without enough judged pairs
 * `wanted` — how many more pairs it should get now (judgements still pending count
 * as on their way, so a candidate is not sampled past its need while the judge
 * catches up).
 */
export function candidateStates(trial, samples) {
  const th = trial.thresholds || {};
  const list = candidatesOf(trial);
  const by = list.map(() => []);
  for (const s of samples || []) by[sampleIndex(s)]?.push(s);
  // The failures a candidate can afford and still reach passRate at minSamples.
  const allowed = Math.floor((1 - th.passRate) * th.minSamples + 1e-9);
  let passedBefore = false;
  return list.map((candidate, index) => {
    const score = scoreSamples(th, by[index]);
    const failures = score.counts.worse + score.counts.inconsistent;
    let state = 'active';
    if (score.enough) state = score.reasons.length ? 'failed' : 'passed';
    else if (failures > allowed) state = 'out';
    else if (passedBefore) state = 'skipped';
    else if (score.samples >= trial.maxSamples && !score.pending) state = 'short';
    if (state === 'passed') passedBefore = true;
    const wanted = state === 'active'
      ? Math.max(0, Math.min(th.minSamples - score.judged - score.pending, trial.maxSamples - score.samples))
      : 0;
    return { index, candidate, state, wanted, failures, ...score };
  });
}

/**
 * Which candidates a sampled call goes to: every active one that still wants
 * pairs, in list order, skipping any whose provider is unusable right now
 * (`usable`). Empty: none.
 */
export function candidatesToSample(trial, samples, usable = () => true) {
  return candidateStates(trial, samples)
    .filter((c) => c.state === 'active' && c.wanted > 0 && usable(c.candidate))
    .map((c) => c.index);
}

/**
 * Where a trial stands: each candidate's counts, rates, means and state, the
 * winner (the first candidate in the list that passed), and — at the top level,
 * for one-candidate readers — the figures of the winner, or else of the
 * candidate doing best so far.
 */
export function summarize(trial, samples, now = new Date()) {
  const status = effectiveStatus(trial, samples, now);
  const states = candidateStates(trial, samples);
  const winner = states.find((c) => c.state === 'passed') || null;
  const anyActive = states.some((c) => c.state === 'active') && status === 'running';
  const lead = winner
    || [...states].filter((c) => c.judged).sort((a, b) => (b.okRate - a.okRate) || (b.meanRetention - a.meanRetention))[0]
    || states[0];
  const verdict = winner ? 'pass'
    : anyActive ? 'pending'
    : states.some((c) => c.state === 'failed' || c.state === 'out') ? 'fail'
    : 'insufficient';
  const strip = ({ enough, ...rest }) => rest;
  return {
    status,
    samples: samples.length,
    judged: states.reduce((a, c) => a + c.judged, 0),
    counts: lead.counts,
    okRate: lead.okRate,
    meanRetention: lead.meanRetention,
    formatMatchRate: lead.formatMatchRate,
    meanUnitRecall: lead.meanUnitRecall,
    tokens: lead.tokens,
    verdict,
    reasons: winner ? [] : lead.reasons,
    winner: winner ? winner.index : null,
    lead: lead.index,
    candidates: states.map(strip),
  };
}
