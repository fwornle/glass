// proxy-bridge/openai-passthrough.mjs
//
// A MEASURING PASSTHROUGH for the OpenAI wire (chat/completions and the Responses
// API): forward the agent's request verbatim to the host it was going to anyway,
// with the agent's own credentials, stream the response straight back, and tap
// the usage into token_usage + the per-run context capture.
//
// Unlike server.mjs's OpenAI shim, nothing here chooses a provider or a model,
// re-frames a stream or answers the call itself — the agent's provider, model and
// login stay exactly what the agent configured. Used by glass's daemon for
// traffic it intercepts (copilot, opencode's providers, pi's providers).
//
// One opt-in exception (offload.mjs): with `offload` given and switched on for
// this agent, an easy chat call may be answered by the user's own endpoint
// instead; whatever fails there before the first byte falls back to the forward
// below, unchanged.
//
// The one change to the request: a streamed chat/completions call that did not
// ask for usage gets stream_options.include_usage = true, because without it the
// stream carries no usage at all. The client then sees one extra final chunk with
// `choices: []`, which the OpenAI wire defines for exactly this option.

import { randomUUID } from 'node:crypto';
import { buildAnthropicForwardHeaders } from './anthropic-headers.mjs';
import { forwardWithRetry, copyResponseHeaders, pipeAndTap, answeringProvider } from './anthropic-forward.mjs';
import { createOpenAIUsageTap, tapCapturesRawBodies } from './measurement.mjs';
import { responsesToChatBody } from './shim-tools.mjs';
import { normalizeOffloadConfig, offloadRowFields } from './offload.mjs';

/** 'chat' | 'responses' | null (a path this tap does not measure). */
export function openAIWireOf(url) {
  const p = (url || '').split('?')[0];
  if (/\/chat\/completions$/.test(p)) return 'chat';
  if (/\/responses$/.test(p)) return 'responses';
  return null;
}

/**
 * The body actually forwarded: the original bytes, unless a streamed chat call
 * has to be asked for its usage.
 */
export function withUsageRequested(wire, rawBody, reqJson) {
  if (wire !== 'chat' || !reqJson || reqJson.stream !== true) return rawBody;
  if (reqJson.stream_options && reqJson.stream_options.include_usage === true) return rawBody;
  return JSON.stringify({ ...reqJson, stream_options: { ...(reqJson.stream_options || {}), include_usage: true } });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Forward any request to upstreamBase unchanged, with no tap (the catalogue,
 * token exchange and telemetry calls an intercepted agent also makes).
 */
export async function forwardPlain(req, res, { fetch, upstreamBase, logErr = () => {} }) {
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  const { upstream, lastErr } = await forwardWithRetry(`${upstreamBase}${req.url}`, {
    method: req.method, headers: buildAnthropicForwardHeaders(req.headers, null), body,
  }, { fetch, attempts: 1, backoffMs: [0], logErr, label: 'forward' });
  if (!upstream) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `forward failed: ${lastErr?.message || lastErr}` }));
    return;
  }
  res.writeHead(upstream.status, copyResponseHeaders(upstream));
  const isSse = (upstream.headers.get('content-type') || '').includes('text/event-stream');
  await pipeAndTap(upstream, res, { isSse, onChunk: () => {}, onBody: () => {}, logErr, label: 'forward' });
}

/**
 * Serve one OpenAI-wire call: forward, stream back, tap.
 *
 * @param {object} o
 * @param {object} o.measurement   createMeasurement(...) of the caller
 * @param {Function} o.fetch       fetch for the upstream call
 * @param {string} o.upstreamBase  scheme://host the agent was talking to
 * @param {string} o.provider      the account label for the row (e.g. github-copilot)
 * @param {string} o.agent         the agent the call belongs to
 * @param {string} [o.taskId]      the run it is bound to ('' → unbound, no capture)
 * @param {string} [o.project]
 * @param {{offloader: object, getConfig: Function}|null} [o.offload]  opt-in offload (offload.mjs)
 */
