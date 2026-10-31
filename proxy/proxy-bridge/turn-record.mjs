// proxy-bridge/turn-record.mjs
//
// The turns a later replay can re-run (coding .planning/shared-job-classes.md,
// P4): for a labelled turn of a class worth replaying, what the person asked and
// the conversation before it, kept by the tagger that labelled it.
//
// ── Why here and not in an agent's transcript ────────────────────────────────
// Every agent reaches the model through this daemon — Claude Code on the
// Anthropic wire, copilot, opencode and pi on the OpenAI one — and so does glass,
// which has no session logs of its own. Reading each agent's on-disk transcript
// meant one reader per agent and a format nobody documents (copilot's); this
// daemon already holds the turn's whole conversation in the request in front of
// it. The record is the same for every agent, in one neutral shape.
//
// ── What is kept, and when ───────────────────────────────────────────────────
// Nothing until the turn is labelled, and then only for a class in `keep`: the
// person's prompt and the conversation that preceded it, each item through the
// daemon's redactor, on bounded slices (the redactor has wedged a process on
// unbounded input). The system prompt and tool schemas are left out: a replay
// runs the agent fresh, which brings its own. When the conversation's next turn
// arrives, its request carries the reply the person read, and that is added as
// the record's `answer`.
//
// ── The repo at turn start ───────────────────────────────────────────────────
// A replay also needs the files the turn saw. This daemon sees the turn's first
// call before any of its tools can run, which is the moment to record them, so
// when `captureScript` is set it is started there, detached, with the turn's
// identity (coding lib/job-classes/turn-capture.mjs). It is started for every
// labelled turn because the label is not known yet; the script drops the
// captures of turns that were not kept.
//
// Never throws into a request: every failure is a log line.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { toolMeta } from './context-turns.mjs';

export const RECORD_SCHEMA = 1;
/** Characters of conversation before the prompt that a record keeps, newest first. */
const HISTORY_CHARS = 120_000;
/** Characters of one history item: a tool result can be a whole file. */
const ITEM_CHARS = 4_000;
/** Characters of the prompt itself. */
const PROMPT_CHARS = 20_000;
/** The redactor sees at most this much at once (the tagger's own bound). */
const REDACT_SLICE = 2_000;
const REDACTION_BLOCKED = '[REDACTION_ERROR_CONTENT_BLOCKED]';
/** Turns waiting for a label, and kept turns waiting for their answer: bounded, oldest out. */
const PENDING_MAX = 200;
const AWAITING_MAX = 500;

const textOfBlock = (b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '');
const stripReminders = (s) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').replace(/<system-reminder>[\s\S]*$/, ' ').trim();

function argsText(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return ''; }
}

/**
 * One message as neutral items: `{role: 'user'|'assistant'|'tool', text, name?}`.
 * Both wires: OpenAI tool_calls and role:'tool', Anthropic tool_use and
 * tool_result blocks (a result arrives inside a user message there). System
 * messages, thinking blocks and harness reminders are not the conversation.
 */
export function messageItems(m) {
  const out = [];
  if (!m || m.role === 'system' || m.role === 'developer') return out;
  if (m.role === 'tool') {
    out.push({ role: 'tool', name: m.name || 'tool', text: Array.isArray(m.content) ? m.content.map(textOfBlock).join('\n') : String(m.content ?? '') });
    return out;
  }
  const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
  const said = [];
  for (const b of blocks) {
    if (b?.type === 'tool_use') out.push({ role: 'assistant', name: b.name || 'tool', text: `→ ${b.name || 'tool'}(${argsText(b.input)})` });
    else if (b?.type === 'tool_result') {
      const c = b.content;
      out.push({ role: 'tool', name: 'tool_result', text: typeof c === 'string' ? c : Array.isArray(c) ? c.map(textOfBlock).join('\n') : argsText(c) });
    } else if (b?.type === 'image' || b?.type === 'image_url') said.push('[image]');
    else if (b?.type === 'text' || typeof b === 'string') said.push(textOfBlock(b));
  }
  const text = stripReminders(said.join('\n'));
  if (text) out.unshift({ role: m.role === 'assistant' ? 'assistant' : 'user', text });
  for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
    const name = tc?.function?.name || tc?.name || 'tool';
    out.push({ role: 'assistant', name, text: `→ ${name}(${argsText(tc?.function?.arguments ?? tc?.arguments)})` });
  }
  return out;
}

