// proxy-bridge/measurement.mjs
//
// The measurement half of the daemon: which run a request belongs to (task
// binding, per endpoint), what it cost (usage read off the Anthropic wire), and
// what gets written for it — the token_usage row of the /v1/messages tap, the
// per-run context-breakdown snapshot, the context-turns line and the opt-in
// redacted raw bodies — plus the two reads the dashboard polls.
//
// server.mjs keeps routing and forwarding and calls in here. Kept out of it
// because server.mjs listens on import: anything that lives there can be
// neither unit-tested nor reused by a daemon that measures without routing.
//
// Two layers:
//   - pure exports (task-id sanitising, binding rules, user_hash stamping, the
//     usage accumulator) that read nothing but the active span files;
//   - createMeasurement({ dataDir, … }) for everything keyed to a data dir and
//     holding state across requests (the keep-largest map, the live-latest
//     throttle).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { logCall as logTokenCall } from '../dist/token-usage.js';
import { resolveLiveTaskId, resolveAgentSpanTaskId, getActiveMeasurement, sanitizeTaskId } from '../dist/measurement-span.js';
import { parseUsageCache, parseOpenAICache, openAIFreshInputTokens, parseResponsesUsage } from '../dist/usage-cache.js';
import { isBackgroundProcess } from '../dist/background-process.js';
import { buildAnthropicLine, buildOpenAILine } from './context-turns.mjs';
import { turnIdentity, turnPromptText } from './turn-identity.mjs';
import { appendRawBody, rawBodyCaptureEnabled } from './raw-bodies.mjs';
import { resolveShimTaskId } from './shim-tools.mjs';
import { captureBelongsToRun, analyzeAnthropicRequest, analyzeOpenAIRequest } from './context-capture.mjs';

// D-07/D-10 (Phase 83-01): guarded, idempotent wrapper around the canonical
// sanitizeTaskId validator. sanitizeTaskId THROWS on empty input,
// illegal chars, >200 chars, or a '.'|'..' basename — which crashes the daemon if
// it reaches the async request handler unguarded (CR-01). This wrapper returns ''
// on empty OR on a throw, so the SAME sanitized form can key the DB task_id, the
// _ctxMaxByTask map, AND the breakdown filename (perRunBreakdownPath) without any
// seam re-throwing. It WRAPS sanitizeTaskId — it never replaces the single validator.
export function safeSanitizeTaskId(rawId) {
  if (!rawId) return '';
  try { return sanitizeTaskId(rawId); }
  catch { return ''; }
}

// Phase 82-02 (WIRE-03): map an agent name to a distinct 6-char adapter
// user_hash matching /^[a-z][a-z0-9]{5}$/ (token-db.mjs:38-43 contract) so the
// tap can stamp non-claude rows without colliding with cladpt. Known agents use
// the established literals (claude→cladpt, copilot→copadt); any other agent
// derives a valid 6-char code (first char forced alpha, padded/truncated to 6).
export function adapterUserHash(agent) {
  const known = { claude: 'cladpt', copilot: 'copadt', opencode: 'opcadt', mastra: 'mstadt', pi: 'piadpt' };
  if (known[agent]) return known[agent];
  let s = String(agent || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!/^[a-z]/.test(s)) s = `x${s}`;        // ensure first char is a letter
  return `${s}xxxxxx`.slice(0, 6);            // pad + truncate to exactly 6 chars
}

// ── Task binding, one rule per endpoint ──────────────────────────────────────

/**
 * task_id for a /v1/messages tap request.
 *
 * Phase 82-02 (WIRE-03): per-request task+agent binding. The x-task-id /
 * x-agent request headers WIN over the ambient span, killing the singleton
 * leak where concurrent spans (interactive + N experiment cells) cross-
 * contaminate (v9 opencode rows tainted with observation-writer/health-
 * coordinator calls). Mirrors the OpenAI-shim precedence (bindShimTaskId).
 * Empty header → NO ambient inheritance (D-08/WR-01): a header-less
 * (interactive) tap request is stamped NEUTRAL (task_id='') rather than adopting
 * whatever measured cell span happens to be live, so interactive foreground
 * tokens cannot attribute themselves to a concurrent cell. Only an explicit
 * x-task-id header binds a measured cell (a malformed header still falls back to
 * the ambient span via the D-07 catch below).
 *
 * sanitizeTaskId (charset whitelist + path.basename) neutralizes traversal /
 * injection from the untrusted header before it reaches DB/filenames.
 * D-07 (CR-01): the original one-liner called sanitizeTaskId UNGUARDED — a
 * malformed x-task-id (illegal char / >200 chars / '.'|'..') throws out of the
 * async handler and crashes the daemon. Wrap it (mirrors the shim try/catch):
 * on throw, fall back to the ambient live span, sanitized ONCE so every
 * downstream seam (DB task_id, _ctxMaxByTask key, breakdown filename) keys on ONE
 * form (D-10). sanitizeTaskId stays the single validator.
 *
 * @param {{ hdrTaskId: string, agent: string, logErr?: (msg: string) => void }} p
 * @returns {string} sanitized task_id, '' for a neutral row
 */
