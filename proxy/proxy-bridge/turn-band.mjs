// proxy-bridge/turn-band.mjs
//
// The band a TURN was given, held for the rest of that turn.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// An agentic turn is one human prompt followed by a loop of calls: the model
// asks for a tool, the agent runs it, the result goes back, the model asks for
// the next one. The band was decided once, at the first call, from the human's
// words. Until this module, every later call of the loop was judged afresh, and
// judged by a rule that could only say "keep it on the provider":
//
//   offload.mjs          `turn carries tool results` → kept
//   prompt-classifier    MID_LOOP                     → declared band kept
//
// So a turn whose first call was classified `small` and offloaded ran its
// SECOND call — the first one carrying a tool result — on the agent's own
// provider. The local server had just prefilled 20-30k tokens of system prompt,
// tools and history into its KV cache, and the call that would have reused all
// of it went somewhere else. The turn paid the slow local prefill and then paid
// the cloud anyway, and a half-local turn is harder to reason about than either
// half.
//
// The MID_LOOP gate itself is right and stays: a call inside a loop can look
// trivial from its last message ("· bash(read span)") while the turn is
// anything but, so the classifier must not judge it. What was wrong is the
// consequence. "Do not judge this call" should mean "keep the judgement the
// turn already got", not "throw the judgement away".
//
// ── Two things, kept apart ──────────────────────────────────────────────────
//   toolsInCurrentTurn()   is this call inside a tool loop?  PURE.
//   createTurnBandMemory() what did this turn's first call decide?  In-process
//                          state, bounded in size and age.
//
// The memory is per process and lost on restart. That is the safe direction:
// a loop call that finds no record is treated exactly as before this module
// existed — kept on its provider.
//
// ── The same idea one level up: the session ─────────────────────────────────
// Holding the band through a turn stops the flip INSIDE a task. Across turns a
// session could still flip: turn 1 `small` runs locally, turn 2 `medium` goes
// to the cloud, turn 3 `small` comes back to a local server that may have
// evicted its cache meanwhile, and the cloud's cache for it goes cold in turn.
// The rule, applied at each turn's FIRST call:
//
//   • a session that has been offloaded stays offloaded for later turns, as
//     long as each turn is still judged at an offloaded band;
//   • a later turn judged above it PROMOTES the session: that turn and every
//     later one stay on the provider, unjudged (band source 'session');
//   • a promoted session is never demoted again.
//
//   sessionTurn()          which session and which turn is this call?  PURE.
//   sessionVerdict()       does the session's record decide this turn?  PURE.
//   nextSessionRecord()    what does this turn leave in the record?  PURE.
//   createTurnBandMemory() holds the records as well, with a longer TTL.
//
// A promotion applies only to turns AFTER the one that caused it, so a retry of
// that same turn is judged afresh. With no record (restart, expiry) a turn is
// judged on its own, as before: at most one flip per session.

import { toolMeta } from './context-turns.mjs';
import { turnIdentity } from './turn-identity.mjs';

/**
 * Is this call inside the tool loop of its turn, rather than the turn's first call?
 *
 * ── Scoped to the CURRENT turn, deliberately ─────────────────────────────────
 * The rule this replaces asked whether ANY message of the conversation was a
 * tool message. Every agent re-sends the whole conversation, so after the first
 * tool call of a session that was true forever: turn 7 of an agentic session —
 * a fresh human question — was "mid-loop" because turn 1 had read a file. The
 * turn boundary is the last human message, so only what follows it counts.
 *
 * ── A human message straight after a tool message is still the loop ─────────
 * Some agents interject a user-role message inside a loop (pi's
 * "· bash(read span)"). A real new turn starts after the assistant has finished
 * — its last message carries no tool call. So when the message just before the
 * latest human message is itself a tool message, the turn has not ended, and
 * the call is treated as mid-loop. Erring this way costs a missed
 * classification, never a wrong downgrade.
 *
 * Both wires: toolMeta() recognises role:'tool' and assistant tool_calls
 * (OpenAI) and tool_use / tool_result blocks (Anthropic, where a tool result
 * arrives as a role:'user' message).
 *
 * @param {Array} messages the request's messages, either wire
 * @returns {boolean} true when the call belongs to a tool loop; never throws
 */
