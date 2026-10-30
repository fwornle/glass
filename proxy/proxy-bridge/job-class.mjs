// proxy-bridge/job-class.mjs
//
// WHAT KIND of job a foreground turn is — fix, build, ship, explain, … — in
// SHADOW: every human turn is labelled once, in the background, and the label
// is stored beside the turn's token_usage rows. Nothing routes on it yet.
//
// ── Where the classes come from ──────────────────────────────────────────────
// A committed taxonomy (coding config/job-classes.yaml), not one a model
// derives: two derivations from the same prompts agreed at kappa 0.54, while a
// hand-written taxonomy is applied by a strong teacher at 0.93 and reproduced by
// a cheap student at ~0.78 on prompts nobody read while writing it
// (coding .planning/shared-job-classes.md, "P0 results"). The file carries its
// own request template, which coding's scripts/measure-job-classes.mjs renders
// the same way, so a student scored offline is asked here exactly what it was
// asked there. Keep renderRequest() and cleanTurnText() in step with that
// script, or the measured agreement stops describing this tagger.
//
// ── Whose taxonomy ───────────────────────────────────────────────────────────
// A team may share its own taxonomy (coding lib/job-classes/package.mjs, P2).
// This module does not know about teams: coding resolves project → team →
// taxonomy file and writes it to <data dir>/job-classes/bindings.json, read
// here by mtime. A project with no entry uses the default taxonomy; a project
// the index marks as a conflict (two teams, two taxonomies) is not labelled.
// Each label records the taxonomy tag it was made under (`<name>-v<version>`).
// A new version may merge a class into another (`retired: [{id, mergedInto}]`,
// coding lib/job-classes/evolve.mjs); readers count the labels of every
// version of a taxonomy, each resolved to the class that holds it now.
//
// ── Why shadow, and why after the fact ───────────────────────────────────────
// The student (claude-haiku-5.5 on the bg-job-class-student route) answers in
// ~2 s. Put in front of a turn, that is 2 s on every human prompt for a label
// nothing reads yet. So observe() returns at once and the label lands in
// turn_job_class when it comes back; a reader joins it to token_usage on
// (conversation_key, turn_index), the turn identity both entry points already
// stamp. A label that never arrives costs the turn nothing.
//
// ── Once per turn ────────────────────────────────────────────────────────────
// Only the FIRST call of a turn is labelled: inside a tool loop the human prompt
// has not changed, and a Claude Code turn can be dozens of calls. A seen-set
// keeps a turn from being sent twice while its label is in flight, and the
// table's primary key keeps a restart from storing it twice. Sub-agent requests
// are skipped: their "prompt" is the parent agent's instructions, not a job a
// person handed over (the P0 corpus dropped them for the same reason). So are an
// agent's tool-less utility calls (Claude Code's title and topic requests),
// which carry a meta-prompt, not the person's.
//
// ── Nobody's job: automated runs ─────────────────────────────────────────────
// A benchmark cell, an experiment cell, a replay or a tool probe sends a prompt
// someone scripted, often the same one many times. Labelled, it would count as
// work a person handed over, and its teacher check would count towards the P1
// gate. Two signals mark it, both set by the caller and neither ambient: an
// explicit task binding (x-task-id, or the shim's body/path task id; an
// interactive session's own measurement span does not count), and Claude
// Code's headless entrypoint, `claude -p`, whose User-Agent says `sdk-cli`
// where an interactive session says `cli`. A replay or a probe carries no task
// id, so the second signal is the one that catches it (isAutomatedRequest).
// glass binds EVERY session to a task id (its own wrapper's), so there the
// first signal says nothing and its config turns it off (skipTaskBound: false).
//
// ── Sampling the teacher ─────────────────────────────────────────────────────
// A share of turns (teacher_sample_pct) is also labelled by the teacher. Those
// rows are the live version of the offline measurement: student vs teacher
// agreement on real traffic, by exact label match, no judge needed.
//
// ── Redacted before it leaves ────────────────────────────────────────────────
// The student is a cloud model, and for a Claude Code turn that is a second
// destination the prompt did not have before. So the text runs through the
// daemon's own redactor (the 27-pattern set raw bodies use) first, on a bounded
// slice: the redactor has wedged a process on unbounded input. A redaction that
// fails blocks the content, and a blocked turn is skipped, not sent.
//
// Never throws into a request: every failure is a counter and a log line.

