// proxy-bridge/prompt-classifier.mjs
//
// How hard is this request, when the agent that sent it did not say?
//
// ── What this changes, and what it deliberately does not ─────────────────────
// caller-complexity.mjs reads a band the CALLER declared. That works when the
// caller can declare one, and produces nothing useful when it cannot or does
// not. Measured over one session on 2026-08-30:
//
//   fg-chat/pi        medium x11   pi's thinking slider said medium, so
//                                  "how many r's in strawberry" was never
//                                  offload-eligible (offload_bands: [small])
//   fg-chat/opencode  high   x22   opencode declared nothing at all
//
// Neither number is about the requests. They are about the sliders.
//
// This module reads prompt content, which llm-routing.yaml and
// caller-complexity.mjs both argue against. The objection is worth restating
// because the design answers it rather than ignoring it: a classifier "would
// make *why did this call go there?* unanswerable from the config alone". Three
// properties keep that answerable:
//
//   1. DOWNGRADE-ONLY. A verdict may lower a band, never raise it. The caller's
//      own declaration stays a ceiling, so the worst case is the behaviour we
//      already had. Nothing can be made dumber than the agent asked for.
//   2. The verdict is recorded — a distinct `complexitySource` of 'classifier'
//      on the row and in the routing trail, never blended into 'caller'.
//   3. /api/llm/routing/resolve takes the verdict as a parameter, so any
//      decision remains reproducible from the config without the prompt.
//
// ── Why stage 1 is a veto and not a verdict ──────────────────────────────────
// The obvious design is a keyword/length heuristic that answers `small` cheaply
// and escalates otherwise. Measured against 45 real foreground prompts, a
// hand-written version of exactly that marked 25 of them `small` and an LLM
// disagreed on 17. A heuristic that confident and that wrong is worse than no
// classifier at all, because every error spends a real turn on a weak model.
//
// So stage 1 never says `small`. It only ever says "do not bother asking" —
// which cannot cause a false downgrade, only prevent a true one, and that is
// the right direction for a cheap stage to be wrong in.
//
// PURE — no env, no I/O, no clock, no logging. The stage-2 client that does I/O
// is passed in as a function so this module stays testable on its own.

import { toolsInCurrentTurn } from './turn-band.mjs';

/**
 * The rubric the `local-llm` classifier sends.
 *
 * Calibration is not a detail here, it is the whole thing. Measured 2026-08-30
 * against llama.cpp: with a bare "how hard is this?" prompt, "how many r's in
 * strawberry" came back `medium` — the exact request that motivated the
 * feature. With the three definition lines below it comes back `small`. Same
 * model, same temperature; only this text changed.
 *
 * Kept as ONE constant because llama.cpp KV-caches the prefix: the first call
 * after a change costs a full prefill (~4.8s measured), every call after it
 * ~600-900ms. Varying this string per request would pay that prefill every time.
 */
export const CLASSIFIER_RUBRIC = [
  'You route requests to a model tier. Answer with EXACTLY one word: small, medium, or high.',
  'small  = trivial factual/lookup/formatting, one-step, no code reasoning, no tools needed.',
  'medium = ordinary single-file coding, explanation, or multi-step reasoning.',
  'high   = multi-file refactor, architecture, debugging across systems, or subtle correctness.',
].join('\n');

/** Ordered cheapest-first. Index comparison is what makes "downgrade" meaningful. */
export const BAND_ORDER = ['small', 'medium', 'high'];

/** Why a request was not classified. Logged and put in the trail, never silent. */
export const SKIP = Object.freeze({
  DISABLED: 'classifier disabled',
  NOT_FROM_CALLER: 'route declares a fixed band',
  ALREADY_LOWEST: 'declared band is already the lowest',
  MID_LOOP: 'turn is inside a tool loop',
  TOO_LARGE: 'request body is larger than the eligibility threshold',
  NO_USER_TEXT: 'no user message to classify',
  VETOED: 'cheap pre-filter says this is not trivial',
});