export function toolsInCurrentTurn(messages) {
  try {
    const msgs = Array.isArray(messages) ? messages : [];
    let lastHuman = -1;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i]?.role === 'user' && !toolMeta(msgs[i])) { lastHuman = i; break; }
    }
    // No human message at all: nothing marks a turn start, so any tool message
    // means a loop.
    if (lastHuman < 0) return msgs.some((m) => toolMeta(m));
    for (let i = lastHuman + 1; i < msgs.length; i += 1) {
      if (toolMeta(msgs[i])) return true;
    }
    for (let i = lastHuman - 1; i >= 0; i -= 1) {
      if (msgs[i]?.role === 'system') continue;
      return Boolean(toolMeta(msgs[i]));
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The memory key of the turn a call belongs to: `<conversation_key>:<turn_index>`.
 *
 * turn-identity.mjs already derives both from the request alone and holds the
 * turn index still across every step of a loop, which is exactly the grouping
 * needed here. '' when the request carries nothing to key on — and an empty
 * key is never stored or found.
 *
 * Foreground only, like turnIdentity itself: a background job has no turn.
 *
 * @param {Array} messages
 * @param {string} [agent]
 * @returns {string}
 */
export function turnBandKey(messages, agent = '') {
  const { conversation_key: key, turn_index: turn } = turnIdentity(messages, agent);
  return key && turn > 0 ? `${key}:${turn}` : '';
}

/**
 * The session a call belongs to and the turn it is on.
 *
 * The session is the conversation key turnIdentity() derives, per agent; the
 * turn is its human-prompt index. `sessionKey` is '' when there is nothing to
 * key on, and an empty key is never stored or found.
 *
 * @param {Array} messages
 * @param {string} [agent]
 * @returns {{sessionKey: string, turn: number}}
 */
export function sessionTurn(messages, agent = '') {
  const { conversation_key: key, turn_index: turn } = turnIdentity(messages, agent);
  return key && turn > 0 ? { sessionKey: `${agent || '-'}:${key}`, turn } : { sessionKey: '', turn: 0 };
}

/**
 * Does the session's record decide this turn before anything judges it?
 *
 * Only a promotion does, and only for a turn after the one that caused it.
 *
 * @param {object|undefined} record what nextSessionRecord() left
 * @param {number} turn this call's turn index
 * @returns {{promoted: true, band: string, since: number}|null}
 */
export function sessionVerdict(record, turn) {
  if (!record || !record.promoted) return null;
  if (!(turn > record.promotedAt)) return null;
  return { promoted: true, band: record.band, since: record.promotedAt };
}

/**
 * The record a turn's first call leaves for the turns after it.
 *
 * @param {object|undefined} record the session's record before this turn
 * @param {object} turn
 * @param {number} turn.turn       this turn's index
 * @param {string} turn.band       the band it was judged at
 * @param {boolean} turn.offloadable whether that band is one that is offloaded
 * @returns {object|undefined} the new record, or undefined to leave it alone
 */
export function nextSessionRecord(record, { turn, band, offloadable }) {
  if (record?.promoted) return undefined;
  if (offloadable) return { offloaded: true, band, turn };
  if (record?.offloaded) return { promoted: true, band, promotedAt: turn };
  return undefined;
}

/**
 * A bounded, expiring map from turn key to the decision its first call got.
 *
 * Bounded because the proxy runs for weeks and every conversation leaves an
 * entry; a Map's insertion order gives LRU for free (a recall re-inserts).
 * Expiring because a turn that has been silent for half an hour is over in any
 * sense that matters to a KV cache, and a stale record must not route a later
 * call by itself.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxEntries]
 * @param {number} [opts.ttlMs]      age after which a record is ignored and dropped
 * @param {() => number} [opts.now]
 * @returns {{
 *   remember(key: string, record: object): void,
 *   recall(key: string): object|undefined,
 *   size(): number,
 * }}
 */
export function createTurnBandMemory({ maxEntries = 2000, ttlMs = 30 * 60_000, now = Date.now } = {}) {
  const entries = new Map();
  const cap = Math.max(1, Math.floor(Number(maxEntries) || 1));

  return {
    remember(key, record) {
      if (!key || !record || typeof record !== 'object') return;
      entries.delete(key);
      entries.set(key, { ...record, at: now() });
      while (entries.size > cap) entries.delete(entries.keys().next().value);
    },
    recall(key) {
      if (!key) return undefined;
      const e = entries.get(key);
      if (!e) return undefined;
      if (now() - e.at > ttlMs) { entries.delete(key); return undefined; }
      // Refresh both the LRU position and the age: a loop that is still
      // running is a turn that is still live.
      entries.delete(key);
      e.at = now();
      entries.set(key, e);
      const { at, ...record } = e;
      return record;
    },
    size() { return entries.size; },
  };
}