import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { turnIdentity } from './turn-identity.mjs';
import { toolsInCurrentTurn } from './turn-band.mjs';
import { toolMeta } from './context-turns.mjs';

/** Harness text that arrives as a user message but is nobody's job (mirrors the measurement's NOISE). */
const NOISE = [
  /^<task-notification>/, /^<local-command-/, /^<command-(name|message)>/, /^Caveat:/,
  /^This session is being continued from a previous conversation/,
  /^# /,
  /^\[Request interrupted/,
  /^\[SYSTEM NOTIFICATION/,   // a harness event delivered as a user message
  /^\[SUGGESTION MODE/,       // Claude Code asking for the next-prompt suggestion after a reply
];

/** Raw text examined before cleaning. The regexes below must never see an unbounded string. */
const RAW_CAP = 20000;
/** Characters of cleaned prompt the classifier sees: what the students were measured on. */
const REQUEST_CHARS = 500;
/** Prompts shorter than this after cleaning are turns of a job, not jobs (the measurement's --min-chars). */
const MIN_CHARS = 25;
/** Characters handed to the redactor: bounded, and more than the request ever shows. */
const REDACT_CHARS = 2000;
const REDACTION_BLOCKED = '[REDACTION_ERROR_CONTENT_BLOCKED]';
/** Characters of the (already redacted) text kept with a label. */
const PREVIEW_CHARS = 120;

/**
 * A message's text with system reminders removed, block by block and each block
 * capped: a reminder can be longer than the cap (Claude Code sends every
 * CLAUDE.md in one), and capping the joined text cut its closing tag off, so the
 * whole reminder reached the classifier (2026-10-28). A reminder left open by
 * the cap is dropped to the end of its block.
 */
function flatten(content) {
  const blocks = typeof content === 'string' ? [content]
    : Array.isArray(content) ? content.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')) : [];
  return blocks.map((b) => b.slice(0, RAW_CAP)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<system-reminder>[\s\S]*$/, ' ')).join('\n').slice(0, RAW_CAP);
}

/** One message's text, cleaned as the measurement cleans it; '' for harness noise or a fragment. */
function cleanMessage(m) {
  let t = flatten(m.content);
  t = t.replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content>/g, (_, body) => ` [pasted ${body.length} chars] `);
  t = t.replace(/\[Image[^\]]*\]/g, ' [image] ');
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!t || NOISE.some((re) => re.test(t)) || t.length < MIN_CHARS) return '';
  return t;
}

/**
 * The text a classifier should see for this turn: the person's message, with
 * system reminders removed and pasted blocks and images reduced to markers, or
 * '' when the turn holds nothing but harness text.
 *
 * ── Why not simply the last user message ────────────────────────────────────
 * Because an agent may append its own user messages after the person's: Claude
 * Code adds a fixed reminder after the prompt on every request. Taking the last
 * one labelled two consecutive turns of a live session on the same 1,363-char
 * reminder (2026-10-27). So the turn's messages are every user message since
 * the agent last replied (its tool calls are part of the turn), and the first
 * of them that is not harness text is the person's.
 */
