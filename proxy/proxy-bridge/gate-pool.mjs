/**
 * gate-pool.mjs — the job-class gate, counted across a team
 * (coding .planning/shared-job-classes.md, P6).
 *
 * One machine reaches the gate (≥ 20 teacher-checked turns per class) slowly:
 * only the first prompt of a human turn is labelled, and only a share of those
 * is checked. A team that shares one taxonomy can add its members' counts.
 *
 * WHAT A MEMBER PUBLISHES — counts, never prompts. One file per member,
 * `<package>/gate/<member>.json`, beside the team's `taxonomy.yaml`:
 *
 *   { format, member, publishedAt, pools: [{ taxonomy, labeller, checker,
 *     classes: { <id>: { labelled, checked, agree } }, confusions: [[label, teacher, n]] }] }
 *
 * The counts cover the gate's own window (GATE.days, 90) before `publishedAt`;
 * no `since` is stored, because a moving date would change the file every day
 * and republishing unchanged counts must commit nothing.
 *
 * `member` is the same 10-character pseudonym as a P3 proposal (no user or
 * host name). A file is a full snapshot that replaces itself, so publishing
 * twice counts once, and an unchanged snapshot keeps its `publishedAt`: the
 * file is byte-identical and git has nothing to commit.
 *
 * A POOL is (taxonomy tag, labeller model, checker model). Counts are only ever
 * added within one: a teacher-only labeller checked by itself measures
 * consistency, a student checked by a teacher measures the student's precision,
 * and a member on an older taxonomy version labels against other classes. Each
 * is shown apart, never summed.
 *
 * One implementation for the proxy (summary `scope=team`), coding
 * (`coding job-classes publish`, `coding sync --push`) and glass's daemon.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GATE, resolveClass, versionTags } from './job-class.mjs';

export const GATE_DIR = 'gate';
/** The file name that makes a taxonomy a team package (coding lib/job-classes/package.mjs TAXONOMY_FILE). */
export const PACKAGE_TAXONOMY = 'taxonomy.yaml';
/** A member file older than this is shown, greyed, and left out of the team's sums. */
export const STALE_DAYS = 14;
export const FORMAT = 1;

const MEMBER = /^[0-9a-f]{10}$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_CLASSES = 64;
const MAX_POOLS = 16;
const MAX_FILE_BYTES = 256 * 1024;

/**
 * This member, as a stable pseudonym: the same hash as coding's P3 proposals
 * (lib/job-classes/evolve.mjs memberId), so one person is one member in both.
 *
 * `install` names a second labeller on the same machine (glass beside coding).
 * Without it the two shared one gate file, and each replaced that file with its
 * own live counts (teamPool skips `self`), so neither ever added the other's.
 * They label different turns: a call glass forwards to coding's proxy carries a
 * task binding, which that proxy treats as automated and never labels
 * (isAutomatedRequest). So each install publishes its own file. No install
 * keeps the plain hash, so coding's existing file and its proposals stay put.
 */
