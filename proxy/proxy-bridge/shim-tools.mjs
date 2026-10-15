// Phase 82-03: pure, never-throw helpers for the OpenAI-shim native tool-call
// passthrough. Extracted so the forward / response-mapping / capability-gating
// logic is unit-testable without booting the HTTP server (the response code in
// server.mjs is not directly importable). server.mjs imports these so the tests
// exercise the SAME logic the runtime uses.

/**
 * Forward OpenAI tools[]/tool_choice from an incoming shim body onto the
 * internal /api/complete envelope. Returns ONLY the fields that are present, so
 * a tool-less request is byte-unchanged (no tools/tool_choice key added).
 * @param {any} oaBody
 * @returns {{ tools?: unknown[], tool_choice?: unknown }}
 */
export function shimToolFields(oaBody) {
  const out = {};
  if (oaBody && Array.isArray(oaBody.tools)) out.tools = oaBody.tools;
  if (oaBody && oaBody.tool_choice !== undefined) out.tool_choice = oaBody.tool_choice;
  return out;
}

/** Convert an OpenAI Responses request to the shared chat-completions envelope. */
export function responsesToChatBody(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const messages = [];
  const contentToChat = (content) => {
    if (!Array.isArray(content)) return content ?? '';
    return content.map(part => {
      if (part?.type === 'input_text' || part?.type === 'output_text') {
        return { type: 'text', text: part.text || '' };
      }
      if (part?.type === 'input_image') {
        return { type: 'image_url', image_url: part.image_url || part.image || '' };
      }
      return part;
    });
  };
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.role === 'developer' || item.role === 'system' || item.role === 'user' || item.role === 'assistant') {
      const role = item.role === 'developer' ? 'system' : item.role;
      messages.push({ role, content: contentToChat(item.content) });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: item.output ?? '' });
    } else if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: item.call_id || item.id || '',
          type: 'function',
          function: { name: item.name || '', arguments: item.arguments || '{}' },
        }],
      });
    }
  }
  const tools = Array.isArray(body?.tools)
    ? body.tools.filter(t => t?.type === 'function').map(t => ({
      type: 'function',
      function: { name: t.name || '', description: t.description || '', parameters: t.parameters || {}, strict: t.strict === true },
    }))
    : undefined;
  return {
    model: body?.model,
    messages,
    ...(tools ? { tools } : {}),
    ...(body?.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(body?.reasoning?.effort ? { reasoning_effort: body.reasoning.effort } : {}),
    stream: body?.stream === true,
  };
}

/**
 * The item id of a Responses `function_call`. It is not the call id: OpenAI's
 * Responses API (and Copilot's) gives each tool call an item `id` that must begin
 * with `fc` and a separate `call_id`, usually `call_...`. A client echoes the item
 * id back in the next request's `input`, and Copilot rejects one that does not
 * begin with `fc` with a 400 -- so a session broke on the first turn after any
 * tool call. Keep the upstream item id when there is one; otherwise derive a
 * stable one from the call id, so the same call keeps the same id across turns.
 * @param {string | undefined} itemId
 * @param {string | undefined} callId
 * @param {number} index
 */
export function functionCallItemId(itemId, callId, index) {
  if (typeof itemId === 'string' && itemId.startsWith('fc')) return itemId;
  if (typeof callId === 'string' && callId) return `fc_${callId.replace(/^call_/, '')}`;
  return `fc_${index}`;
}

/**
 * Repair the `function_call` item ids in a Responses request's `input`. A
 * session recorded before functionCallItemId existed carries `call_...` ids in
 * its history, and Copilot refuses the whole request over one of them. Returns
 * the input unchanged (same reference) when nothing needs repairing.
 * @param {unknown} input
 */
export function repairFunctionCallIds(input) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const out = input.map((item, index) => {
    if (item?.type !== 'function_call' || (typeof item.id === 'string' && item.id.startsWith('fc'))) return item;
    if (item.id === undefined) return item;
    changed = true;
    return { ...item, id: functionCallItemId(undefined, item.call_id || item.id, index) };
  });
  return changed ? out : input;
}