/**
 * Is this request one the classifier may look at?
 *
 * ── The gate that matters is MID_LOOP ───────────────────────────────────────
 * An agentic turn in the middle of a tool-use loop can look trivial from its
 * last message ("· bash(Read full archived span)") while being anything but.
 * Real examples from the captured corpus, all of which a text classifier calls
 * `small`. Downgrading those is exactly the wrong call.
 *
 * A tools[] gate cannot separate them: pi and opencode send tools[] on every
 * turn including the first. The signal that does is whether a tool message has
 * come back IN THIS TURN, which toolsInCurrentTurn() (turn-band.mjs) computes
 * for both wires.
 *
 * Scoped to the current turn, not the conversation. The gate used to ask
 * whether any message of the conversation was a tool message — and since every
 * agent re-sends the whole conversation, one file read in turn 1 made every
 * later turn "mid-loop" for good. A fresh human prompt in a later turn is now
 * judged on its own text. That is the same risk already accepted for a turn 2
 * of a chat without tools ("yes, do it"), and stage 1 and the downgrade-only
 * rule bound it the same way.
 *
 * A call that IS inside a loop is still never classified. It does not lose its
 * turn's verdict either: the callers recall the band the turn's first call got
 * (turn-band.mjs) and apply that, so a turn classified `small` stays `small`
 * through its loop instead of jumping back to the declared band at the first
 * tool result.
 *
 * @param {object} input
 * @param {string} input.bandSource   `complexitySource` from resolveRoute
 * @param {string} input.declaredBand the band that would apply without us
 * @param {Array}  input.messages     the request's messages, either wire
 * @param {number} input.maxBytes     eligibility ceiling on total message bytes
 * @returns {{eligible: boolean, reason: string}}
 */
export function classifierEligibility({ bandSource, declaredBand, messages, maxBytes = 20000 }) {
  const no = (reason) => ({ eligible: false, reason });

  // Only routes that delegate the band. resolveRoute reports that as either
  // 'caller' (the caller supplied one) or a string starting 'defaults.' (it
  // asked for from-caller and got nothing usable). A route with its OWN band
  // says `route <key>` and is never second-guessed — background services choose
  // their bands deliberately, and bg-kgbench-judge's choice IS the measurement.
  const src = String(bandSource || '');
  if (src !== 'caller' && !src.startsWith('defaults.')) return no(SKIP.NOT_FROM_CALLER);

  // Nothing below `small` to move to, so there is no verdict worth paying for.
  if (declaredBand === BAND_ORDER[0]) return no(SKIP.ALREADY_LOWEST);

  const msgs = Array.isArray(messages) ? messages : [];
  if (toolsInCurrentTurn(msgs)) return no(SKIP.MID_LOOP);

  // A large body is both expensive to classify and unlikely to be trivial. Note
  // this counts USER content only — the agent's system prompt is 34KB on its own
  // and says nothing about the request (see lastUserText).
  let bytes = 0;
  for (const m of msgs) {
    if (m?.role === 'user') bytes += byteLength(m.content);
  }
  if (bytes > maxBytes) return no(SKIP.TOO_LARGE);

  return { eligible: true, reason: '' };
}

/**
 * The text to classify: the last user message, capped.
 *
 * The system prompt is deliberately excluded. On the OpenAI wire — the only one
 * this runs on, since fg-chat/claude is a pinned-high Anthropic passthrough — a
 * fresh opencode turn is `system` (34,045 bytes of agent instructions) plus
 * `user` (33 bytes: the actual request). Classifying the concatenation would be
 * classifying opencode's system prompt, which is identical on every turn and
 * therefore carries no signal about this one.
 *
 * @param {Array} messages
 * @param {number} cap  characters
 * @returns {string}
 */
export function lastUserText(messages, cap = 2000) {
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i]?.role !== 'user') continue;
    const t = flattenContent(msgs[i].content).trim();
    if (t) return t.slice(0, cap);
  }
  return '';
}

/**
 * Stage 1: a veto, not a verdict. True = "do not spend a call on this".
 *
 * Every pattern here is a marker of work that is definitely NOT trivial, so a
 * false positive costs one missed downgrade and a false negative costs one
 * stage-2 call. Both are cheap. Compare a stage that answered `small` directly,
 * where a false positive costs a real turn on a weak model — which is why this
 * one cannot answer `small` at all.
 *
 * @param {string} text
 * @returns {boolean} true when stage 2 should be skipped and the band left alone
 */
