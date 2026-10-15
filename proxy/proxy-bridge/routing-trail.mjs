// proxy-bridge/routing-trail.mjs
//
// Serialise what happened to a call on its way to a provider, for the
// `attempt_trail` column on token_usage.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// token_usage used to record only where a call LANDED (provider, model,
// process). That is enough to draw a pie chart and nothing else: it cannot tell
// a fallback from a route change, cannot say which candidate failed first, and
// cannot distinguish "the config never offered this provider" from "the config
// offered it and it was unreachable". The Flow tab papered over the gap by
// inferring — "a thick edge means work is landing somewhere the config never
// sent it" — which is a guess dressed as a finding.
//
// Everything needed was already in scope at dispatch and simply thrown away.
// This module is the write-down.
//
// ── The empty-string contract ────────────────────────────────────────────────
// The overwhelming majority of calls succeed on the first candidate with nothing
// skipped. Those MUST serialise to '' and not '{}': the column is on every row
// of a table that grows by thousands a day, and two bytes of JSON punctuation
// per row buys nothing. '' also makes "was anything unusual about this call?" a
// falsy check rather than a parse.
//
// PURE — no I/O, no clock, no process.env. The caller supplies everything.

/**
 * Build the trail object. Returns null when there is nothing to report, which
 * is what makes the empty case cheap.
 *
 * @param {object} input
 * @param {Array<{provider: string, model?: string, error?: string, ms?: number}>} [input.attempts]
 *   Candidates that were TRIED and failed, in order. The one that succeeded is
 *   not here — it is the row's own provider/model columns.
 * @param {Array<{provider: string, reason: string}>} [input.configSkipped]
 *   Candidates the CONFIG removed before dispatch: capability gate, network
 *   guard, disabled provider.
 * @param {Array<{provider: string, model?: string}>} [input.runtimeDropped]
 *   Candidates the config offered but that were not reachable this minute.
 *   Kept apart from configSkipped because the fixes are different — one is an
 *   edit to a YAML file, the other is a login or a VPN.
 * @param {string} [input.offloadSkipped]
 *   Why semantic routing did NOT move this call, when it was a candidate.
 *   Recording the non-event matters: without it, a call that stayed on copilot
 *   because the guard failed is indistinguishable from one that was never
 *   eligible.
 * @returns {object|null}
 */
export function buildRoutingTrail({
  attempts = [],
  configSkipped = [],
  runtimeDropped = [],
  offloadSkipped = '',
  classifier = '',
} = {}) {
  const trail = {};

  const cleanAttempts = (attempts || [])
    .filter(a => a && a.provider)
    .map(a => ({
      provider: String(a.provider),
      ...(a.model ? { model: String(a.model) } : {}),
      // The error CLASS, not the message. A message can carry a prompt fragment
      // or an upstream request id; a class is what you group by anyway.
      ...(a.error ? { error: String(a.error) } : {}),
      ...(Number.isFinite(a.ms) ? { ms: Math.round(a.ms) } : {}),
    }));
  if (cleanAttempts.length) trail.attempts = cleanAttempts;

  const skipped = [
    ...(configSkipped || [])
      .filter(s => s && s.provider)
      .map(s => ({ provider: String(s.provider), reason: String(s.reason || ''), kind: 'config' })),
    ...(runtimeDropped || [])
      .filter(s => s && s.provider)
      .map(s => ({ provider: String(s.provider), reason: 'not reachable', kind: 'runtime' })),
  ];
  if (skipped.length) trail.skipped = skipped;

  if (offloadSkipped) trail.offloadSkipped = String(offloadSkipped);

  // What the prompt classifier did, or why it did nothing. Recorded for the same
  // reason offloadSkipped is: the non-event is the interesting half. "band was
  // medium" does not distinguish "the agent asked for medium" from "the
  // classifier was never eligible to look" from "it looked and said medium",
  // and those have completely different fixes. route_band alone cannot say.
  //
  // Lives in this JSON blob rather than a new token_usage column deliberately:
  // it is per-row diagnostic text, not something anyone aggregates, and a column
  // would mean a src/token-usage.ts change plus a migration plus `npm run build`
  // for a field the dashboard would never GROUP BY.
  if (classifier) trail.classifier = String(classifier);

  return Object.keys(trail).length ? trail : null;
}

/**
 * The column value. '' when there is nothing to say — see the contract above.
 *
 * Never throws. This runs inside logCall, which is explicitly best-effort ("a DB
 * hiccup must never fail the LLM call"); a serialisation bug here must not be
 * the thing that turns a served completion into a 500. An unserialisable trail
 * degrades to '' — the same as no trail, which is the truthful fallback since
 * we then genuinely have nothing to report.
 *
 * @param {object} input see buildRoutingTrail
 * @returns {string}
 */
export function serializeRoutingTrail(input) {
  try {
    const trail = buildRoutingTrail(input);
    return trail ? JSON.stringify(trail) : '';
  } catch {
    return '';
  }
}

/**
 * Read a stored trail back. '' / null / malformed all yield null rather than
 * throwing, because this is called from an aggregation loop over rows written by
 * older builds and one bad row must not take out the whole query.
 *
 * @param {string} raw
 * @returns {object|null}
 */
export function parseRoutingTrail(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Normalise a failure class for storage.
 *
 * Deliberately NOT a second classifier: server.mjs already has classifyFailure(),
 * and that one is authoritative because llm-fallback.yaml's `retry_on` is matched
 * against its output — the chain literally advances on what it returns. A private
 * copy here would drift, and then the dashboard would group failures differently
 * from the engine that acted on them, which is worse than not grouping at all.
 *
 * The caller passes classifyFailure(msg) through. Its `null` means "not a
 * fallback class" — a genuine client or model error, which is real information
 * (it is why the chain did NOT advance) and is stored as 'error'.
 *
 * The raw message is never stored: it is the one part of a failure that can echo
 * request content back into the DB.
 *
 * @param {string|null} failureClass output of server.mjs classifyFailure()
 * @returns {string}
 */
export function normalizeFailureClass(failureClass) {
  return failureClass || 'error';
}