export function bindTapTaskId({ hdrTaskId, agent, logErr = () => {} }) {
  if (hdrTaskId) {
    try { return sanitizeTaskId(hdrTaskId); }
    catch (err) {
      logErr(`/v1/messages x-task-id rejected (${err?.message || err}); falling back to ambient span`);
      return safeSanitizeTaskId(resolveLiveTaskId(undefined, agent));
    }
  }
  // WR-01-no-inherit (D-08): a header-less interactive /v1/messages tap request
  // must NOT adopt the currently-live GLOBAL measured cell span — that ambient
  // inheritance is the singleton leak Phase 82-06 closed for /api/complete but
  // left open on the tap. Plan B (Option B): bind ONLY to this agent's OWN
  // per-agent auto-measurement span (active-measurement.<agent>.json) — never the
  // global span, never another agent's span. This lets an always-on per-agent
  // span capture the interactive foreground buffer without reintroducing the
  // concurrent-cell cross-contamination D-08 forbids. When no per-agent span is
  // live, resolveAgentSpanTaskId returns '' → the row stays neutral (unchanged
  // legacy behavior). Only an explicit x-task-id header binds a measured cell.
  return safeSanitizeTaskId(resolveAgentSpanTaskId(agent));
}

/**
 * Phase 84-06 (D-05): read the per-span raw-body capture flag ONCE for a
 * measured tap request (default OFF). Only a measured row (non-empty taskId)
 * whose active span carries meta.capture_raw_bodies === true accumulates +
 * persists raw bodies; getActiveMeasurement is the single-reader (no second parser).
 */
export function tapCapturesRawBodies(taskId) {
  return !!taskId && rawBodyCaptureEnabled(getActiveMeasurement());
}

/**
 * A task id carried in a shim URL path segment (/t/<taskId>/…).
 *
 * sanitizeTaskId (charset whitelist + path.basename) neutralizes any
 * traversal/injection in the untrusted path segment before it reaches
 * the DB / per-run snapshot filenames (T-82-03-03 mitigation).
 */
export function pathTaskId(raw) {
  try { return sanitizeTaskId(decodeURIComponent(raw)); }
  catch { return sanitizeTaskId(raw); }
}

/**
 * task_id for an OpenAI-shim request (opencode / copilot / mastra / pi, and the
 * responses shim).
 *
 * Precedence: X-Task-Id header > body.task_id > path-scoped /t/<taskId> >
 * ambient span (resolved downstream as `taskId || resolveLiveTaskId()`).
 * D-10 (WR-06): resolveShimTaskId returns the header/body id RAW (only the path
 * segment was pre-sanitized), so it reached the DB row and the
 * _ctxMaxByTask key unsanitized while perRunBreakdownPath sanitized the filename —
 * the same logical id keyed three different ways, breaking the DB↔breakdown-file
 * join. Sanitize the resolved id ONCE here (safeSanitizeTaskId wraps the canonical
 * validator, '' on empty/illegal) so all three seams key on ONE form.
 */
export function bindShimTaskId({ hdrTaskId, bodyTaskId, pathTaskId: fromPath }) {
  return safeSanitizeTaskId(resolveShimTaskId(hdrTaskId, bodyTaskId, fromPath));
}

/**
 * task_id for an /api/complete row (the shim lands here too, carrying its bound
 * id as body.task_id).
 *
 * Resolved ONCE per completion (Phase 84-04: the context-turn write REUSES this
 * value — it must not call resolveLiveTaskId() afresh, which would double-count
 * the single-reader span access and re-open the ambient-span leak this
 * precedence closes).
 *
 * TELEM-03 (Plan 68-03) + Phase 70-01 (D-04/D-05): a client-supplied
 * body.task_id (e.g. from the shim's X-Task-Id header) wins when present;
 * otherwise resolveLiveTaskId() stamps the active measurement span's task_id (or
 * '' when no span / on any read error). resolveLiveTaskId is the single-reader
 * rule and never throws.
 *
 * SPAN-LEAKAGE GUARD II (Phase 82-06 / WIRE-03): a coding-side
 * BACKGROUND DAEMON (health-coordinator, the consolidator family,
 * observation-writer, token-adapter-*, wave-analysis-*) fires on its
 * OWN cadence and is never part of a measured cell — but during an
 * experiment the ambient span IS a cell's task_id, so letting these
 * daemons fall through to resolveLiveTaskId() stamps their unrelated
 * tokens with the cell's task_id (the v9 regression this phase's gate
 * must not reproduce). A cell's own agent calls always carry an
 * EXPLICIT body.task_id (experiment-runner x-task-id / shim /t/<id>),
 * so denying the ambient fallback to a daemon process can never
 * unbind a legitimate cell row — it stays '' (unattributed), matching
 * the no-span DEFAULT. Process identity (body.process, set
 * client-side by each daemon) is the discriminator.
 */