export function vetoesDowngrade(text) {
  const t = String(text || '');
  if (!t) return true;
  if (t.length > 600) return true;                    // long asks are rarely trivial
  if (/```|\bdiff --git\b|^\s*[+-]{3} /m.test(t)) return true;   // code / patch content
  if (/\/[\w.-]+\/[\w.-]+|\.\w{2,4}:\d+/.test(t)) return true;   // paths, file:line
  if (/\b(refactor|migrate|debug|architecture|race condition|deadlock|regression)\b/i.test(t)) return true;
  if (/\b(then|after that|and also|finally)\b/i.test(t)) return true; // multi-step
  return false;
}

/**
 * Apply a verdict under the downgrade-only rule.
 *
 * @param {string} declaredBand
 * @param {string} verdict
 * @returns {{band: string, lowered: boolean, capped: boolean}}
 */
export function applyDowngrade(declaredBand, verdict) {
  const di = BAND_ORDER.indexOf(declaredBand);
  const vi = BAND_ORDER.indexOf(verdict);
  if (di < 0 || vi < 0) return { band: declaredBand, lowered: false, capped: false };
  if (vi < di) return { band: verdict, lowered: true, capped: false };
  // The verdict was equal or HARDER. Equal is a no-op; harder is refused, and
  // refusing it is the whole safety property — a classifier that could raise a
  // band would be able to move spend onto a more expensive model on a misread.
  return { band: declaredBand, lowered: false, capped: vi > di };
}

/**
 * The whole cascade. Stages 0 and 1 are pure; stage 2 is whatever `verdictFn`
 * does, which is where the pluggability lives — a local model, an HTTP service
 * the operator supplies, or nothing at all.
 *
 * FAILS OPEN, ALWAYS. A timeout, a non-200, an unparseable answer or a band
 * outside `allowedBands` all resolve to "no change". This is the opposite of the
 * availability probe's fail-CLOSED doctrine, and deliberately so: a wrong
 * "provider unavailable" costs money, while a wrong classifier verdict moves a
 * real turn onto a weaker model. When unsure, do nothing.
 *
 * @param {object} input
 * @param {boolean} input.enabled
 * @param {string} input.bandSource
 * @param {string} input.declaredBand
 * @param {Array} input.messages
 * @param {number} [input.maxBytes]
 * @param {string[]} [input.allowedBands]  bands the classifier may EMIT
 * @param {(text: string) => Promise<string>} [input.verdictFn]  stage 2
 * @returns {Promise<{band: string, changed: boolean, source: string, detail: string}>}
 */
export async function classifyRequest({
  enabled,
  bandSource,
  declaredBand,
  messages,
  maxBytes = 20000,
  allowedBands = ['small'],
  verdictFn = null,
}) {
  const unchanged = (detail) => ({ band: declaredBand, changed: false, source: '', detail });

  if (!enabled) return unchanged(SKIP.DISABLED);

  const gate = classifierEligibility({ bandSource, declaredBand, messages, maxBytes });
  if (!gate.eligible) return unchanged(gate.reason);

  const text = lastUserText(messages);
  if (!text) return unchanged(SKIP.NO_USER_TEXT);
  if (vetoesDowngrade(text)) return unchanged(SKIP.VETOED);

  if (typeof verdictFn !== 'function') return unchanged('no classifier impl configured');

  let verdict = '';
  try {
    verdict = String(await verdictFn(text) || '').trim().toLowerCase();
  } catch (e) {
    return unchanged(`classifier error: ${e?.message || 'unknown'}`);
  }

  // A band the operator did not authorise this classifier to emit is treated as
  // no answer. `allowedBands` defaults to ['small'] so that turning the thing on
  // cannot, by configuration alone, start moving work in unintended directions.
  if (!allowedBands.includes(verdict)) {
    return unchanged(`verdict "${verdict || '(empty)'}" not in allowed bands [${allowedBands.join(', ')}]`);
  }

  const applied = applyDowngrade(declaredBand, verdict);
  if (!applied.lowered) {
    return unchanged(applied.capped
      ? `verdict "${verdict}" is harder than the declared "${declaredBand}" — capped`
      : `verdict "${verdict}" matches the declared band`);
  }
  return {
    band: applied.band,
    changed: true,
    source: 'classifier',
    detail: `classified ${declaredBand} -> ${applied.band}`,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).join(' ');
  }
  return '';
}

function byteLength(content) {
  try { return Buffer.byteLength(flattenContent(content), 'utf8'); } catch { return 0; }
}
