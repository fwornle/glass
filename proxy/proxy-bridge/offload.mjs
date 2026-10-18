// proxy-bridge/offload.mjs
//
// OPT-IN OFFLOAD for a measuring passthrough: answer an easy OpenAI-wire call
// from an OpenAI-compatible endpoint the user named (a local model server, a
// team cluster) instead of the agent's own provider — and, whenever that does
// not work, forward the held original exactly as the passthrough always does.
//
// ── Why the fallback needs no account ────────────────────────────────────────
// The passthrough already holds the whole request, INCLUDING the agent's own
// credentials, before it forwards. So the fallback is not "answer with some
// account the proxy owns" (server.mjs's shims must, because they took the call
// over with a dummy key) — it is the forward that would have happened anyway.
// Offload is the only new branch.
//
// ── What decides ─────────────────────────────────────────────────────────────
// decide() walks a fixed list of gates; the first that fails keeps the call on
// its own provider, and its reason is recorded on the row (attempt_trail), so
// "why did this not move" always has an answer. The gates come from measuring a
// shared 27B cluster: an agent's first turn (20-28k tokens of system prompt and
// tools) takes 40-55 s of uncached prefill, concurrent calls queue at 4-9x, and
// the first byte arrives with the complete answer. Hence a SIZE gate, an
// IN-FLIGHT gate (a second call goes to its provider rather than queue) and a
// short TOTAL budget — an offload must never be much slower than not offloading.
//
// ── Credentials ──────────────────────────────────────────────────────────────
// The target request is built from scratch: content-type, accept and the
// target's own key. Nothing of the agent's headers is copied, so a GitHub or
// OpenAI login can never reach the target, and the target key never reaches an
// upstream (the fallback forwards the ORIGINAL headers, untouched).
//
// ── No site knowledge ────────────────────────────────────────────────────────
// No URL, model id or host is built in. The user supplies the endpoint, its
// key and which of ITS models serves each band; an unconfigured offload is off.

import { BAND_ORDER, classifyRequest, CLASSIFIER_RUBRIC } from './prompt-classifier.mjs';
import { serializeRoutingTrail } from './routing-trail.mjs';
import {
  createTurnBandMemory, nextSessionRecord, sessionTurn, sessionVerdict, toolsInCurrentTurn, turnBandKey,
} from './turn-band.mjs';

export const OFFLOAD_AGENTS = ['opencode', 'pi', 'copilot'];

export const DEFAULT_OFFLOAD = Object.freeze({
  enabled: false,
  agents: Object.freeze({ opencode: false, pi: false, copilot: false }),
  target: Object.freeze({ name: 'local', url: '', models: Object.freeze({ small: '', medium: '', high: '' }) }),
  bands: Object.freeze(['small']),
  classifier: false,
  maxInputTokens: 3000,
  maxInFlight: 1,
  timeoutMs: 8000,
});

const int = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

