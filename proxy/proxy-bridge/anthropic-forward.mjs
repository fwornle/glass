// proxy-bridge/anthropic-forward.mjs
//
// ATTR-05 (Route 1): the Anthropic /v1/messages transparent passthrough. A Claude
// Code session pointed here via ANTHROPIC_BASE_URL routes its MAIN + SUB-AGENT LLM
// calls through the proxy. Claude Code otherwise talks to api.anthropic.com
// directly, so those foreground tokens never reach token_usage. We forward the
// request VERBATIM (preserving the caller's Authorization = Max-OAuth bearer,
// anthropic-version/-beta, tool-use, prompt-caching, streaming), stream the
// response straight back so the live session is unaffected, and TAP the usage
// into token_usage stamped with the bound task_id + the agent's adapter user_hash
// (→ FOREGROUND). tool_call_id = the upstream `request-id` header, which equals
// the value Claude Code writes as `requestId` in its transcript — so this row
// shares the (cladpt, request-id) dedup key with the stop-time transcript adapter
// (Route 2) and the two NEVER double-count (whichever writes first wins).
// count_tokens (/v1/messages/count_tokens) is forwarded but never tapped.
//
// Shared by server.mjs (routing-aware: routeGuard, keychain token, re-pinning
// egress) and glass's daemon (base URL and intercepted traffic: no routing, the
// agent's own credentials, upstream = the real host). Both inject what differs.

import { buildAnthropicForwardHeaders } from './anthropic-headers.mjs';
import { createAnthropicUsageTap, bindTapTaskId, tapCapturesRawBodies } from './measurement.mjs';
import { canonicalizeModelName } from './model-canonical.mjs';
import { sanitizeProject } from '../dist/token-usage.js';

// Transient gateway failures (502/503/504) and network errors over the corporate
// egress surface to the caller as a failed turn ("bad gateway"). Retry with
// backoff BEFORE any response byte is written — the request body is fully
// buffered so re-sending is safe and idempotent here. These are the only
// statuses retried; real API errors (400/401/403/429/…) pass straight through.
const GATEWAY_RETRY_STATUSES = new Set([502, 503, 504]);
const DROPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

/**
 * fetch with the gateway retry. Returns the upstream Response, or null after the
 * last attempt failed (lastErr then says why).
 */
export async function forwardWithRetry(url, init, { fetch, attempts, backoffMs, logErr, label }) {
  let upstream = null;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, backoffMs[attempt] ?? 900));
    }
    try {
      upstream = await fetch(url, init);
    } catch (err) {
      lastErr = err;
      upstream = null;
      logErr(`${label} forward attempt ${attempt + 1}/${attempts} network error: ${err?.message || err}`);
      continue; // network-level failure — retry
    }
    if (GATEWAY_RETRY_STATUSES.has(upstream.status) && attempt < attempts - 1) {
      lastErr = new Error(`upstream ${upstream.status}`);
      logErr(`${label} forward attempt ${attempt + 1}/${attempts} got HTTP ${upstream.status} — retrying`);
      try { await upstream.body?.cancel(); } catch { /* drain failed body — ignore */ }
      upstream = null;
      continue; // transient gateway status — retry
    }
    break; // success or a non-retryable status — forward it as-is
  }
  return { upstream, lastErr };
}

/** Upstream response headers minus the ones the re-framed response must not carry. */
/**
 * The account that answered, named by an upstream that routes (this proxy names it
 * on its own responses). A forwarder in front of such a router records it rather
 * than its own label for the router — the router is not a provider.
 */
export const ANSWERING_PROVIDER_HEADER = 'x-llm-provider';

/** The upstream's x-llm-provider when it is a plain account id, else `fallback`. */
export function answeringProvider(upstream, fallback) {
  const v = (upstream?.headers?.get?.(ANSWERING_PROVIDER_HEADER) || '').trim();
  return /^[A-Za-z0-9][\w.:-]{0,63}$/.test(v) ? v : fallback;
}

export function copyResponseHeaders(upstream) {
  const out = {};
  upstream.headers.forEach((v, k) => {
    if (DROPPED_RESPONSE_HEADERS.has(k.toLowerCase())) return;
    out[k] = v;
  });
  return out;
}

/**
 * Pipe an upstream body to the client verbatim, feeding each chunk (SSE) or the
 * whole body (anything else) to the tap.
 */
export async function pipeAndTap(upstream, res, { isSse, onChunk, onBody, logErr, label }) {
  if (!upstream.body) { res.end(); return; }
  if (isSse) {
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value)); // verbatim to the live session
        onChunk(value);
      }
    } catch (err) {
      logErr(`${label} stream error (non-fatal): ${err?.message || err}`);
    } finally {
      res.end();
    }
    return;
  }
  // Non-streaming (or an error response): buffer, forward, parse usage.
  let buf;
  try { buf = Buffer.from(await upstream.arrayBuffer()); } catch { buf = Buffer.alloc(0); }
  res.end(buf);
  onBody(buf);
}