/**
 * Where the current turn begins: just after the agent's last reply that was not
 * a tool call (cleanTurnText's rule, so the record and the label agree on the turn).
 */
export function turnStart(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  let start = msgs.length;
  while (start > 0 && !(msgs[start - 1]?.role === 'assistant' && !toolMeta(msgs[start - 1]))) start -= 1;
  return start;
}

/** Whether the turn's own messages carry an image (a replay cannot show it). */
export function turnHasImage(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  return msgs.slice(turnStart(msgs)).some((m) => Array.isArray(m?.content)
    && m.content.some((b) => b?.type === 'image' || b?.type === 'image_url'));
}

/** The reply the person read at the end of the previous turn: the last assistant text before this turn. */
export function previousAnswer(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const before = msgs.slice(0, turnStart(msgs));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const said = messageItems(before[i]).filter((it) => it.role === 'assistant' && !it.name);
    if (said.length) return said.map((it) => it.text).join('\n');
    if (before[i]?.role === 'user' && !toolMeta(before[i])) break;
  }
  return '';
}

/** `s` through the redactor in bounded slices, cut at line ends where possible; null when any slice is blocked. */
export function redactLong(s, redact) {
  if (!redact) return s;
  const parts = [];
  let rest = s;
  while (rest.length) {
    let cut = rest.length <= REDACT_SLICE ? rest.length : rest.lastIndexOf('\n', REDACT_SLICE);
    if (cut <= 0) cut = Math.min(REDACT_SLICE, rest.length);
    const out = redact(rest.slice(0, cut));
    if (typeof out !== 'string' || out.includes(REDACTION_BLOCKED)) return null;
    parts.push(out);
    rest = rest.slice(cut);
  }
  return parts.join('');
}

/**
 * The conversation before the turn, newest kept first up to HISTORY_CHARS,
 * each item capped and redacted. An item the redactor blocks is withheld, not
 * sent in the clear.
 * @returns {{items: object[], omitted: number}}
 */
export function historyItems(messages, redact) {
  const msgs = Array.isArray(messages) ? messages : [];
  const all = msgs.slice(0, turnStart(msgs)).flatMap(messageItems);
  const kept = [];
  let budget = HISTORY_CHARS;
  for (let i = all.length - 1; i >= 0 && budget > 0; i -= 1) {
    const it = all[i];
    const capped = it.text.length > ITEM_CHARS ? `${it.text.slice(0, ITEM_CHARS)}\n[… ${it.text.length - ITEM_CHARS} more characters]` : it.text;
    const safe = redactLong(capped, redact);
    kept.unshift({ ...it, text: safe ?? '[withheld: redaction failed]' });
    budget -= capped.length;
  }
  return { items: kept, omitted: all.length - kept.length };
}

const safeName = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_');

/** The record file of a turn. */
export function recordPath(dir, conversationKey, turnIndex) {
  return path.join(dir, 'turns', `${safeName(conversationKey)}-t${Number(turnIndex)}.json`);
}