/** A row's provider id for the target: lower-case, safe in a token_usage column. */
export function targetProviderId(name) {
  const id = String(name || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return id || 'local';
}

/**
 * Any partial / hand-edited / older config → the full shape, every field
 * bounded. Unknown keys are dropped, so a typo cannot switch anything on.
 */
export function normalizeOffloadConfig(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const t = r.target && typeof r.target === 'object' ? r.target : {};
  const m = t.models && typeof t.models === 'object' ? t.models : {};
  const url = String(t.url || '').trim().replace(/\/+$/, '');
  const agents = {};
  for (const a of OFFLOAD_AGENTS) agents[a] = r.agents?.[a] === true;
  const bands = BAND_ORDER.filter((b) => Array.isArray(r.bands) && r.bands.includes(b));
  return {
    enabled: r.enabled === true,
    agents,
    target: {
      name: String(t.name || DEFAULT_OFFLOAD.target.name).trim().slice(0, 40) || DEFAULT_OFFLOAD.target.name,
      url: /^https?:\/\/[^\s]+$/.test(url) ? url : '',
      models: Object.fromEntries(BAND_ORDER.map((b) => [b, String(m[b] || '').trim().slice(0, 200)])),
    },
    bands: Array.isArray(r.bands) ? bands : [...DEFAULT_OFFLOAD.bands],
    classifier: r.classifier === true,
    maxInputTokens: int(r.maxInputTokens, 100, 200_000, DEFAULT_OFFLOAD.maxInputTokens),
    maxInFlight: int(r.maxInFlight, 1, 16, DEFAULT_OFFLOAD.maxInFlight),
    timeoutMs: int(r.timeoutMs, 1000, 120_000, DEFAULT_OFFLOAD.timeoutMs),
  };
}

/**
 * The band the CALLER asked for. An intercepted agent declares no band, but its
 * request says a lot: an explicit reasoning effort, else the tier of the model it
 * picked for this call (agents choose a mini/haiku model for titles and side
 * calls themselves — that choice IS the caller's band).
 */
export function callerBand(wire, body) {
  const effort = String((wire === 'responses' ? body?.reasoning?.effort : body?.reasoning_effort) || '').toLowerCase();
  if (effort === 'minimal' || effort === 'low' || effort === 'none') return { band: 'small', source: 'caller' };
  if (effort === 'medium') return { band: 'medium', source: 'caller' };
  if (effort === 'high' || effort === 'xhigh') return { band: 'high', source: 'caller' };
  const model = String(body?.model || '').toLowerCase();
  if (/(^|[-_./])(mini|nano|haiku|flash|lite|small|tiny)([-_.]|$)/.test(model)) return { band: 'small', source: 'model' };
  if (/(^|[-_./])(opus|pro|max|ultra)([-_.]|$)|^o[13]$/.test(model)) return { band: 'high', source: 'model' };
  return { band: 'medium', source: 'model' };
}

/** ~4 characters per token over the JSON the target would receive. */
export function estimateInputTokens(body) {
  try { return Math.ceil(JSON.stringify({ m: body?.messages, t: body?.tools }).length / 4); } catch { return Infinity; }
}

/**
 * Reachability of the target, probed in the background so a dead endpoint
 * costs no call a timeout. Unreachable = out of every decision.
 */
export function createTargetHealth({ fetch, getConfig, getKey = () => '', intervalMs = 60_000, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
  const state = { url: '', reachable: false, checkedAt: 0, latencyMs: 0, models: [], error: 'not checked yet' };
  let timer = null;
  async function probe() {
    const cfg = getConfig();
    const url = cfg.target.url;
    if (!url) {
      Object.assign(state, { url: '', reachable: false, checkedAt: now(), latencyMs: 0, models: [], error: 'no endpoint configured' });
      return state;
    }
    const t0 = now();
    try {
      const key = getKey();
      const r = await fetch(`${url}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? `HTTP ${r.status} — key missing or rejected` : `HTTP ${r.status}`);
      const j = await r.json().catch(() => ({}));
      const models = Array.isArray(j?.data) ? j.data.map((d) => String(d?.id || '')).filter(Boolean) : [];
      Object.assign(state, { url, reachable: true, checkedAt: now(), latencyMs: now() - t0, models, error: '' });
    } catch (err) {
      Object.assign(state, { url, reachable: false, checkedAt: now(), latencyMs: now() - t0, models: [], error: String(err?.message || err).slice(0, 200) });
    }
    return state;
  }
  return {
    state,
    probe,
    start() { if (!timer) { timer = setTimer(() => { probe().catch(() => {}); }, intervalMs); timer?.unref?.(); } probe().catch(() => {}); },
    stop() { if (timer) clearTimer(timer); timer = null; },
    /** Reachable for THIS config's endpoint (a just-edited URL is unknown until probed). */
    usable(cfg) { return state.reachable && state.url === cfg.target.url; },
  };
}

/** Stage-2 classifier on the target itself: the same rubric coding's proxy sends. */
export function targetVerdictFn({ fetch, cfg, key, timeoutMs = 4000 }) {
  const model = cfg.target.models.small;
  if (!model) return null;
  return async (text) => {
    const r = await fetch(`${cfg.target.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: CLASSIFIER_RUBRIC }, { role: 'user', content: text }],
        max_tokens: 3,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`classifier HTTP ${r.status}`);
    const j = await r.json();
    return j?.choices?.[0]?.message?.content || '';
  };
}

/**
 * The offloader one daemon holds. getConfig() is read per call, so a change made
 * in the UI applies to the next call with no restart.
 *
 * ── A turn is decided once ───────────────────────────────────────────────────
 * The band is judged at a turn's FIRST call, from the human's words, and held
 * in `turnBands` (turn-band.mjs) for the rest of the turn. A call inside the
 * tool loop never re-judges: if the first call was offloaded, the loop call
 * inherits its band (bandSource 'turn') and stays on the target, where the
 * conversation's KV cache already is; if the first call stayed on the provider,
 * so does the loop. Every later gate — band, model, size, in-flight — still
 * applies to the loop call, because those are facts about THIS call.
 *
 * Before this, every loop call was kept with `turn carries tool results`, so an
 * offloaded turn moved to the cloud at its first tool result, after the target
 * had paid the full prefill for it.
 *
 * ── A session is promoted once ───────────────────────────────────────────────
 * The same holds one level up, in `sessionBands`: once a session has had a turn
 * at an offloaded band, a later turn judged above it promotes the session, and
 * every turn after that stays on the provider without being judged (band
 * source 'session'). The session stops alternating between two caches.
 */
export function createOffloader({
  fetch, getConfig, getKey = () => '', health, now = Date.now,
  turnBands = createTurnBandMemory({ now }),
  sessionBands = createTurnBandMemory({ now, ttlMs: 2 * 60 * 60_000 }),
}) {
  let inFlight = 0;
  const counters = { offloaded: 0, fellBack: 0, classified: 0, downgraded: 0, inherited: 0, promoted: 0 };

  /**
   * @returns {Promise<{offload: boolean, reason: string, band: string, bandSource: string, model?: string, classifier?: string, estTokens?: number}>}
   */
  async function decide({ agent, wire, body }) {
    const cfg = normalizeOffloadConfig(getConfig());
    const keep = (reason, extra = {}) => ({ offload: false, reason, band: '', bandSource: '', ...extra });
    if (!cfg.enabled) return keep('offload off');
    if (!OFFLOAD_AGENTS.includes(agent)) return keep(`${agent || 'this agent'} is not offloadable`);
    if (!cfg.agents[agent]) return keep(`offload off for ${agent}`);
    if (!cfg.target.url) return keep('no endpoint configured');
    if (wire !== 'chat') return keep('Responses API call — only chat/completions is offloaded');
    if (!body || !Array.isArray(body.messages)) return keep('request not readable');

    // The turn's first call records what it got, offloaded or kept, so its loop
    // calls can follow it. A loop call records nothing: it did not decide.
    const turnKey = turnBandKey(body.messages, agent);
    const inLoop = toolsInCurrentTurn(body.messages);
    const finish = (result) => {
      if (!inLoop) {
        turnBands.remember(turnKey, {
          offloaded: result.offload, band: result.band, bandSource: result.bandSource, reason: result.reason,
        });
      }
      return { ...result, turnKey };
    };

    if (!health.usable(cfg)) return finish(keep(`${cfg.target.name} not reachable`));

    // A turn's first call in a promoted session is not judged at all.
    const { sessionKey, turn: turnIndex } = inLoop ? { sessionKey: '', turn: 0 } : sessionTurn(body.messages, agent);
    const session = sessionKey ? sessionBands.recall(sessionKey) : undefined;
    const promoted = sessionVerdict(session, turnIndex);
    if (promoted) {
      return finish(keep(`session promoted to the provider at turn ${promoted.since} (band ${promoted.band})`, {
        band: promoted.band, bandSource: 'session',
      }));
    }

    let turn = null;
    if (inLoop) {
      turn = turnBands.recall(turnKey);
      if (!turn) return finish(keep('turn carries tool results — its first call was not seen'));
      if (!turn.offloaded) return finish(keep(`turn carries tool results — its first call stayed on the provider (${turn.reason || 'kept'})`));
    }

    const declared = callerBand(wire, body);
    let { band } = declared;
    let bandSource = declared.source;
    let classifier = '';
    if (turn) {
      // Inside the loop of an offloaded turn: its first call's band, unjudged.
      band = turn.band;
      bandSource = 'turn';
      counters.inherited += 1;
    } else if (cfg.classifier) {
      counters.classified += 1;
      const verdict = await classifyRequest({
        enabled: true,
        bandSource: 'caller',
        declaredBand: band,
        messages: body.messages,
        allowedBands: cfg.bands.length ? cfg.bands : ['small'],
        verdictFn: targetVerdictFn({ fetch, cfg, key: getKey() }),
      });
      classifier = verdict.detail;
      if (verdict.changed) { band = verdict.band; bandSource = 'classifier'; counters.downgraded += 1; }
    }
    const decided = { band, bandSource, classifier };
    if (sessionKey) {
      const next = nextSessionRecord(session, { turn: turnIndex, band, offloadable: cfg.bands.includes(band) });
      if (next) {
        if (next.promoted) counters.promoted += 1;
        sessionBands.remember(sessionKey, next);
      }
    }
    if (!cfg.bands.includes(band)) return finish(keep(`band ${band} not offloaded`, decided));
    const model = cfg.target.models[band];
    if (!model) return finish(keep(`no ${cfg.target.name} model chosen for ${band}`, decided));
    const estTokens = estimateInputTokens(body);
    if (estTokens > cfg.maxInputTokens) return finish(keep(`~${estTokens} input tokens > ${cfg.maxInputTokens}`, { ...decided, estTokens }));
    if (inFlight >= cfg.maxInFlight) return finish(keep(`${cfg.target.name} busy (${inFlight} in flight)`, { ...decided, estTokens }));
    return finish({ offload: true, reason: '', ...decided, model, estTokens });
  }

  /**
   * Try the target. Resolves {served: true} once the answer is streaming to the
   * client, or {served: false, error, ms} with nothing written to `res` — the
   * caller then forwards the held original.
   *
   * The budget covers headers AND the first body chunk: the target may send
   * headers at once and the answer only when it is complete, and "before the
   * first byte reaches the agent" is the last moment a fallback is invisible.
   */
  async function serve({ res, body, decision, onChunk, onBody }) {
    const cfg = normalizeOffloadConfig(getConfig());
    const key = getKey();
    const t0 = now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(`no answer within ${cfg.timeoutMs} ms`)), cfg.timeoutMs);
    inFlight += 1;
    let reader = null;
    try {
      const out = { ...body, model: decision.model };
      if (out.stream === true) out.stream_options = { ...(out.stream_options || {}), include_usage: true };
      const r = await fetch(`${cfg.target.url}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: out.stream === true ? 'text/event-stream' : 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(out),
        signal: ctl.signal,
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`);
      }
      const isSse = (r.headers.get('content-type') || '').includes('text/event-stream');
      if (!isSse) {
        const buf = Buffer.from(await r.arrayBuffer());
        clearTimeout(timer);
        res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'application/json' });
        res.end(buf);
        onBody(buf);
        counters.offloaded += 1;
        return { served: true, isSse: false, ms: now() - t0 };
      }
      reader = r.body.getReader();
      const first = await reader.read();
      clearTimeout(timer);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      counters.offloaded += 1;
      // From here on the agent has bytes: an error is the agent's to see, never a retry.
      if (!first.done) { res.write(Buffer.from(first.value)); onChunk(first.value); }
      try {
        for (let c = first; !c.done;) {
          c = await reader.read();
          if (c.done) break;
          res.write(Buffer.from(c.value));
          onChunk(c.value);
        }
      } finally {
        res.end();
      }
      return { served: true, isSse: true, ms: now() - t0 };
    } catch (err) {
      clearTimeout(timer);
      try { reader?.cancel(); } catch { /* already closed */ }
      counters.fellBack += 1;
      const msg = ctl.signal.aborted ? String(ctl.signal.reason?.message || 'timeout') : String(err?.message || err);
      // The call is going to the provider after all, so the rest of the turn
      // follows it there rather than retrying a target that just failed and
      // splitting the loop across two caches.
      if (decision.turnKey) {
        turnBands.remember(decision.turnKey, {
          offloaded: false, band: decision.band, bandSource: decision.bandSource,
          reason: `${cfg.target.name} failed: ${msg.slice(0, 120)}`,
        });
      }
      return { served: false, error: msg.slice(0, 200), ms: now() - t0 };
    } finally {
      inFlight -= 1;
    }
  }

  return { decide, serve, counters, turnBands, sessionBands, inFlight: () => inFlight };
}

/** The routing columns for a call that went through decide(). */
export function offloadRowFields({ agent, cfg, decision, outcome, fromProvider }) {
  const target = targetProviderId(cfg.target.name);
  if (decision.offload && outcome?.served) {
    return {
      provider: target,
      route_key: `fg-chat/${agent}`, route_band: decision.band, band_source: decision.bandSource,
      offloaded_from: fromProvider, attempt_trail: '',
    };
  }
  const trail = decision.offload
    ? serializeRoutingTrail({ attempts: [{ provider: target, model: decision.model, error: outcome?.error || 'failed', ms: outcome?.ms }] })
    : serializeRoutingTrail({ offloadSkipped: decision.reason, classifier: decision.classifier || '' });
  return {
    route_key: `fg-chat/${agent}`, route_band: decision.band || '', band_source: decision.bandSource || '',
    offloaded_from: '', attempt_trail: trail,
  };
}