export function bindCompleteTaskId(body, procName) {
  return typeof body.task_id === 'string' && body.task_id
    ? body.task_id
    : (isBackgroundProcess(procName)
        ? ''
        : resolveLiveTaskId(undefined, typeof body.agent === 'string' ? body.agent : undefined));
}

// ── Usage off the Anthropic wire ─────────────────────────────────────────────

/**
 * Accumulates the usage of one /v1/messages response as it passes through.
 *
 * input_tokens/output_tokens mirror the transcript adapter's semantics
 * (non-cache input + final output) so Route 1 and Route 2 totals match.
 * Phase 82-02 (WIRE-02): cacheRead/cacheWrite are captured off the SAME usage
 * object and surfaced SEPARATELY — never folded into total_tokens.
 *
 * Feed it every SSE chunk (sseChunk) or the one buffered body (jsonBody). With
 * captureRaw it also keeps the raw response text for the raw-body capture.
 */
export function createAnthropicUsageTap({ captureRaw = false } = {}) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sawUsage: false, rawResponse: '' };
  const decoder = new TextDecoder();
  let sseBuf = '';
  return {
    usage: u,
    sseChunk(value) {
      const _chunk = decoder.decode(value, { stream: true });
      sseBuf += _chunk;
      if (captureRaw) u.rawResponse += _chunk; // Phase 84-06: raw-body accumulation (flag-gated)
      let idx;
      while ((idx = sseBuf.indexOf('\n\n')) !== -1) {
        const evt = sseBuf.slice(0, idx); sseBuf = sseBuf.slice(idx + 2);
        const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        try {
          const d = JSON.parse(dataLine.slice(5).trim());
          if (d.type === 'message_start' && d.message && d.message.usage) {
            u.input = d.message.usage.input_tokens ?? u.input;
            u.output = d.message.usage.output_tokens ?? u.output;
            // Cache usage rides on message_start.usage only (the delta path
            // carries no cache fields). Both flat + cache_creation-object forms.
            const c = parseUsageCache(d.message.usage);
            u.cacheRead = c.cacheRead; u.cacheWrite = c.cacheWrite;
            u.sawUsage = true;
          } else if (d.type === 'message_delta' && d.usage) {
            // message_delta.usage.output_tokens is the CUMULATIVE final count.
            if (typeof d.usage.output_tokens === 'number') u.output = d.usage.output_tokens;
            u.sawUsage = true;
          }
        } catch { /* partial/non-JSON data line — skip */ }
      }
    },
    // Non-streaming (or an error response): the whole buffered body.
    jsonBody(buf) {
      if (captureRaw) u.rawResponse = buf.toString('utf8'); // Phase 84-06: raw-body capture (flag-gated)
      try {
        const j = JSON.parse(buf.toString('utf8'));
        if (j && j.usage) {
          u.input = j.usage.input_tokens ?? 0;
          u.output = j.usage.output_tokens ?? 0;
          const c = parseUsageCache(j.usage);
          u.cacheRead = c.cacheRead; u.cacheWrite = c.cacheWrite;
          u.sawUsage = true;
        }
      } catch { /* not JSON — no usage to tap */ }
    },
  };
}

/**
 * Read usage off an OpenAI-wire response as it streams past — the counterpart of
 * createAnthropicUsageTap for the measuring passthrough. `wire` is 'chat'
 * (chat/completions: usage on the last chunk that carries one — the request must
 * ask for it with stream_options.include_usage) or 'responses' (Responses API:
 * usage on the `response.completed` event's `response`).
 *
 * input is FRESH input on both wires (openAIFreshInputTokens / parseResponsesUsage
 * subtract cached tokens), so a row means the same as a /v1/messages row.
 */