function writeAtomic(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * @param {{
 *   redact?: (s: string) => string,
 *   log?: (msg: string) => void, logErr?: (msg: string) => void,
 *   now?: () => Date,
 *   start?: typeof spawn,   // replaced in tests
 *   env?: object,           // the capture script's environment
 * }} deps
 * Each call takes the replay config of the moment: `{dir, keep: string[], captureScript?: string}`.
 * An empty `keep` records nothing and starts no capture.
 */
export function createTurnRecorder({ redact = null, log = () => {}, logErr = () => {}, now = () => new Date(), start = spawn, env = process.env } = {}) {
  const pending = new Map(); // turn key → {id, agent, project, messages, message, at}
  const awaiting = new Map(); // conversation_key → {turnIndex, file}
  const enabled = (cfg) => Boolean(cfg?.dir && Array.isArray(cfg.keep) && cfg.keep.length);
  const bounded = (map, max) => { while (map.size > max) map.delete(map.keys().next().value); };

  /** A turn about to be labelled: hold its request until the label decides, and record the repo now. */
  function begin(cfg, key, { id, agent = '', project = '', messages, message }) {
    if (!enabled(cfg)) return;
    try {
      const at = now().toISOString();
      pending.set(key, { id, agent, project, messages, message, at });
      bounded(pending, PENDING_MAX);
      if (cfg.captureScript && project) {
        const payload = JSON.stringify({ conversationKey: id.conversation_key, turnIndex: id.turn_index, agent, project, at, replayRoot: cfg.dir });
        const child = start(process.execPath, [cfg.captureScript, '--worker', payload], { detached: true, stdio: 'ignore', env });
        child.on?.('error', (err) => logErr(`turn-record: capture did not start (${err?.message || err})`));
        child.unref?.();
      }
    } catch (err) {
      logErr(`turn-record: begin failed (${err?.message || err})`);
    }
  }

  /** The label came back: write the record when its class is kept, forget the turn either way. */
  function settle(cfg, key, { jobClass, taxonomy }) {
    const p = pending.get(key);
    pending.delete(key);
    if (!p || !enabled(cfg) || !cfg.keep.includes(jobClass)) return;
    try {
      // The message as the person sent it, pasted blocks included: the label's
      // cleaned text reduces those to markers, and a replay needs what was pasted.
      const said = messageItems(p.message).filter((it) => it.role === 'user').map((it) => it.text).join('\n');
      const prompt = redactLong(said.slice(0, PROMPT_CHARS), redact);
      if (prompt == null) { log(`turn-record: ${key} not recorded, its prompt failed redaction`); return; }
      const history = historyItems(p.messages, redact);
      const file = recordPath(cfg.dir, p.id.conversation_key, p.id.turn_index);
      writeAtomic(file, {
        schema: RECORD_SCHEMA,
        conversationKey: p.id.conversation_key, turnIndex: p.id.turn_index,
        agent: p.agent, project: p.project, at: p.at, jobClass, taxonomy,
        prompt, image: turnHasImage(p.messages),
        history: history.items, historyOmitted: history.omitted,
        answer: null,
      });
      awaiting.set(p.id.conversation_key, { turnIndex: p.id.turn_index, file });
      bounded(awaiting, AWAITING_MAX);
      log(`turn-record: ${p.agent || '-'} ${key} (${jobClass}) recorded for replay`);
    } catch (err) {
      logErr(`turn-record: write failed (${err?.message || err})`);
    }
  }

  /** The label failed: nothing to decide on. */
  function drop(key) {
    pending.delete(key);
  }

  /**
   * The first call of a conversation's next turn: its request ends with the reply
   * the person read for the previous one. Add it to that turn's record.
   */
  function answer({ id, messages }) {
    const w = awaiting.get(id?.conversation_key);
    if (!w || w.turnIndex !== id.turn_index - 1) return;
    awaiting.delete(id.conversation_key);
    try {
      const text = previousAnswer(messages);
      if (!text) return;
      const safe = redactLong(text.slice(0, PROMPT_CHARS), redact);
      if (safe == null) return;
      const doc = JSON.parse(fs.readFileSync(w.file, 'utf8'));
      writeAtomic(w.file, { ...doc, answer: safe, answeredAt: now().toISOString() });
    } catch (err) {
      logErr(`turn-record: answer not added (${err?.message || err})`);
    }
  }

  return { begin, settle, drop, answer, stats: () => ({ pending: pending.size, awaitingAnswer: awaiting.size }) };
}