/** Single-shot Responses API SSE frames for a buffered provider result. */
export function responseSseFrames(result, responseId = `resp_${Date.now()}`) {
  const output = [];
  if (result?.content) {
    output.push({
      id: `msg_${responseId}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: result.content, annotations: [] }],
    });
  }
  for (const [index, tc] of (result?.toolCalls || []).entries()) {
    output.push({
      id: functionCallItemId(tc.itemId, tc.id, index),
      type: 'function_call',
      call_id: tc.id || `call_${index}`,
      name: tc.function?.name || '',
      arguments: tc.function?.arguments || '{}',
      status: 'completed',
    });
  }
  const response = {
    id: responseId,
    object: 'response',
    status: 'completed',
    model: result?.model || '',
    output,
    // Same cache-split rule as the chat/completions envelope in server.mjs, in
    // this wire's spelling: `input_tokens` INCLUDES the cache hits and
    // `input_tokens_details.cached_tokens` names them (which is exactly what the
    // proxy's own Responses-API reader parses back out). `result.tokens.input`
    // is FRESH input, so the cached slice is added back here. Omitting it made a
    // cache-heavy conversation report only its fresh tokens, which is what drove
    // OpenCode's context gauge to 0%.
    usage: {
      input_tokens: (result?.tokens?.input ?? 0) + (result?.tokens?.cache_read_tokens ?? 0),
      output_tokens: result?.tokens?.output ?? 0,
      total_tokens: (result?.tokens?.input ?? 0)
        + (result?.tokens?.cache_read_tokens ?? 0)
        + (result?.tokens?.output ?? 0),
      ...(result?.tokens?.cache_read_tokens
        ? { input_tokens_details: { cached_tokens: result.tokens.cache_read_tokens } }
        : {}),
    },
  };
  const frames = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }];
  for (let index = 0; index < output.length; index += 1) {
    const item = output[index];
    frames.push({ type: 'response.output_item.added', output_index: index, item });
    if (item.type === 'message') {
      frames.push({ type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta: item.content[0].text });
      frames.push({ type: 'response.output_text.done', item_id: item.id, output_index: index, content_index: 0, text: item.content[0].text });
    } else {
      frames.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: item.arguments });
      frames.push({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: item.arguments });
    }
    frames.push({ type: 'response.output_item.done', output_index: index, item });
  }
  frames.push({ type: 'response.completed', response });
  return frames;
}

/**
 * Resolve the effective shim task_id from the three per-request sources, at the
 * documented precedence: X-Task-Id header > body.task_id > path-scoped
 * /t/<taskId> segment. Ambient (resolveLiveTaskId) is applied by the caller as
 * the final fallback when this returns ''. Pure string precedence.
 * @param {string} hdrTaskId
 * @param {string} bodyTaskId
 * @param {string} pathTaskId
 * @returns {string}
 */
export function resolveShimTaskId(hdrTaskId, bodyTaskId, pathTaskId) {
  return (hdrTaskId || '') || (bodyTaskId || '') || (pathTaskId || '');
}

/** Complexity bands a path may declare. Mirrors COMPLEXITY_BANDS in routing-config.mjs. */
const PATH_BANDS = ['small', 'medium', 'high'];

/**
 * Parse an OpenAI-shim path carrying a per-session binding, in any of:
 *
 *   /v1/<agent>/t/<taskId>/chat/completions              task only
 *   /v1/<agent>/b/<band>/chat/completions                band only
 *   /v1/<agent>/b/<band>/t/<taskId>/chat/completions     both
 *
 * where agent ∈ copilot | opencode | pi. This is the binding seam for agents
 * that cannot set request headers.
 *
 * ── Why a BAND may be declared in the URL ────────────────────────────────────
 * `fg-chat/copilot` is `complexity: from-caller`, but the Copilot CLI declares
 * nothing: measured on the wire 2026-08-29, its BYOK body is exactly
 * {model, stream, stream_options, tools} and its only headers are x-stainless-*.
 * It sends no `reasoning_effort`, and `effortLevel` in ~/.copilot/settings.json
 * is not forwarded on this path. So every copilot turn fell to
 * defaults.fg-chat (high) and NOTHING copilot did could ever be offloaded —
 * while an identical opencode or pi turn could.
 *
 * The URL is the one seam that agent has; it is already how its task_id binds.
 * The cost is honest and worth stating: a band declared here holds for the whole
 * SESSION, because the launcher builds the base URL once. pi (--thinking) and
 * opencode (--variant) stay per-turn and are strictly better.
 *
 * NOT `x-complexity`, which this comment used to credit opencode with: it has
 * never sent that header, and its provider block has no `headers` key to set one
 * with. `--variant` is the real seam — a variant is read off the user message
 * each turn and @ai-sdk/openai-compatible maps `reasoningEffort` onto
 * `reasoning_effort`, which resolveCallerComplexity() already reads. Verified on
 * a capture endpoint 2026-08-30: bare run sends no effort field, `--variant
 * cheap` sends "low", `--variant high` sends "high". The header remains a
 * supported input for any client that CAN set one; opencode is not that client.
 *
 * Band is validated HERE rather than downstream: an unrecognised word makes the
 * whole path fail to match, so a typo produces a plainly wrong URL instead of a
 * silently ignored band.
 *
 * At least one of the two segments must be present — otherwise this would newly
 * match a bare /v1/<agent>/chat/completions, which today is either handled by
 * the exact SHIM_PATH_AGENTS map or is deliberately not a shim path at all.
 *
 * Returns { agent, band, taskId } on a match, else null. `band` is null and
 * `taskId` is '' when their segment is absent. Pure: the untrusted taskId is
 * returned raw — the caller applies sanitizeTaskId (charset whitelist +
 * basename) before any DB/file use. The band needs no sanitising because it is
 * matched against a closed set.
 *
 * @param {string} url
 * The optional leading `/p/<project>` segment carries the repo the agent was
 * launched in (coding's project id), for the same reason as the rest: copilot
 * cannot send an x-project header. Returned raw, like taskId — the caller
 * sanitizes it (sanitizeProject) before it reaches a row.
 *
 * @returns {{ agent: string, band: string | null, taskId: string, project: string } | null}
 */
export function matchShimPath(url) {
  const m = /^\/v1\/(copilot|opencode|pi)(?:\/p\/([^/]+))?(?:\/b\/([a-z]+))?(?:\/t\/([^/]+))?\/chat\/completions$/
    .exec(url || '');
  if (!m) return null;
  const [, agent, project, band, taskId] = m;
  if (project === undefined && band === undefined && taskId === undefined) return null;
  if (band !== undefined && !PATH_BANDS.includes(band)) return null;
  return { agent, band: band ?? null, taskId: taskId ?? '', project: project ?? '' };
}

/** Match OpenCode's OpenAI Responses endpoint, optionally project- and task-scoped. */
export function matchResponsesShimPath(url) {
  const m = /^\/v1\/opencode(?:\/p\/([^/]+))?(?:\/t\/([^/]+))?\/responses$/.exec(url || '');
  return m ? { agent: 'opencode', taskId: m[2] ?? '', project: m[1] ?? '' } : null;
}

/**
 * True when a provider result carries a non-empty tool_calls array.
 * @param {any} result
 */
export function hasToolCalls(result) {
  return !!(result && Array.isArray(result.toolCalls) && result.toolCalls.length > 0);
}

/**
 * Buffered OpenAI chat.completion `choice` for a provider result. Emits
 * message.tool_calls + finish_reason 'tool_calls' when tool calls are present;
 * otherwise byte-identical to the prior { role, content } + 'stop' envelope.
 * @param {any} result
 */
export function buildBufferedChoice(result) {
  const message = { role: 'assistant', content: (result && result.content) || '' };
  const tc = hasToolCalls(result);
  if (tc) message.tool_calls = result.toolCalls;
  return { index: 0, message, finish_reason: tc ? 'tool_calls' : 'stop' };
}

/**
 * Single-shot SSE reframe for a provider result. Returns the first delta
 * (role + content, plus delta.tool_calls when present) and the terminal
 * finish_reason. Mirrors the existing content reframe byte-for-byte when there
 * are no tool calls.
 * @param {any} result
 * @returns {{ delta: any, finishReason: 'stop' | 'tool_calls' }}
 */
export function buildStreamDelta(result) {
  const delta = { role: 'assistant', content: (result && result.content) || '' };
  const tc = hasToolCalls(result);
  if (tc) delta.tool_calls = result.toolCalls;
  return { delta, finishReason: tc ? 'tool_calls' : 'stop' };
}

/**
 * Capability gate: a tools-bearing request must NEVER land on a tools-incapable
 * provider (the claude-code CLI is spawned --tools '' and would hallucinate tool
 * use — the exact spike gap, T-82-03-02). Given the resolved provider chain + a
 * capability predicate, returns the filtered capable-only chain, or a loud error
 * when none is capable. NEVER strips tools to fit an incapable provider.
 * @param {string[]} chain
 * @param {boolean} wantsTools
 * @param {(p: string) => boolean} supportsFn
 * @returns {{ chain: string[], error: null | { type: string, message: string } }}
 */
export function gateToolCapableChain(chain, wantsTools, supportsFn) {
  if (!wantsTools) return { chain: chain || [], error: null };
  const capable = (chain || []).filter(p => supportsFn(p));
  if (capable.length === 0) {
    return {
      chain: [],
      error: {
        type: 'NO_TOOL_CAPABLE_PROVIDER',
        message: `tools[] requested but no function-calling-capable provider is available (chain: [${(chain || []).join(' > ')}]; the claude-code CLI is spawned --tools '' and cannot serve tool calls)`,
      },
    };
  }
  return { chain: capable, error: null };
}

/**
 * Collapse a buffered Copilot chat-completion body into the { content, toolCalls }
 * pair the provider leg returns.
 *
 * The enterprise Copilot bridge maps an Anthropic response's content blocks onto
 * SEPARATE choices rather than onto one message. A turn that narrates before
 * acting arrives as:
 *
 *   choices[0] = { message: { content: "I'll check the weather..." } }
 *   choices[1] = { message: { tool_calls: [ get_weather(...) ] } }
 *
 * with both entries carrying finish_reason 'tool_calls'. That is not what the
 * OpenAI wire means by multiple choices (there they are alternatives, n>1), but
 * it is what the endpoint sends — verified live against copilot-api.<tenant>.ghe.com,
 * including with tool_choice pinned to a function, where the model cannot have
 * answered in prose.
 *
 * Reading only choices[0] discarded the tool call of every turn whose model
 * wrote a sentence first and reported finish_reason 'stop', so the agent got a
 * complete, well-formed text turn and correctly ended it. Bare tool calls came
 * back as a single choice and worked, which made the failure look intermittent.
 *
 * `index` is stamped on each call because these buffered-shape objects are
 * re-emitted verbatim into an SSE `delta.tool_calls` by buildStreamDelta, where
 * OpenAI requires an index to key fragment accumulation; a buffered
 * message.tool_calls carries none.
 *
 * Pure and never-throws: a malformed body yields { content: '', toolCalls: undefined }.
 * @param {any} data a parsed OpenAI-shaped chat.completion body
 * @returns {{ content: string, toolCalls: any[] | undefined }}
 */
export function mergeCopilotChoices(data) {
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  const content = choices.map((c) => c?.message?.content || '').join('');
  const merged = choices.flatMap((c) => (
    Array.isArray(c?.message?.tool_calls) ? c.message.tool_calls : []
  ));
  return {
    content,
    toolCalls: merged.length > 0 ? merged.map((tc, i) => ({ index: i, ...tc })) : undefined,
  };
}

/**
 * True when an OpenAI-shaped message content is a block list carrying at least
 * one non-text part (today: image_url, input_audio, file).
 * @param {any} content
 */
export function hasNonTextParts(content) {
  return Array.isArray(content) && content.some((p) => p && p.type && p.type !== 'text');
}

/**
 * Reduce OpenAI array-form content to a plain string, for provider legs that
 * can only accept a string (the claude-code CLI templates it, the Anthropic
 * leg builds its own message shape).
 *
 * Non-text parts cannot survive that reduction, so they are replaced by a short
 * visible marker rather than deleted. Silently dropping them is what made an
 * attached image look to the model like a message that never had one, so it
 * reported "image input isn't supported" as if that were a property of the
 * session. A marker lets the model say what actually happened.
 *
 * Pure and never-throws. A string passes through untouched.
 * @param {any} content
 * @returns {any}
 */
export function flattenContentToText(content) {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (typeof part?.text === 'string') return part.text;
    if (part?.type === 'image_url') return '[image omitted: this provider is text-only]';
    if (part?.type) return `[${part.type} omitted: this provider is text-only]`;
    return '';
  }).join('');
}

// ── Outbound OpenAI-wire tool passthrough ────────────────────────────────────
//
// The helpers above cover the INBOUND direction: an OpenAI-shaped request
// arriving at the shim, and the envelope we hand back to it. These two cover the
// OUTBOUND leg — the buffered POST completeOpenAICompatible() makes to a plain
// OpenAI-compatible provider (openai, groq, a self-hosted server, and provider modules).
//
// That leg used to build its request body from a fixed six-field list and read
// back only `choices[0].message.content`, so tools[] was silently dropped and a
// tool call could never come back. Only the Copilot leg (readCopilotStream /
// mergeCopilotChoices) produced result.toolCalls. That made `openai`'s
// `capabilities.tools: true` in llm-routing.yaml a mis-declaration: the capability
// gate in llm-fallback.yaml exists precisely to keep a tools-bearing request off a
// provider that would drop the tools and answer in prose, and it was letting one
// through. Fixing the leg is the honest repair — narrowing the declaration would
// have left no OpenAI-wire provider able to serve tools at all.

/**
 * The tool fields to forward onto an outbound OpenAI-compatible request body.
 * Returns ONLY what is present, so a tool-less request produces `{}` and the
 * outbound body stays byte-identical to what it was before this existed.
 * @param {any} body internal /api/complete envelope
 * @returns {{ tools?: unknown[], tool_choice?: unknown }}
 */
export function outboundToolFields(body) {
  const out = {};
  if (body && Array.isArray(body.tools) && body.tools.length > 0) out.tools = body.tools;
  if (body && body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
  return out;
}

/**
 * Normalize a buffered response's `message.tool_calls` into the same shape the
 * streamed Copilot path produces, so buildBufferedChoice / buildStreamDelta
 * cannot tell the two legs apart.
 *
 * Renumbered to a 0-based contiguous sequence for the same reason
 * mergeCopilotChoices does it: `index` is an array position to the client, and a
 * provider that numbers tool calls after a text block leaves a hole at 0.
 * Order is preserved. Returns undefined (not []) when there are none, so the
 * caller can spread it conditionally and keep tool-less results unchanged.
 *
 * @param {unknown} rawToolCalls value of message.tool_calls
 * @returns {Array<{index:number,id?:string,type:string,function:{name:string,arguments:string}}> | undefined}
 */
export function normalizeToolCalls(rawToolCalls) {
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) return undefined;
  return rawToolCalls.map((tc, i) => {
    const fn = (tc && tc.function) || {};
    // `arguments` is a JSON *string* on the wire. A provider that returns it
    // pre-parsed would otherwise reach the client as "[object Object]".
    const args = typeof fn.arguments === 'string'
      ? fn.arguments
      : JSON.stringify(fn.arguments === undefined ? {} : fn.arguments);
    const out = {
      index: i,
      type: (tc && tc.type) || 'function',
      function: { name: fn.name || '', arguments: args },
    };
    if (tc && tc.id) out.id = tc.id;
    return out;
  });
}