export function createOpenAIUsageTap({ wire = 'chat', captureRaw = false } = {}) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sawUsage: false, model: '', rawResponse: '' };
  const decoder = new TextDecoder();
  let sseBuf = '';
  const take = (usage, model) => {
    if (!usage || typeof usage !== 'object') return;
    if (wire === 'responses') {
      const r = parseResponsesUsage(usage);
      u.input = r.input; u.output = r.output; u.cacheRead = r.cache_read_tokens;
    } else {
      u.input = openAIFreshInputTokens(usage);
      u.output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
      u.cacheRead = parseOpenAICache(usage).cache_read_tokens;
    }
    u.cacheWrite = 0;
    if (typeof model === 'string' && model) u.model = model;
    u.sawUsage = true;
  };
  const event = (d) => {
    if (wire === 'responses') {
      if (d && d.type === 'response.completed' && d.response) take(d.response.usage, d.response.model);
      else if (d && d.response && typeof d.response.model === 'string' && !u.model) u.model = d.response.model;
      return;
    }
    if (d && typeof d.model === 'string' && d.model && !u.model) u.model = d.model;
    if (d && d.usage) take(d.usage, d.model);
  };
  return {
    usage: u,
    sseChunk(value) {
      const chunk = decoder.decode(value, { stream: true });
      sseBuf += chunk;
      if (captureRaw) u.rawResponse += chunk;
      let idx;
      while ((idx = sseBuf.search(/\r?\n\r?\n/)) !== -1) {
        const evt = sseBuf.slice(0, idx);
        sseBuf = sseBuf.slice(idx).replace(/^\r?\n\r?\n/, '');
        const data = evt.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data || data === '[DONE]') continue;
        try { event(JSON.parse(data)); } catch { /* partial/non-JSON data line — skip */ }
      }
    },
    jsonBody(buf) {
      if (captureRaw) u.rawResponse = buf.toString('utf8');
      try {
        const j = JSON.parse(buf.toString('utf8'));
        if (j && j.usage) take(j.usage, j.model);
      } catch { /* not JSON — no usage to tap */ }
    },
  };
}

// ── Everything keyed to a data dir ───────────────────────────────────────────

/**
 * @param {object} deps
 * @param {string} deps.dataDir   the daemon's data root (LLM_PROXY_DATA_DIR)
 * @param {() => object|null} deps.tokenDb  the open token DB handle, or null when
 *   persistence is unavailable (read per call — it is opened after boot)
 * @param {(text: string) => string} deps.redactRawBody  the compiled redaction set
 * @param {(raw: string) => string} deps.canonicalModel  upstream model spelling → canonical
 * @param {(msg: string) => void} deps.log
 * @param {(msg: string) => void} deps.logErr
 */