export function memberId({ hostname = os.hostname(), user = os.userInfo().username, install = '' } = {}) {
  const key = install ? `${hostname}:${user}:${install}` : `${hostname}:${user}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
}

/**
 * A model as both sides name it: no provider prefix, lower case, '.' and '-'
 * alike (Copilot says claude-haiku-5.5, Anthropic claude-haiku-5-5).
 */
export function normModel(m) {
  const s = String(m || '').trim().toLowerCase();
  return s.slice(s.lastIndexOf('/') + 1).replace(/\./g, '-');
}

/** The gate directory of a taxonomy file, or null when the file is no team package (the shipped default). */
export function gateDirOf(taxonomyFile) {
  if (typeof taxonomyFile !== 'string' || path.basename(taxonomyFile) !== PACKAGE_TAXONOMY) return null;
  return path.join(path.dirname(taxonomyFile), GATE_DIR);
}

const poolKey = (p) => `${p.taxonomy}|${p.labeller}|${p.checker}`;
const emptyCounts = () => ({ labelled: 0, checked: 0, agree: 0 });

function sortedClasses(classes) {
  return Object.fromEntries(Object.keys(classes).sort().map((k) => [k, { labelled: classes[k].labelled, checked: classes[k].checked, agree: classes[k].agree }]));
}

/**
 * This machine's counts under `tax`, as the pools a member file holds. Labels
 * of every version of the taxonomy count, each resolved to the class that holds
 * it now, as the local gate counts them (job-class.mjs classAgreement); the
 * pool is tagged with the CURRENT version, so a member who has not pulled a
 * fold publishes under the old tag and is shown apart.
 *
 * Unchecked labels join the pool of their labeller's most frequent checker.
 *
 * @param {{db: object, tax: object, since?: string, now?: Date}} o
 * @returns {Array<{taxonomy: string, labeller: string, checker: string, classes: object, confusions: Array}>}
 */
export function gateSnapshot({ db, tax, since, now = new Date() }) {
  const from = since || new Date(now.getTime() - GATE.days * 86_400_000).toISOString();
  const tags = versionTags(tax);
  const rows = db.prepare(`
    SELECT job_class AS jobClass, teacher_class AS teacherClass, student_model AS studentModel,
           teacher_model AS teacherModel, COUNT(*) AS n
    FROM turn_job_class
    WHERE labelled_at >= ? AND taxonomy IN (${tags.map(() => '?').join(',')})
    GROUP BY job_class, teacher_class, student_model, teacher_model`).all(from, ...tags);

  // Which checker a labeller's unchecked labels belong with: its most frequent.
  const checkers = new Map();
  for (const r of rows) {
    if (!r.teacherClass) continue;
    const l = normModel(r.studentModel);
    const m = checkers.get(l) || new Map();
    const c = normModel(r.teacherModel);
    m.set(c, (m.get(c) || 0) + Number(r.n));
    checkers.set(l, m);
  }
  const checkerOf = (l) => [...(checkers.get(l) || new Map()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';

  const pools = new Map();
  for (const r of rows) {
    const labeller = normModel(r.studentModel);
    if (!labeller) continue;
    const checker = r.teacherClass ? normModel(r.teacherModel) : checkerOf(labeller);
    const key = poolKey({ taxonomy: tax.tag, labeller, checker });
    const p = pools.get(key) || { taxonomy: tax.tag, labeller, checker, classes: {}, confusions: new Map() };
    const cls = resolveClass(tax, r.jobClass);
    const c = p.classes[cls] || emptyCounts();
    const n = Number(r.n);
    c.labelled += n;
    if (r.teacherClass) {
      const teacher = resolveClass(tax, r.teacherClass);
      c.checked += n;
      if (teacher === cls) c.agree += n;
      else p.confusions.set(`${cls}\0${teacher}`, (p.confusions.get(`${cls}\0${teacher}`) || 0) + n);
    }
    p.classes[cls] = c;
    pools.set(key, p);
  }
  return [...pools.values()]
    .map((p) => ({
      ...p,
      classes: sortedClasses(p.classes),
      confusions: [...p.confusions.entries()].map(([k, n]) => [...k.split('\0'), n]).sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
    }))
    .sort((a, b) => poolKey(a).localeCompare(poolKey(b)));
}

/**
 * Problems with a member file, as messages; [] when it is usable. Strict: the
 * file comes from a teammate's push, and its numbers may decide routing.
 */
export function validateMemberFile(doc, fileName = '') {
  const errors = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['not a JSON object'];
  if (doc.format !== FORMAT) errors.push(`format must be ${FORMAT}`);
  if (!MEMBER.test(String(doc.member || ''))) errors.push('member must be a 10-character hex pseudonym');
  else if (fileName && path.basename(fileName) !== `${doc.member}.json`) errors.push(`file must be named ${doc.member}.json`);
  if (!Number.isFinite(Date.parse(doc.publishedAt))) errors.push('publishedAt must be a date');
  if (!Array.isArray(doc.pools) || doc.pools.length > MAX_POOLS) return [...errors, `pools must be a list of at most ${MAX_POOLS}`];
  const seen = new Set();
  doc.pools.forEach((p, i) => {
    const at = `pools[${i}]`;
    if (!WORD.test(String(p?.taxonomy || ''))) errors.push(`${at}.taxonomy must be a taxonomy tag`);
    if (!MODEL.test(String(p?.labeller || ''))) errors.push(`${at}.labeller must be a model id`);
    if (p?.checker !== '' && !MODEL.test(String(p?.checker || ''))) errors.push(`${at}.checker must be a model id or ''`);
    const key = poolKey(p || {});
    if (seen.has(key)) errors.push(`${at} repeats a pool`);
    seen.add(key);
    const classes = p?.classes;
    if (!classes || typeof classes !== 'object' || Array.isArray(classes) || Object.keys(classes).length > MAX_CLASSES) {
      errors.push(`${at}.classes must be an object of at most ${MAX_CLASSES} classes`);
      return;
    }
    for (const [id, c] of Object.entries(classes)) {
      const ok = WORD.test(id) && [c?.labelled, c?.checked, c?.agree].every((x) => Number.isSafeInteger(x) && x >= 0)
        && c.agree <= c.checked && c.checked <= c.labelled;
      if (!ok) errors.push(`${at}.classes.${id} must be counts with agree ≤ checked ≤ labelled`);
    }
    if (p.confusions !== undefined && !(Array.isArray(p.confusions) && p.confusions.every((x) => Array.isArray(x) && x.length === 3
      && WORD.test(String(x[0])) && WORD.test(String(x[1])) && Number.isSafeInteger(x[2]) && x[2] > 0))) {
      errors.push(`${at}.confusions must be [label, teacher, n] triples`);
    }
  });
  return errors;
}

const counts = (pools) => JSON.stringify(pools);

/**
 * Write this member's file into `gateDir`. An unchanged snapshot keeps the old
 * `publishedAt`, so the file stays byte-identical and nothing is committed.
 *
 * @returns {{file: string, changed: boolean, doc: object}}
 */
export function writeMemberFile(gateDir, { member, pools, now = new Date() }) {
  if (!MEMBER.test(String(member || ''))) throw new Error('member must be a 10-character hex pseudonym');
  const file = path.join(gateDir, `${member}.json`);
  let before = null;
  try { before = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first publish */ }
  const same = before && counts(before.pools) === counts(pools);
  const doc = { format: FORMAT, member, publishedAt: same ? before.publishedAt : now.toISOString(), pools };
  const errors = validateMemberFile(doc, file);
  if (errors.length) throw new Error(`refusing to write an invalid gate file: ${errors.join('; ')}`);
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* none */ }
  if (old === text) return { file, changed: false, doc };
  fs.mkdirSync(gateDir, { recursive: true });
  fs.writeFileSync(file, text);
  return { file, changed: true, doc };
}

function addInto(target, classes) {
  for (const [id, c] of Object.entries(classes)) {
    const t = target[id] || emptyCounts();
    t.labelled += c.labelled; t.checked += c.checked; t.agree += c.agree;
    target[id] = t;
  }
}

/**
 * The team's counts: every member file in `gateDir`, plus this machine's LIVE
 * pools in place of its own (possibly older) published file, added per pool.
 *
 * @param {{gateDir: string|null, self: string, local: Array, now?: Date, staleDays?: number}} o
 * @returns {{gateDir: string|null, self: string, members: Array, pools: Array}}
 *   members: one row per file (or invalid file), `stale` ones are not added;
 *   pools: { taxonomy, labeller, checker, members: [pseudonym…], local: bool, classes }
 */
export function teamPool({ gateDir, self, local = [], now = new Date(), staleDays = STALE_DAYS }) {
  const members = [];
  const pools = new Map();
  const add = (p, member, isLocal) => {
    const key = poolKey(p);
    const t = pools.get(key) || { taxonomy: p.taxonomy, labeller: p.labeller, checker: p.checker, members: [], local: false, classes: {} };
    if (!t.members.includes(member)) t.members.push(member);
    if (isLocal) t.local = true;
    addInto(t.classes, p.classes);
    pools.set(key, t);
  };
  for (const p of local) add(p, self, true);
  if (local.length) members.push({ member: self, self: true, live: true, stale: false, pools: local.length });

  let files = [];
  try { files = gateDir ? fs.readdirSync(gateDir).filter((f) => f.endsWith('.json')).sort() : []; } catch { /* no gate dir yet */ }
  for (const f of files) {
    const file = path.join(gateDir, f);
    if (f === `${self}.json`) continue; // live counts stand in for our own snapshot
    let doc;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error('too large');
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      members.push({ member: f.replace(/\.json$/, ''), error: `unreadable: ${err?.message || err}` });
      continue;
    }
    const errors = validateMemberFile(doc, file);
    if (errors.length) { members.push({ member: f.replace(/\.json$/, ''), error: errors.join('; ') }); continue; }
    const stale = now.getTime() - Date.parse(doc.publishedAt) > staleDays * 86_400_000;
    members.push({ member: doc.member, publishedAt: doc.publishedAt, stale, pools: doc.pools.length });
    if (!stale) for (const p of doc.pools) add(p, doc.member, false);
  }
  // A pool with no checker holds labels nobody has checked yet (a member who
  // just started). It cannot form a gate of its own, and its labelled counts
  // change no verdict, so it joins the pool of the same taxonomy and labeller
  // that has a checker — the most checked one — instead of standing apart.
  for (const [key, p] of [...pools.entries()]) {
    if (p.checker) continue;
    const checks = (q) => Object.values(q.classes).reduce((n, c) => n + c.checked, 0);
    const into = [...pools.values()].filter((q) => q !== p && q.checker && q.taxonomy === p.taxonomy && q.labeller === p.labeller)
      .sort((a, b) => checks(b) - checks(a))[0];
    if (!into) continue;
    addInto(into.classes, p.classes);
    for (const m of p.members) if (!into.members.includes(m)) into.members.push(m);
    if (p.local) into.local = true;
    pools.delete(key);
  }
  const list = [...pools.values()].map((p) => ({ ...p, classes: sortedClasses(p.classes) }))
    .sort((a, b) => Number(b.local) - Number(a.local) || b.members.length - a.members.length || poolKey(a).localeCompare(poolKey(b)));
  return { gateDir, self, members, pools: list };
}

/**
 * Publish this member's counts into a team package checkout: write the file,
 * commit it under the pseudonym, and (with `push`) push, rebasing once over a
 * teammate's push. Another member's file never conflicts with ours.
 *
 * `git(args)` runs git in the checkout and resolves to {ok, stdout, stderr}:
 * coding and glass each bring their own runner (and the user's credentials).
 *
 * @param {{checkout: string, gateDir: string, member: string, pools: Array, push?: boolean,
 *   git: (args: string[]) => Promise<{ok: boolean, stdout?: string, stderr?: string}>, now?: Date}} o
 * @returns {Promise<{file: string, changed: boolean, committed: boolean, pushed: boolean, error?: string}>}
 */
export async function publishGate({ checkout, gateDir, member, pools, push = false, git, now = new Date() }) {
  const w = writeMemberFile(gateDir, { member, pools, now });
  const rel = path.relative(checkout, w.file).split(path.sep).join('/');
  if (rel.startsWith('..')) throw new Error(`${w.file} is outside the checkout ${checkout}`);
  const out = { file: w.file, changed: w.changed, committed: false, pushed: false };
  const fail = (what, r) => ({ ...out, error: `${what}: ${(r.stderr || r.stdout || '').trim().split('\n').pop() || 'failed'}` });

  const add = await git(['add', '--', rel]);
  if (!add.ok) return fail('git add', add);
  const staged = await git(['diff', '--cached', '--quiet', '--', rel]);
  if (!staged.ok) {
    const c = await git(['-c', `user.name=job-classes ${member}`, '-c', `user.email=${member}@job-classes.invalid`,
      'commit', '-q', '-m', `job-classes: gate counts of ${member}`, '--', rel]);
    if (!c.ok) return fail('git commit', c);
    out.committed = true;
  }
  if (!push) return out;
  const ahead = await git(['rev-list', '--count', '@{upstream}..HEAD']);
  if (ahead.ok && String(ahead.stdout || '').trim() === '0') return out;
  let p = await git(['push', '-q', 'origin', 'HEAD']);
  if (!p.ok) {
    const r = await git(['pull', '--rebase', '-q']);
    if (!r.ok) return fail('git pull --rebase', r);
    p = await git(['push', '-q', 'origin', 'HEAD']);
  }
  if (!p.ok) return fail('git push', p);
  out.pushed = true;
  return out;
}