/**
 * Serve one POST /v1/messages* request.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {object} o
 * @param {object} o.measurement          createMeasurement(...) of the caller
 * @param {Function} o.fetch              fetch used for the upstream call
 * @param {string} [o.upstreamBase]       scheme://host the request goes to
 * @param {Function|null} [o.getToken]    () => {accessToken} when the caller sent no auth
 * @param {Function|null} [o.routeGuard]  (agent) => {route} | {status, body}: refuse before forwarding
 * @param {Function} [o.bindTaskId]       ({hdrTaskId, agent, logErr}) => taskId (default bindTapTaskId)
 * @param {string} [o.agent]              the agent, when the caller knows it better than x-agent
 * @param {string} [o.provider]           the account label for the row (default: the route's, else claude-code-max)
 * @param {string} [o.subscription]       the row's subscription label (default max-oauth-passthrough)
 */
export async function handleAnthropicMessages(req, res, {
  measurement, fetch, upstreamBase = 'https://api.anthropic.com', getToken = null, routeGuard = null,
  bindTaskId = bindTapTaskId, agent: agentOverride = '', provider = '', subscription = 'max-oauth-passthrough',
  attempts = Number(process.env.LLM_PROXY_FORWARD_ATTEMPTS || 3), backoffMs = [0, 300, 900],
  logErr = () => {},
}) {
  const v1Path = (req.url || '').split('?')[0];
  const isCompletion = v1Path === '/v1/messages'; // exclude count_tokens
  // Buffer the request body (JSON) — needed to both forward and inspect.
  let rawBody = '';
  for await (const chunk of req) rawBody += chunk;
  let reqJson = null;
  try { reqJson = JSON.parse(rawBody); } catch { /* forward as-is */ }
  const model = canonicalizeModelName(reqJson?.model) || reqJson?.model || 'unknown';
  // main vs sub-agent (ATTR-04 parity): a sub-agent's request carries a
  // RESTRICTED toolset with no spawner tool; the main session has 'Agent'/'Task'.
  // No tools at all (utility calls e.g. title-gen) → treated as main (negligible).
  const toolNames = Array.isArray(reqJson?.tools)
    ? reqJson.tools.map((t) => t && t.name).filter(Boolean) : [];
  const isSubagent = toolNames.length > 0
    && !toolNames.includes('Agent') && !toolNames.includes('Task');
  // x-task-id / x-agent bind this request to a run; the rule (headers win,
  // no ambient inheritance) is bindTapTaskId in measurement.mjs.
  const hdrTaskId = typeof req.headers['x-task-id'] === 'string' ? req.headers['x-task-id'].trim() : '';
  const hdrAgent = typeof req.headers['x-agent'] === 'string' ? req.headers['x-agent'].trim() : '';
  const agent = agentOverride || hdrAgent || 'claude';
  // The repo the agent was launched in (the launcher sends it). '' when
  // absent or malformed — a missing project is a rollup gap, never a 4xx.
  const project = sanitizeProject(req.headers['x-project']);

  let route = null;
  if (routeGuard) {
    const verdict = routeGuard(agent);
    if (verdict.status) {
      res.writeHead(verdict.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(verdict.body));
    }
    route = verdict.route;
  }
  const taskId = bindTaskId({ hdrTaskId, agent, logErr });
  const captureRaw = tapCapturesRawBodies(taskId);
  // process: non-claude agents stamp 'token-adapter-<agent>'; claude keeps the
  // main/sub-agent split so ATTR-04 foreground/subagent classification survives.
  const proc = agent !== 'claude'
    ? `token-adapter-${agent}`
    : (isSubagent ? 'token-adapter-claude-subagent' : 'token-adapter-claude');

  // Phase 78: snapshot the REAL per-category size of the context window
  // (non-fatal — a capture failure must never touch forwarding).
  if (reqJson && isCompletion) measurement.captureAnthropicBreakdown({ reqJson, model, taskId, isSubagent });

  const fwdHeaders = buildAnthropicForwardHeaders(req.headers, getToken);

  const startTime = Date.now();
  const { upstream, lastErr } = await forwardWithRetry(`${upstreamBase}${req.url}`, {
    method: 'POST', headers: fwdHeaders, body: rawBody,
  }, { fetch, attempts, backoffMs, logErr, label: '/v1/messages' });
  if (!upstream) {
    logErr(`/v1/messages forward failed after ${attempts} attempts (non-fatal): ${lastErr?.message || lastErr}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `proxy forward failed after ${attempts} attempts: ${lastErr?.message || lastErr}` } }));
    return;
  }

  const requestId = upstream.headers.get('request-id') || '';
  const isSse = (upstream.headers.get('content-type') || '').includes('text/event-stream');
  const answered = answeringProvider(upstream, provider || route?.provider || 'claude-code-max');
  res.writeHead(upstream.status, { ...copyResponseHeaders(upstream), [ANSWERING_PROVIDER_HEADER]: answered });

  const usageTap = createAnthropicUsageTap({ captureRaw });
  await pipeAndTap(upstream, res, {
    isSse, onChunk: (v) => usageTap.sseChunk(v), onBody: (b) => usageTap.jsonBody(b), logErr, label: '/v1/messages',
  });

  // Tap: only genuine completions (not count_tokens) with real usage.
  if (isCompletion) {
    measurement.recordAnthropicTap({
      route, model, reqJson, proc, agent, project, requestId, taskId,
      usage: usageTap.usage, latencyMs: Date.now() - startTime, captureRaw, provider: answered, subscription,
    });
  }
}