export function createMeasurement({ dataDir, tokenDb, redactRawBody, canonicalModel, log, logErr }) {
  // ── Context-window breakdown tap (Phase 78) ─────────────────────────────────
  // The snapshot the dashboard reads shows the ACTUAL wire buffer this session
  // sent — not an illustrative guess (see context-capture.mjs).
  const CTX_BREAKDOWN_DIR = path.join(dataDir, 'llm-proxy');
  const CTX_BREAKDOWN_PATH = path.join(CTX_BREAKDOWN_DIR, 'context-breakdown.json');
  // Per-run snapshot path, keyed by the (sanitised) measurement task_id so each
  // measured run retains its OWN captured buffer (agent-correct — a claude run and
  // an opencode run of the same comparison each get their own file).
  const perRunBreakdownPath = (taskId) =>
    path.join(CTX_BREAKDOWN_DIR, 'context-breakdown', `${sanitizeTaskId(taskId)}.json`);
  // Phase 84-04 (D-04): per-request context-turns JSONL lives CO-LOCATED with the
  // span's reconciliation.json under <DATA_DIR>/measurements/<sanitized>/, NOT under
  // llm-proxy/. It must hang off DATA_DIR, not CODING_ROOT: the span archive is
  // `<LLM_PROXY_DATA_DIR>/measurements/<id>.json`, so deriving this one from the repo
  // splits a run's capture from its own span — the write lands in the tools repo, the
  // span-close gzip looks in the data home and finds nothing, and /api/context-turns
  // reads a third place. Every one of those failures is silent and reads as "no data".
  // Reuse safeSanitizeTaskId so an empty/traversal id yields '' → the caller skips the
  // write rather than escaping the measurements root.
  const contextTurnsDir = (taskId) => {
    const safe = safeSanitizeTaskId(taskId);
    return safe ? path.join(dataDir, 'measurements', safe) : '';
  };
  // Phase 84-04 (D-03 append half): best-effort, never-throw append of ONE
  // context-turns JSONL line during the span (plaintext; gzip happens at span
  // close in Plan 05). A falsy dir (empty/traversal task_id) is skipped so nothing
  // lands at the measurements root. Async fire-and-forget so it never blocks the
  // request hot path; a failure only reaches stderr.
  //
  // Context captures carry previews of the system prompt, tool descriptions and
  // every message — whatever the user pasted. Every string in them goes through
  // the same redaction set as raw bodies before it is written (glass G6: a key
  // pasted into a prompt was stored verbatim in both capture files).
  const redactStrings = (v) => (typeof v === 'string' ? redactRawBody(v)
    : Array.isArray(v) ? v.map(redactStrings)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactStrings(x)]))
        : v);
  function logContextTurn(dir, line) {
    try {
      if (!dir) return;
      const text = JSON.stringify(redactStrings(line)) + '\n';
      fs.mkdir(dir, { recursive: true }, () => {
        fs.appendFile(path.join(dir, 'context-turns.jsonl'), text, () => {});
      });
    } catch (err) {
      logErr(`context-turn write failed (non-fatal): ${err?.message || err}`);
    }
  }
  let _lastCtxBreakdownAt = 0;
  // In-memory max total_bytes seen per task_id → we persist the LARGEST turn's
  // buffer (the fullest context) rather than whichever request happened last.
  const _ctxMaxByTask = new Map();

  function keepLargest(taskId, snapshot) {
    if (snapshot.total_bytes > (_ctxMaxByTask.get(taskId) || 0)) {
      _ctxMaxByTask.set(taskId, snapshot.total_bytes);
      const p = perRunBreakdownPath(taskId);
      const text = JSON.stringify(redactStrings(snapshot), null, 2);
      fs.mkdir(path.dirname(p), { recursive: true }, () => {
        fs.writeFile(p, text, () => {});
      });
    }
  }

  // First user message → short preview for the dashboard's at-a-glance column.
  // Strips whitespace, truncates at 120 chars, no PII normalization (the proxy
  // trusts caller-provided messages, same as the completion bodies).
  // The ≤120-char label on a token_usage row: what was asked in THIS turn,
  // redacted.
  //
  // ── Three things this used to get wrong ─────────────────────────────────────
  //  1. It took the FIRST user message, so every turn of a session was captioned
  //     with the session's opening prompt — turn 7 labelled with turn 1's
  //     question. turnPromptText() takes the current turn's instead. Identical
  //     for a background service, whose request is [system, user] and never has a
  //     second turn, so this is a no-op for the overwhelming majority of rows.
  //  2. It read `content` only when it was a string, which on the Anthropic wire
  //     it usually is not — content there is an array of typed blocks. That is
  //     why the /v1/messages tap could not have produced a preview even if it had
  //     asked for one. turnPromptText() flattens both wires, and skips a
  //     role:'user' message carrying a tool_result, which on that wire is how a
  //     tool reply arrives.
  //  3. It stored the text verbatim. That was tolerable while the only callers
  //     were background services sending their own generated prompts; it is not
  //     once foreground conversation is captured. Every preview now goes through
  //     the SAME 27-pattern redaction set as raw-body capture, from the coding
  //     repo's single source of truth.
  //
  // Redact BEFORE truncating: a secret straddling the 120-char display boundary
  // would otherwise be half-stored, past the point any pattern could match it.
  // The input is bounded first (turnPromptText caps at 500) so the regex set
  // never runs on an unbounded string — it has wedged a process that way before.
  function promptPreview(messages) {
    const redacted = redactRawBody(turnPromptText(messages)).replace(/\s+/g, ' ').trim();
    return redacted.length > 120 ? redacted.slice(0, 117) + '...' : redacted;
  }

  // The context-turns line and (opt-in) raw bodies of one OpenAI-wire call —
  // shared by /api/complete (recordCompletionCapture) and the measuring
  // passthrough (recordOpenAITap).
  function writeOpenAICapture({ label, body, taskId, agent, requestId, model, usage, captureRaw, rawResponse }) {
    // Phase 84-04 call-site B (OpenAI wire): append ONE context-turns line
    // for this measured request. Own try/catch (best-effort, never blocks
    // serving); skip neutral/interactive rows (empty task_id); REUSE the
    // already-resolved task_id (no fresh resolveLiveTaskId). cache_write is
    // emitted null → UI renders N/A (D-12). Categories recomputed from the
    // request body (OpenAI shape) — analyzeOpenAIRequest is pure/never-throw.
    if (taskId) {
      try {
        logContextTurn(contextTurnsDir(taskId), buildOpenAILine({
          internalBody: body,
          taskId,
          agent,
          requestId,
          model,
          usage,
          categories: analyzeOpenAIRequest(body).categories,
        }));
      } catch (err) {
        logErr(`${label} context-turn build failed (non-fatal): ${err?.message || err}`);
      }
    }

    // Phase 84-06 call-site B (OpenAI wire): flag-gated FULL raw-body capture.
    // Default OFF; only when the span opted in. Request body + response are
    // redacted via the shared 27-pattern set BEFORE the line is built
    // (redaction always pre-write), then appended to the SEPARATE
    // raw-bodies.jsonl sibling. Own best-effort try/catch → never blocks serving.
    if (taskId && captureRaw) {
      try {
        appendRawBody(contextTurnsDir(taskId), {
          ts: new Date().toISOString(),
          task_id: taskId,
          request_id: requestId,
          wire: 'openai',
          request: redactRawBody(JSON.stringify(body)),
          response: redactRawBody(rawResponse()),
        });
      } catch (err) {
        logErr(`${label} raw-body write failed (non-fatal): ${err?.message || err}`);
      }
    }
  }

  return {
    promptPreview,

    /**
     * Phase 78: snapshot the REAL per-category size of the context window of a
     * /v1/messages completion. Two writes, both non-fatal (a capture failure must
     * never touch forwarding):
     *   1. GLOBAL live-latest (throttled, main only) — the current session's
     *      buffer, used when no run is selected.
     *   2. PER-RUN (when a measurement is active) — keyed by task_id, keeping the
     *      LARGEST context seen for that run. This is agent-correct: a measured
     *      claude run and a measured opencode run each persist their OWN buffer,
     *      so the dashboard shows real sizes per agent (D-78 per-run choice).
     *      NOT gated on isSubagent — opencode's toolset has no Agent/Task tool so
     *      it would be mis-flagged; the max-bytes rule picks its fullest request.
     */
    captureAnthropicBreakdown({ reqJson, model, taskId, isSubagent }) {
      try {
        const snapshot = {
          capturedAt: new Date().toISOString(),
          model,
          task_id: taskId || null,
          ...analyzeAnthropicRequest(reqJson),
        };
        if (!isSubagent && Date.now() - _lastCtxBreakdownAt > 8000) {
          _lastCtxBreakdownAt = Date.now();
          const text = JSON.stringify(redactStrings(snapshot), null, 2);
          fs.mkdir(CTX_BREAKDOWN_DIR, { recursive: true }, () => {
            fs.writeFile(CTX_BREAKDOWN_PATH, text, () => {});
          });
        }
        if (taskId && captureBelongsToRun(taskId, model, 'anthropic')) keepLargest(taskId, snapshot);
      } catch (err) {
        logErr(`context-breakdown capture failed (non-fatal): ${err?.message || err}`);
      }
    },

    /**
     * Phase 78: per-run context-window capture for the OpenAI-shim path
     * (opencode/mastra). Same per-run persistence as the /v1/messages tap so a
     * measured opencode run records its OWN real, agent-correct buffer. Resolve
     * the effective task_id the same way the pipeline will (explicit → active
     * span). Non-fatal by contract.
     */
    captureOpenAIBreakdown({ oaBody, agent, taskId }) {
      try {
        const effTaskId = taskId || safeSanitizeTaskId(resolveLiveTaskId(undefined, agent)); // D-10: ambient fallback sanitized to the same form; Option B: per-agent span precedence
        const effModel = canonicalModel(oaBody.model) || oaBody.model || 'unknown';
        if (effTaskId && captureBelongsToRun(effTaskId, effModel, 'openai')) {
          keepLargest(effTaskId, {
            capturedAt: new Date().toISOString(),
            model: effModel,
            task_id: effTaskId,
            ...analyzeOpenAIRequest(oaBody),
          });
        }
      } catch (err) {
        logErr(`context-breakdown (openai-shim) capture failed (non-fatal): ${err?.message || err}`);
      }
    },

    /**
     * Write what the /v1/messages tap measured for one completion: the
     * token_usage row, its context-turns line, and (opt-in) the redacted raw
     * bodies. Only genuine completions with real usage — the caller excludes
     * count_tokens. A no-op without a token DB, like the row itself.
     */
    recordAnthropicTap({ route, model, reqJson, proc, agent, project, requestId, taskId, usage, latencyMs, captureRaw, provider = '', subscription = 'max-oauth-passthrough', upstream = '', callKind = '' }) {
      const db = tokenDb();
      if (!db || !usage.sawUsage) return;
      const uIn = usage.input; const uOut = usage.output;
      const cacheRead = usage.cacheRead; const cacheWrite = usage.cacheWrite;
      const total = uIn + uOut;
      try {
        logTokenCall(db, {
          timestamp: new Date().toISOString(),
          // The ACCOUNT that gets billed, from the resolved route — not the
          // literal 'anthropic' this used to stamp. That literal is why the
          // dashboard reported "anthropic 100%": it merged personal Max
          // subscription traffic (this route) with metered anthropic-api key
          // traffic under one label, so the pie could never show you which
          // account your foreground tokens were actually coming out of.
          // A caller that knows the account better (glass: the intercepted host) names it.
          provider: provider || route?.provider || 'claude-code-max',
          model,
          model_raw: (reqJson && reqJson.model) || model,
          process: proc,
          subscription,
          input_tokens: uIn,
          output_tokens: uOut,
          total_tokens: total,
          cache_read_tokens: cacheRead,   // WIRE-02: surfaced separately from total
          cache_write_tokens: cacheWrite,
          latency_ms: latencyMs,
          // What this turn asked, redacted. Empty until now — not by policy but
          // because extractPromptPreview() only read string `content`, and on
          // this wire content is an array of typed blocks, so it would have
          // returned '' anyway. It reads both wires now, so a claude turn is
          // captioned like every other.
          prompt_preview: promptPreview(reqJson?.messages),
          tokens_estimated: total === 0 ? 1 : 0,
          agent,
          user_hash: adapterUserHash(agent), // WIRE-03: 'cladpt' for claude; non-cladpt (copadt/opcadt/mstadt) otherwise

          tool_call_id: requestId,    // = transcript requestId → dedups with Route 2
          granularity_tier: 'per-turn',
          task_id: taskId,
          // ── Routing decision for the foreground passthrough ──
          // Only the route half applies: this endpoint forwards the Anthropic
          // wire verbatim to the one provider carrying fg_transport. There is no
          // chain to walk and no fallback to take, so chain_position is written
          // as an explicit observed 0 rather than left to the column default —
          // the difference between "observed: served by the route's own
          // provider" and "nothing was ever recorded" is the whole reason
          // routing_source exists.
          route_key: route?.matchedKey || '',
          route_band: route?.complexity || '',
          route_step: route?.step || 0,
          offloaded_from: '',
          chain_position: 0,
          attempt_trail: '',
          routing_source: route ? 'live' : '',
          // Turn identity applies here too, and matters MORE than on the OpenAI
          // wire: a Claude Code turn is many calls, and this is the endpoint
          // they all arrive on. turnIdentity() reads the Anthropic message
          // shape correctly — a tool_result arrives as a role:'user' message,
          // which a naive count would read as a new turn on every hop.
          //
          // band_source is the route's own, not a caller declaration: this
          // passthrough never consults the classifier (fg-chat/claude cannot be
          // offloaded — no local provider carries fg_transport), so the band is
          // whatever the route says and saying so is the honest record.
          ...turnIdentity(reqJson?.messages, agent),
          band_source: route?.matchedKey ? `route ${route.matchedKey}` : '',
          project,
          upstream,
          call_kind: callKind,
        });
        log(`/v1/messages tap: ${proc} model=${model} in=${uIn} out=${uOut} task=${taskId || '(none)'} req=${requestId || '(none)'}`);
      } catch (err) {
        logErr(`/v1/messages token log failed (non-fatal): ${err?.message || err}`);
      }
      // Phase 84-04 call-site A (Anthropic wire): append ONE context-turns line
      // for this measured request. Own sibling try/catch (never blocks the tap);
      // skip neutral/interactive rows (empty taskId). Reuses the SAME resolved
      // taskId/agent already in scope — no fresh resolution.
      if (taskId) {
        try {
          const analysis = analyzeAnthropicRequest(reqJson);
          logContextTurn(contextTurnsDir(taskId), buildAnthropicLine({
            reqJson,
            taskId,
            agent,
            requestId,
            model,
            usage: { input: uIn, output: uOut, cache_read: cacheRead, cache_write: cacheWrite },
            categories: analysis.categories,
          }));
        } catch (err) {
          logErr(`/v1/messages context-turn build failed (non-fatal): ${err?.message || err}`);
        }
      }
      // Phase 84-06 call-site A (Anthropic wire): flag-gated FULL raw-body capture.
      // Default OFF; only when the span opted in (captureRaw). Both request AND
      // response are redacted via the shared 27-pattern set BEFORE the line is built
      // (redaction always pre-write, T-84-06-01), then appended to the SEPARATE
      // raw-bodies.jsonl sibling. Own best-effort try/catch → never blocks the tap.
      if (captureRaw) {
        try {
          appendRawBody(contextTurnsDir(taskId), {
            ts: new Date().toISOString(),
            task_id: taskId,
            request_id: requestId,
            wire: 'anthropic',
            request: redactRawBody(JSON.stringify(reqJson)),
            response: redactRawBody(usage.rawResponse),
          });
        } catch (err) {
          logErr(`/v1/messages raw-body write failed (non-fatal): ${err?.message || err}`);
        }
      }
    },

    /**
     * The context-turns line and (opt-in) raw bodies of one /api/complete
     * completion. The token_usage row itself is written by the caller, whose
     * routing decision fills most of it.
     */
    recordCompletionCapture({ body, result, taskId, span }) {
      writeOpenAICapture({
        label: '/api/complete',
        body,
        taskId,
        agent: typeof body.agent === 'string' && body.agent ? body.agent : '',
        requestId: typeof body.tool_call_id === 'string' ? body.tool_call_id : '',
        model: canonicalModel(result.model) || result.model || 'unknown',
        usage: {
          input: result.tokens?.input ?? 0,
          output: result.tokens?.output ?? 0,
          cache_read: result.tokens?.cache_read_tokens ?? 0,
        },
        captureRaw: rawBodyCaptureEnabled(span),
        rawResponse: () => JSON.stringify(result),
      });
    },

    /**
     * Write what the OpenAI-wire measuring passthrough measured for one call: the
     * token_usage row, its context-turns line and (opt-in) the redacted raw
     * bodies. `body` is the chat-shaped request (a Responses-API request converted
     * with responsesToChatBody). A no-op without a token DB or without usage.
     */
    recordOpenAITap({ provider, wire, body, proc, agent, project, requestId, taskId, usage, latencyMs, captureRaw, upstream = '', callKind = '' }) {
      const db = tokenDb();
      if (!db || !usage.sawUsage) return;
      const rawModel = usage.model || body?.model || 'unknown';
      const model = canonicalModel(rawModel) || rawModel;
      const total = usage.input + usage.output;
      try {
        logTokenCall(db, {
          timestamp: new Date().toISOString(),
          provider,
          model,
          model_raw: rawModel,
          process: proc,
          subscription: '',
          input_tokens: usage.input,
          output_tokens: usage.output,
          total_tokens: total,
          cache_read_tokens: usage.cacheRead,
          cache_write_tokens: usage.cacheWrite,
          latency_ms: latencyMs,
          prompt_preview: promptPreview(body?.messages),
          tokens_estimated: total === 0 ? 1 : 0,
          agent,
          user_hash: adapterUserHash(agent),
          tool_call_id: requestId,
          granularity_tier: 'per-llm-call',
          task_id: taskId,
          // A passthrough: the agent chose provider and model, nothing was routed.
          route_key: '',
          route_band: '',
          route_step: 0,
          offloaded_from: '',
          chain_position: 0,
          attempt_trail: '',
          routing_source: '',
          ...turnIdentity(body?.messages, agent),
          band_source: '',
          project,
          upstream,
          call_kind: callKind,
        });
        log(`openai ${wire} tap: ${proc} model=${model} in=${usage.input} out=${usage.output} task=${taskId || '(none)'} req=${requestId || '(none)'}`);
      } catch (err) {
        logErr(`openai ${wire} token log failed (non-fatal): ${err?.message || err}`);
      }
      writeOpenAICapture({
        label: `openai ${wire}`,
        body,
        taskId,
        agent,
        requestId,
        model,
        usage: { input: usage.input, output: usage.output, cache_read: usage.cacheRead },
        captureRaw,
        rawResponse: () => usage.rawResponse,
      });
    },

    /**
     * The breakdown JSON text: a measured run's own (taskId) or the live-latest
     * capture (no taskId). Throws when nothing was captured.
     */
    readBreakdown(taskId) {
      return fs.readFileSync(taskId ? perRunBreakdownPath(taskId) : CTX_BREAKDOWN_PATH, 'utf8');
    },

    /**
     * Phase 84-04 (D-10): per-turn context array for one measured run. Reads the
     * gzipped span-closed file, or the plaintext .jsonl while the span is still
     * open (D-03 append half). Graceful-empty on a missing / partly-written file
     * or a traversal task_id.
     */
    readContextTurns(taskId) {
      const dir = contextTurnsDir(taskId);
      let text = '';
      if (dir) {
        try {
          // Prefer the gzipped file written at span close; fall back to plaintext.
          text = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'context-turns.jsonl.gz'))).toString('utf8');
        } catch {
          try { text = fs.readFileSync(path.join(dir, 'context-turns.jsonl'), 'utf8'); }
          catch { text = ''; }
        }
      }
      return text
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    },
  };
}