export function cleanTurnText(messages) {
  try {
    const msgs = Array.isArray(messages) ? messages : [];
    // Back to the agent's last REPLY: its tool calls belong to this turn's loop.
    let start = msgs.length;
    while (start > 0 && !(msgs[start - 1]?.role === 'assistant' && !toolMeta(msgs[start - 1]))) start -= 1;
    for (let i = start; i < msgs.length; i += 1) {
      const m = msgs[i];
      if (m?.role !== 'user' || toolMeta(m)) continue;
      const t = cleanMessage(m);
      if (t) return t;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Whether a request comes from an automated run rather than a person's session
 * (see "Nobody's job" above): an explicit task binding, or Claude Code's
 * headless entrypoint (`claude-cli/<v> (external, sdk-cli)`; any `sdk-*`
 * entrypoint is the Agent SDK, equally scripted).
 * @param {Record<string, string|string[]|undefined>} headers
 * @param {string} [boundTaskId]  a task id the caller bound explicitly (never an ambient span)
 * @param {{taskBound?: boolean}} [o]  taskBound false: a task binding is no sign (glass)
 */
export function isAutomatedRequest(headers = {}, boundTaskId = '', { taskBound = true } = {}) {
  const hdr = typeof headers['x-task-id'] === 'string' ? headers['x-task-id'].trim() : '';
  if (taskBound && (hdr || (typeof boundTaskId === 'string' && boundTaskId.trim()))) return true;
  const ua = typeof headers['user-agent'] === 'string' ? headers['user-agent'] : '';
  return /^claude-cli\/\S+ \([^)]*\bsdk-[a-z]+/.test(ua);
}

/**
 * Load a taxonomy file: { version, tag, classes, ids, none, precedence, prompt, groups }.
 * Throws on a file that cannot classify anything (no prompt, no classes,
 * duplicate ids, a precedence naming an unknown class), or whose classes name a
 * group it does not declare. Groups are for reading only: never in the prompt.
 */
export function loadTaxonomy(file) {
  const raw = parseYaml(fs.readFileSync(file, 'utf8'));
  const classes = Array.isArray(raw?.classes) ? raw.classes : [];
  const ids = classes.map((c) => String(c?.id || ''));
  if (!classes.length || ids.some((id) => !id)) throw new Error(`${file}: classes must be a list of {id, test}`);
  if (new Set(ids).size !== ids.length) throw new Error(`${file}: duplicate class ids`);
  if (typeof raw.prompt !== 'string' || !raw.prompt.includes('{request}')) throw new Error(`${file}: prompt must be a template with {request}`);
  const precedence = Array.isArray(raw.precedence) ? raw.precedence.map(String) : [];
  for (const id of precedence) if (!ids.includes(id)) throw new Error(`${file}: precedence names unknown class ${id}`);
  const groups = Array.isArray(raw.groups) ? raw.groups.map((g) => ({ id: String(g?.id || ''), label: String(g?.label || g?.id || ''), description: String(g?.description || '') })) : [];
  const groupIds = new Set(groups.map((g) => g.id));
  for (const c of classes) if (c.group && !groupIds.has(String(c.group))) throw new Error(`${file}: class ${c.id} names undeclared group ${c.group}`);
  const version = raw.version ?? 0;
  // A team's package names itself; coding's config/job-classes.yaml is named by its file.
  const name = typeof raw.name === 'string' && raw.name ? raw.name : file.split('/').pop().replace(/\.ya?ml$/, '');
  const retired = new Map((Array.isArray(raw.retired) ? raw.retired : []).map((r) => [String(r?.id || ''), String(r?.mergedInto || '')]));
  for (const [rid, into] of retired) if (!rid || !into || ids.includes(rid)) throw new Error(`${file}: retired entries need an id that is no current class and a mergedInto`);
  return { name, version, tag: `${name}-v${version}`, classes, ids: new Set(ids), none: String(raw.none || ''), precedence, prompt: raw.prompt, groups, retired };
}

/** A label made under any version of `tax` → the class that holds it now (follows mergedInto). */
export function resolveClass(tax, id) {
  let cur = String(id || '');
  for (let i = 0; i < 32 && tax.retired?.has(cur); i++) cur = tax.retired.get(cur);
  return cur;
}

/** The tags of every version of `tax` up to the current one: their labels are read together. */
export function versionTags(tax) {
  const v = Number.isInteger(tax.version) && tax.version >= 0 && tax.version < 1000 ? tax.version : null;
  return v === null ? [tax.tag] : Array.from({ length: v + 1 }, (_, k) => `${tax.name}-v${k}`);
}

/** The classification request for `text` under `tax`, rendered as the measurement renders it. */
export function renderRequest(tax, text) {
  const catalogue = tax.classes.map((c) => [`- ${c.id}: ${c.test}`,
    ...(c.examples || []).map((e) => `    e.g. ${e}`)].join('\n')).join('\n');
  const fill = {
    none: tax.none, precedence: tax.precedence.join(' > '), catalogue,
    request: text.slice(0, REQUEST_CHARS).replace(/\s+/g, ' '),
  };
  return [{ role: 'user', content: tax.prompt.replace(/\{(none|precedence|catalogue|request)\}/g, (_, k) => fill[k]) }];
}

/** A model's answer → a class id, 'none', or 'invalid'. */
export function parseLabel(tax, content) {
  try {
    const s = String(content || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const got = String(JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1))?.class || '').trim();
    return tax.ids.has(got) ? got : got === 'none' ? 'none' : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Prompts shown per class when a coverage reader asks what a class looks like in practice. */
const COVERAGE_EXAMPLES = 5;
const REFERENCE_TEXT_CHARS = 160;

/**
 * Every `reference-<tag>.jsonl` under `dir`'s scope folders (coding's
 * measure-job-classes.mjs writes one per taxonomy version into
 * `<data home>/var/job-classes/<scope>/`), merged by prompt id. A row is
 * {id, ts, agent, repo, set, text, teacher: [pass1, pass2], class}: `class` is
 * the teacher's label where both passes agree, null where they do not.
 */
export function readReferenceSet(dir, tag) {
  const byId = new Map();
  const files = [];
  let scopes = [];
  try { scopes = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return { files, rows: [] }; }
  for (const scope of scopes) {
    const file = `${dir}/${scope}/reference-${tag}.jsonl`;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    files.push(file);
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (r?.id) byId.set(r.id, r); } catch { /* a torn line */ }
    }
  }
  return { files, rows: [...byId.values()] };
}

/**
 * How the taxonomy covers the prompts of each project, from two sources:
 *   live      — the tagger's labels in turn_job_class (current taxonomy only),
 *               `unclear` = sampled turns where the teacher chose otherwise;
 *   reference — the offline reference set, `unclear` = prompts the teacher
 *               itself labelled two ways.
 * Both report `none` as an ordinary class: a prompt no class fits. `none` and
 * `unclear` together are where the taxonomy has gaps. Each class carries a few
 * of the prompts it was given (already redacted: LSL text and tagger previews).
 */
export function jobClassCoverage({ tax, db = null, referenceDir = '', since = '' }) {
  const taxonomy = { tag: tax.tag, precedence: tax.precedence, none: tax.none, groups: tax.groups || [],
    classes: tax.classes.map((c) => ({ id: c.id, test: c.test, examples: c.examples || [], ...(c.group ? { group: String(c.group) } : {}) })) };
  const push = (map, k, v) => { const a = map[k] || (map[k] = []); if (a.length < COVERAGE_EXAMPLES) a.push(v); };

  let live = { n: 0, sampled: 0, cells: [], unclear: [], examples: {}, error: null };
  if (db) {
    try {
      // Every version's labels, each resolved to today's class.
      const tags = versionTags(tax);
      const inTags = `taxonomy IN (${tags.map(() => '?').join(',')})`;
      const cells = new Map();
      const unclear = new Map();
      for (const r of db.prepare(`
        SELECT project, job_class AS jobClass, teacher_class AS teacherClass, COUNT(*) AS n
        FROM turn_job_class WHERE ${inTags} AND labelled_at >= ?
        GROUP BY project, job_class, teacher_class`).all(...tags, since)) {
        const cls = resolveClass(tax, r.jobClass);
        const k = `${r.project}\u0000${cls}`;
        cells.set(k, (cells.get(k) || 0) + r.n);
        if (r.teacherClass) {
          const u = unclear.get(r.project) || { project: r.project, n: 0, sampled: 0 };
          u.sampled += r.n;
          if (resolveClass(tax, r.teacherClass) !== cls) u.n += r.n;
          unclear.set(r.project, u);
        }
      }
      live.cells = [...cells].map(([k, n]) => { const [project, jobClass] = k.split('\u0000'); return { project, jobClass, n }; });
      live.unclear = [...unclear.values()];
      live.n = live.cells.reduce((s, c) => s + c.n, 0);
      live.sampled = live.unclear.reduce((s, c) => s + c.sampled, 0);
      for (const r of db.prepare(`
        SELECT project, job_class AS jobClass, teacher_class AS teacherClass, prompt_preview AS text
        FROM turn_job_class WHERE ${inTags} AND labelled_at >= ? AND prompt_preview != ''
        ORDER BY labelled_at DESC LIMIT 500`).all(...tags, since)) {
        push(live.examples, resolveClass(tax, r.jobClass), { project: r.project, text: r.text, ...(r.teacherClass ? { teacher: resolveClass(tax, r.teacherClass) } : {}) });
      }
    } catch (err) {
      live = { ...live, error: err?.message || String(err) };
    }
  }

  const ref = referenceDir ? readReferenceSet(referenceDir, tax.tag) : { files: [], rows: [] };
  const cells = new Map();
  const unclear = new Map();
  const refExamples = {};
  for (const r of ref.rows) {
    const project = r.repo || '';
    if (r.class) {
      const k = `${project}\u0000${r.class}`;
      cells.set(k, (cells.get(k) || 0) + 1);
      push(refExamples, r.class, { project, text: String(r.text || '').slice(0, REFERENCE_TEXT_CHARS) });
    } else {
      unclear.set(project, (unclear.get(project) || 0) + 1);
      push(refExamples, '(unclear)', { project, text: String(r.text || '').slice(0, REFERENCE_TEXT_CHARS), teacher: (r.teacher || []).join(' / ') });
    }
  }
  const reference = {
    files: ref.files, n: ref.rows.length,
    cells: [...cells].map(([k, n]) => { const [project, jobClass] = k.split('\u0000'); return { project, jobClass, n }; }),
    unclear: [...unclear].map(([project, n]) => ({ project, n })),
    examples: refExamples,
  };
  return { taxonomy, live, reference };
}

export const TURN_JOB_CLASS_DDL = `
  CREATE TABLE IF NOT EXISTS turn_job_class (
    conversation_key TEXT    NOT NULL,
    turn_index       INTEGER NOT NULL,
    agent            TEXT    NOT NULL DEFAULT '',
    project          TEXT    NOT NULL DEFAULT '',
    taxonomy         TEXT    NOT NULL,
    job_class        TEXT    NOT NULL,
    student_model    TEXT    NOT NULL DEFAULT '',
    student_ms       INTEGER,
    teacher_class    TEXT    NOT NULL DEFAULT '',
    teacher_model    TEXT    NOT NULL DEFAULT '',
    prompt_chars     INTEGER NOT NULL DEFAULT 0,
    prompt_preview   TEXT    NOT NULL DEFAULT '',
    labelled_at      TEXT    NOT NULL,
    PRIMARY KEY (conversation_key, turn_index)
  )`;

/**
 * @param {{
 *   getConfig: () => ({enabled: boolean, taxonomyPath: string, bindingsPath?: string, studentProcess: string,
 *     teacherProcess: string, teacherSamplePct: number, maxInFlight: number} | null),
 *   complete: (body: object) => Promise<{content: string, provider?: string, model?: string, latencyMs?: number}>,
 *   db: object|null,          // better-sqlite3 handle (token DB), or null to keep labels in memory only
 *   redact?: (s: string) => string, // applied to the prompt before any model sees it
 *   log?: (msg: string) => void, logErr?: (msg: string) => void,
 *   random?: () => number, now?: () => Date,
 * }} deps
 */
export function createJobClassTagger({ getConfig, complete, db, redact = null, log = () => {}, logErr = () => {}, random = Math.random, now = () => new Date() }) {
  const stats = { observed: 0, labelled: 0, teacherSampled: 0, skipped: {}, dropped: 0, failed: 0, invalid: 0, inFlight: 0 };
  const seen = new Map(); // turn key → true; insertion-ordered, trimmed as an LRU
  const SEEN_MAX = 5000;
  const loaded = new Map(); // taxonomy file → {tax, mtime, error}
  let bindings = { path: '', mtime: 0, doc: null, error: '' };
  let insert = null;
  if (db) {
    try {
      db.exec(TURN_JOB_CLASS_DDL);
      // Added after the first rows: the redacted opening of the text that was
      // classified, so a label can be checked against what it was given.
      try { db.exec(`ALTER TABLE turn_job_class ADD COLUMN prompt_preview TEXT NOT NULL DEFAULT ''`); } catch { /* present */ }
      insert = db.prepare(`INSERT OR IGNORE INTO turn_job_class
        (conversation_key, turn_index, agent, project, taxonomy, job_class, student_model, student_ms,
         teacher_class, teacher_model, prompt_chars, prompt_preview, labelled_at)
        VALUES (@conversation_key, @turn_index, @agent, @project, @taxonomy, @job_class, @student_model, @student_ms,
         @teacher_class, @teacher_model, @prompt_chars, @prompt_preview, @labelled_at)`);
    } catch (err) {
      logErr(`job-class: turn_job_class unavailable, labels are not stored (${err?.message || err})`);
    }
  }

  const skip = (why) => { stats.skipped[why] = (stats.skipped[why] || 0) + 1; };

  /** A taxonomy file, reloaded when it changes; null (its error kept) when it cannot be used. */
  function taxonomy(file) {
    const prev = loaded.get(file);
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (prev?.tax && prev.mtime === mtime) return prev.tax;
      const tax = loadTaxonomy(file);
      loaded.set(file, { tax, mtime, error: '' });
      log(`job-class: taxonomy ${tax.tag} (${tax.ids.size} classes) from ${file}`);
      return tax;
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg !== prev?.error) logErr(`job-class: taxonomy unusable: ${msg}`);
      loaded.set(file, { tax: null, mtime: 0, error: msg });
      return null;
    }
  }

  /** coding's bindings index, reloaded by mtime. Absent or unreadable = every project uses the default. */
  function bindingsDoc(file) {
    if (!file) return null;
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (bindings.path === file && bindings.mtime === mtime) return bindings.doc;
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      bindings = { path: file, mtime, doc: doc && typeof doc === 'object' ? doc : null, error: '' };
      return bindings.doc;
    } catch (err) {
      const msg = err?.code === 'ENOENT' ? '' : (err?.message || String(err));
      if (msg && msg !== bindings.error) logErr(`job-class: bindings index unreadable, using the default taxonomy: ${msg}`);
      bindings = { path: file, mtime: 0, doc: null, error: msg };
      return null;
    }
  }

  /**
   * The taxonomy file for a project: its team's, the default, or null when the
   * index marks the project as a conflict.
   */
  function fileFor(cfg, project) {
    const entry = bindingsDoc(cfg.bindingsPath)?.projects?.[String(project || '').toLowerCase()];
    if (entry?.conflict) return null;
    return typeof entry?.file === 'string' && entry.file ? entry.file : cfg.taxonomyPath;
  }

  /** Every taxonomy this machine labels under: the default and each bound team's. */
  function taxonomies() {
    const cfg = getConfig();
    if (!cfg?.taxonomyPath) return [];
    const out = [{ file: cfg.taxonomyPath, team: null, projects: [] }];
    for (const [team, t] of Object.entries(bindingsDoc(cfg.bindingsPath)?.teams || {})) {
      if (t?.usable && typeof t.file === 'string') out.push({ file: t.file, team, projects: Array.isArray(t.projects) ? t.projects : [] });
    }
    return out.map((e) => {
      const tax = taxonomy(e.file);
      return { ...e, tax, tag: tax?.tag || null, error: tax ? null : loaded.get(e.file)?.error || 'unusable' };
    });
  }

  async function ask(proc, t, text) {
    const r = await complete({ process: proc, messages: renderRequest(t, text) });
    return { label: parseLabel(t, r?.content), model: r?.provider && r?.model ? `${r.provider}/${r.model}` : String(r?.model || ''), ms: r?.latencyMs };
  }

  async function label(key, id, meta, t, text, cfg) {
    stats.inFlight += 1;
    try {
      const student = await ask(cfg.studentProcess, t, text);
      if (student.label === 'invalid') stats.invalid += 1;
      let teacher = { label: '', model: '' };
      if (random() < cfg.teacherSamplePct) {
        stats.teacherSampled += 1;
        try { teacher = await ask(cfg.teacherProcess, t, text); } catch (err) { logErr(`job-class: teacher failed (${err?.message || err})`); }
      }
      const row = {
        conversation_key: id.conversation_key, turn_index: id.turn_index, agent: meta.agent || '', project: meta.project || '',
        taxonomy: t.tag, job_class: student.label, student_model: student.model,
        student_ms: Number.isFinite(student.ms) ? Math.round(student.ms) : null,
        teacher_class: teacher.label, teacher_model: teacher.model, prompt_chars: text.length,
        prompt_preview: text.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' '),
        labelled_at: now().toISOString(),
      };
      if (insert) insert.run(row);
      stats.labelled += 1;
      log(`job-class: ${meta.agent || '-'} turn ${id.turn_index} → ${student.label}${teacher.label ? ` (teacher ${teacher.label})` : ''}`);
    } catch (err) {
      stats.failed += 1;
      seen.delete(key); // a later call of the same turn may try again
      logErr(`job-class: student failed (${err?.message || err})`);
    } finally {
      stats.inFlight -= 1;
    }
  }

  /**
   * Called for every foreground request. Returns immediately; at most one label
   * per turn is started, in the background.
   */
  function observe({ messages, agent = '', project = '', kind = 'main', headers = {}, taskId = '' } = {}) {
    try {
      const cfg = getConfig();
      if (!cfg?.enabled) return;
      stats.observed += 1;
      if (kind !== 'main') return skip(kind);
      if (isAutomatedRequest(headers, taskId, { taskBound: cfg.skipTaskBound !== false })) return skip('automated');
      const id = turnIdentity(messages, agent);
      if (!id.conversation_key || !(id.turn_index > 0)) return skip('no-turn');
      if (toolsInCurrentTurn(messages)) return skip('mid-loop');
      const key = `${id.conversation_key}:${id.turn_index}`;
      if (seen.has(key)) return skip('seen');
      const text = cleanTurnText(messages);
      // Not marked seen when there is nothing to label: a request the agent
      // makes between turns (Claude Code's next-prompt suggestion) carries the
      // NEXT turn's identity, and marking it hid the person's real prompt at
      // that index as a repeat (2026-10-28).
      if (!text) return skip('noise-or-short');
      seen.set(key, true);
      if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
      const safe = redact ? redact(text.slice(0, REDACT_CHARS)) : text.slice(0, REDACT_CHARS);
      if (typeof safe !== 'string' || safe.includes(REDACTION_BLOCKED)) return skip('redaction-blocked');
      if (stats.inFlight >= cfg.maxInFlight) { stats.dropped += 1; seen.delete(key); return; }
      const file = fileFor(cfg, project);
      if (!file) return skip('taxonomy-conflict');
      const t = taxonomy(file);
      if (!t) return skip('no-taxonomy');
      label(key, id, { agent, project }, t, safe, cfg);
    } catch (err) {
      stats.failed += 1;
      logErr(`job-class: observe failed (${err?.message || err})`);
    }
  }

  /** A taxonomy by tag, or the default (no tag); null when it is not one this machine uses. */
  function taxonomyByTag(tag) {
    const all = taxonomies();
    if (!tag) return all[0]?.tax || null;
    return all.find((e) => e.tag === tag)?.tax || null;
  }

  return {
    observe,
    taxonomy: taxonomyByTag,
    taxonomies: () => taxonomies().map(({ tax: _tax, ...e }) => e),
    stats: () => {
      const all = taxonomies();
      return { ...stats, skipped: { ...stats.skipped }, taxonomy: all[0]?.tag || null, taxonomyError: all[0] && !all[0].tax ? all[0].error : null,
        taxonomies: all.map(({ tax: _tax, ...e }) => e), conflicts: bindings.doc?.conflicts || [] };
    },
  };
}