export async function handleOpenAIPassthrough(req, res, {
  measurement, fetch, upstreamBase, provider, agent, taskId = '', project = '',
  attempts = Number(process.env.LLM_PROXY_FORWARD_ATTEMPTS || 3), backoffMs = [0, 300, 900],
  logErr = () => {}, offload = null,
}) {
  const wire = openAIWireOf(req.url);
  if (req.method !== 'POST' || !wire) return forwardPlain(req, res, { fetch, upstreamBase, logErr });

  const raw = await readBody(req);
  let reqJson = null;
  try { reqJson = JSON.parse(raw.toString('utf8')); } catch { /* forward as-is */ }
  const body = withUsageRequested(wire, raw, reqJson);
  // The context capture reads the chat shape; a Responses request is converted.
  const chatBody = reqJson ? (wire === 'responses' ? responsesToChatBody(reqJson) : reqJson) : null;
  const captureRaw = tapCapturesRawBodies(taskId);
  const proc = `token-adapter-${agent}`;
  // From the request as sent: a Responses request's non-function tools
  // (web_search, …) are dropped by the chat conversion but still make it a loop call.
  const callKind = reqJson ? (Array.isArray(reqJson.tools) && reqJson.tools.length ? 'main' : 'side') : '';

  if (chatBody && taskId) measurement.captureOpenAIBreakdown({ oaBody: chatBody, agent, taskId });

  const startTime = Date.now();

  // Opt-in offload. Only an agent the user switched on gets route columns at all;
  // everyone else's rows stay exactly the passthrough's.
  let routing = null;
  const cfg = offload ? normalizeOffloadConfig(offload.getConfig()) : null;
  if (cfg && cfg.enabled && cfg.agents[agent]) {
    const decision = await offload.offloader.decide({ agent, wire, body: reqJson });
    let outcome = null;
    if (decision.offload) {
      const tap = createOpenAIUsageTap({ wire, captureRaw });
      outcome = await offload.offloader.serve({
        res, body: reqJson, decision, onChunk: (v) => tap.sseChunk(v), onBody: (b) => tap.jsonBody(b),
      });
      if (outcome.served) {
        if (chatBody) {
          measurement.recordOpenAITap({
            provider, wire, body: chatBody, proc, agent, project, requestId: `offload-${randomUUID()}`, taskId,
            usage: tap.usage, latencyMs: Date.now() - startTime, captureRaw, upstream: cfg.target.url, callKind,
            routing: offloadRowFields({ agent, cfg, decision, outcome, fromProvider: provider }),
          });
        }
        return;
      }
      logErr(`offload to ${cfg.target.name} failed after ${outcome.ms} ms, forwarding: ${outcome.error}`);
    }
    routing = offloadRowFields({ agent, cfg, decision, outcome, fromProvider: provider });
  }

  const { upstream, lastErr } = await forwardWithRetry(`${upstreamBase}${req.url}`, {
    method: 'POST', headers: buildAnthropicForwardHeaders(req.headers, null), body,
  }, { fetch, attempts, backoffMs, logErr, label: `openai ${wire}` });
  if (!upstream) {
    logErr(`openai ${wire} forward failed after ${attempts} attempts (non-fatal): ${lastErr?.message || lastErr}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'api_error', message: `proxy forward failed after ${attempts} attempts: ${lastErr?.message || lastErr}` } }));
    return;
  }

  const requestId = upstream.headers.get('x-request-id') || upstream.headers.get('request-id') || `oa-${randomUUID()}`;
  const isSse = (upstream.headers.get('content-type') || '').includes('text/event-stream');
  res.writeHead(upstream.status, copyResponseHeaders(upstream));

  const usageTap = createOpenAIUsageTap({ wire, captureRaw });
  await pipeAndTap(upstream, res, {
    isSse, onChunk: (v) => usageTap.sseChunk(v), onBody: (b) => usageTap.jsonBody(b), logErr, label: `openai ${wire}`,
  });

  if (upstream.ok && chatBody) {
    measurement.recordOpenAITap({
      // A routing upstream (this proxy, as an opencode provider) names the account
      // that answered; the label the agent gave the router is not a provider.
      provider: answeringProvider(upstream, provider), wire, body: chatBody, proc, agent, project, requestId, taskId,
      usage: usageTap.usage, latencyMs: Date.now() - startTime, captureRaw,
      upstream: upstreamBase, callKind, routing,
    });
  }
}
