// proxy-bridge/context-capture.mjs
//
// What one request puts into the model's context window, measured off the wire
// body: the per-category byte split (system / tools / knowledge / history /
// tool outputs / user input), the prompt-cache boundary, and the bounded
// drill-down detail the dashboard opens per category. Plus the gate that keeps a
// leaked main-session request out of an experiment run's capture.
//
// Pure — no I/O, no daemon state — so the tap (proxy-bridge/measurement.mjs) and
// anything else that holds a request body can use it without server.mjs, which
// listens on import.
//
// Compute the REAL per-category size of one Anthropic /v1/messages request body
// (system / tools / knowledge-injection / history / tool-outputs / user-input),
// plus the actual prompt-cache boundary (the byte offset up to & including the
// last cache_control block). Pure + defensive: any failure is swallowed by the
// caller so it can NEVER break request forwarding. Sizes are exact UTF-8 bytes;
// token counts are a labelled ~bytes/4 estimate (the true per-turn token split
// is already captured in token_usage). The snapshot the dashboard reads shows
// the ACTUAL wire buffer this session sent — not an illustrative guess.

import { createHash } from 'node:crypto';

// SPAN-LEAKAGE GUARD (Phase 78): the proxy shares ONE ambient active-measurement
// slot between the interactive main session and a measured experiment cell, so a
// main-session request can resolve a cell's task_id and clobber its capture via
// keep-largest. Gate the capture by the run's IDENTITY encoded in the composite
// task_id (`<exp>--<agent>-<model>-<framework>-<env>--r<n>`): a /v1/messages
// request only belongs to a CLAUDE run; a /v1/chat/completions request to a
// non-claude run; and within an agent the request's model family must match the
// run's. Non-experiment task_ids (live sessions, no `--`) bypass the gate.
const _FAMILY_RE = /opus|sonnet|haiku|gpt|codex|gemini|llama|mistral/;
function runIdentityFromTaskId(taskId) {
  if (!taskId || !taskId.includes('--')) return { agent: null, family: null };
  const variant = taskId.split('--')[1] || '';
  const agentMatch = variant.match(/^(claude|opencode|copilot|mastra)/);
  const famMatch = variant.match(_FAMILY_RE);
  return { agent: agentMatch ? agentMatch[1] : null, family: famMatch ? famMatch[0] : null };
}
function modelFamily(model) {
  const m = String(model || '').toLowerCase().match(_FAMILY_RE);
  return m ? m[0] : null;
}
/**
 * @param {string} taskId resolved task_id for the request
 * @param {string} model  request model
 * @param {'anthropic'|'openai'} endpoint which tap produced this request
 * @returns {boolean} true iff the request plausibly BELONGS to that run (so its
 *   capture may be persisted). Rejects a leaked main-session request whose agent
 *   or model doesn't match the run the task_id names.
 */
export function captureBelongsToRun(taskId, model, endpoint) {
  const { agent, family } = runIdentityFromTaskId(taskId);
  if (agent === null && family === null) return true; // non-experiment / live session
  // Endpoint↔agent: claude uses /v1/messages; opencode/mastra/copilot use the shim.
  if (endpoint === 'anthropic' && agent && agent !== 'claude') return false;
  if (endpoint === 'openai' && agent === 'claude') return false;
  // Model family must match when both are known (rejects an opus main session
  // leaking into a sonnet/haiku cell).
  const reqFam = modelFamily(model);
  if (family && reqFam && family !== reqFam) return false;
  return true;
}

// --- Per-category DRILL-DOWN detail (Phase 85: context-window sub-modals) ---
// The dashboard's run-explanation modal lets the operator click a context-window
// category to see WHAT concretely went to the LLM. These helpers build a bounded
// `detail` payload per category from the SAME parsed wire buffer the byte-split
// uses (no second parse). Everything is pure + defensive: a throw is swallowed by
// the caller so it can NEVER break request forwarding.
const DETAIL_PREVIEW_CAP = 2000; // chars per preview — bounds the snapshot
const DETAIL_MAX_ITEMS = 200;    // hard cap on tool/history items (NASA rule 02)
const _encBytes = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? ''), 'utf8');
const _preview = (s, cap = DETAIL_PREVIEW_CAP) => {
  const str = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  return str.length > cap ? str.slice(0, cap) + `\n… [+${str.length - cap} chars]` : str;
};

// Split the full system text into { header, text } sections at each markdown
// header, preserving any preamble before the first header (e.g. the billing
// header + "You are Claude Code…") as an "(intro)" section so it is also a jump
// target. Each body is bounded (SECTION_BODY_CAP) to keep the payload sane on a
// pathological prompt; the section count is bounded to match the header cap.
const SECTION_BODY_CAP = 20000;
function _splitSystemSections(fullText) {
  const text = typeof fullText === 'string' ? fullText : '';
  if (!text) return [];
  const re = /^#{1,4}\s+.+$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    marks.push({ header: m[0].trim(), start: m.index });
    if (marks.length >= 60) break;
  }
  const clip = (s) => (s.length > SECTION_BODY_CAP ? s.slice(0, SECTION_BODY_CAP) + `\n… [+${s.length - SECTION_BODY_CAP} chars]` : s);
  const out = [];
  if (!marks.length) return [{ header: '(intro)', text: clip(text.replace(/\s+$/, '')) }];
  if (marks[0].start > 0) {
    const pre = text.slice(0, marks[0].start).replace(/\s+$/, '');
    if (pre.trim()) out.push({ header: '(intro)', text: clip(pre) });
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    out.push({ header: marks[i].header, text: clip(text.slice(marks[i].start, end).replace(/\s+$/, '')) });
  }
  return out;
}

// System-instruction summary is MEMOIZED by content hash: the system prompt is
// stable across turns, so we compute the structural summary ONCE per unique hash
// and return the cached object thereafter (the "needs cached, don't regenerate
// every check" requirement). Bounded LRU-ish: evict oldest when > 256 entries.
const _sysSummaryCache = new Map();
function summarizeSystemText(fullText, blocks) {
  const hash = createHash('sha256').update(fullText || '').digest('hex').slice(0, 16);
  const cached = _sysSummaryCache.get(hash);
  if (cached) { cached.cached = true; return cached; }
  // Structural (deterministic) summary — markdown section headers + sizes. NOT an
  // LLM call (this is the request hot path); stable + reproducible per hash.
  const headers = (fullText.match(/^#{1,4}\s+.+$/gm) || []).slice(0, 60).map((h) => h.trim());
  const summary = {
    hash,
    cached: false,
    total_chars: fullText.length,
    total_bytes: _encBytes(fullText),
    block_count: blocks.length,
    section_headers: headers,
    // FULL per-section bodies so the dashboard can render every section as a
    // jump-to-content anchor (the 2 KB `preview` below truncates past the 2nd
    // header, leaving the rest of the section list pointing at text the client
    // never received). Memoized by hash + on-demand, so shipping the full ~12 KB
    // here is cheap; each body is still bounded to guard a pathological prompt.
    sections: _splitSystemSections(fullText),
    preview: _preview(fullText),
    blocks: blocks.slice(0, DETAIL_MAX_ITEMS).map((b) => ({ chars: b.chars, cached: b.cached, preview: _preview(b.text, 400) })),
  };
  if (_sysSummaryCache.size >= 256) _sysSummaryCache.delete(_sysSummaryCache.keys().next().value);
  _sysSummaryCache.set(hash, summary);
  return summary;
}

// Build the { [categoryKey]: detail } map from collected raw pieces. `tools` lists
// the CONCRETE tool definitions sent (name, description preview, input-schema keys,
// bytes); `sys` embeds the memoized system summary; `know` the real injected text;
// hist/tout/user carry a bounded sample of blocks so the operator sees actual content.
function buildCategoryDetails({ toolDefs, sysText, sysBlocks, knowledgeText, knowledgeOccurrences, samples }) {
  const detail = {};
  detail.tools = {
    count: toolDefs.length,
    items: toolDefs.slice(0, DETAIL_MAX_ITEMS).map((t) => ({
      name: t.name,
      bytes: t.bytes,
      description: _preview(t.description, 600),
      input_schema_keys: t.schemaKeys,
    })),
  };
  detail.sys = summarizeSystemText(sysText, sysBlocks);
  detail.know = { text: knowledgeText, occurrences: knowledgeOccurrences };
  for (const key of ['hist', 'tout', 'user']) {
    const arr = samples[key] || [];
    detail[key] = {
      count: arr.length,
      items: arr.slice(0, DETAIL_MAX_ITEMS).map((s) => ({ role: s.role, bytes: s.bytes, preview: _preview(s.text, 800) })),
    };
  }
  return detail;
}

export function analyzeAnthropicRequest(reqJson) {
  const enc = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? ''), 'utf8');
  const cats = { sys: 0, tools: 0, know: 0, hist: 0, tout: 0, user: 0 };
  // Drill-down collectors (Phase 85): concrete pieces per category for the modal.
  const toolDefs = [];
  const sysBlocks = [];
  let sysText = '';
  const samples = { hist: [], tout: [], user: [] };
  let totalBytes = 0;
  let cursor = 0;
  let cachePrefixBytes = 0;
  let cacheBreakpoints = 0;
  // The knowledge-injection hook prepends a block whose SIGNATURE is
  // "## Working Memory\n**Project:** …". Match the structure, NOT a bare
  // "## Working Memory" mention — otherwise ordinary chat text that discusses
  // the block (this very conversation does) is a false positive and gets
  // miscounted as Retrieved Knowledge / captured instead of the real injection.
  const KB_RE = /##\s+Working Memory\s*\r?\n\s*\*\*Project:\*\*/;
  const bump = (cat, bytes, hasCC) => {
    cats[cat] += bytes; totalBytes += bytes; cursor += bytes;
    if (hasCC) { cacheBreakpoints++; cachePrefixBytes = cursor; }
  };

  // Capture the ACTUAL injected knowledge text so the dashboard can show what
  // really went in (not just the schema). The hook fires per USER-PROMPT-SUBMIT,
  // so each user prompt in the retained history carries one block — we count
  // occurrences (= injections still in the buffer) and keep the MOST RECENT
  // block's text (capped) as the representative "what got retrieved this prompt".
  let knowledgeText = null;
  let knowledgeOccurrences = 0;
  const KB_CAP = 8000; // chars — plenty for a ~1k-token block, bounds the snapshot
  const captureKb = (text) => {
    if (typeof text !== 'string') return;
    // A single text block may bundle several system-reminders; slice from the
    // FIRST "## Working Memory" to the end of that block (the injected markdown).
    const idx = text.search(KB_RE);
    if (idx === -1) return;
    knowledgeOccurrences++;
    knowledgeText = text.slice(idx, idx + KB_CAP); // most-recent wins (loop order)
  };

  // system: string | block[]
  const sys = reqJson.system;
  if (typeof sys === 'string') { bump('sys', enc(sys), false); sysText += sys; sysBlocks.push({ chars: sys.length, cached: false, text: sys }); }
  else if (Array.isArray(sys)) {
    for (const b of sys) {
      const isKnow = typeof b?.text === 'string' && KB_RE.test(b.text);
      if (isKnow) captureKb(b.text);
      else if (typeof b?.text === 'string') { sysText += (sysText ? '\n\n' : '') + b.text; sysBlocks.push({ chars: b.text.length, cached: !!b?.cache_control, text: b.text }); }
      bump(isKnow ? 'know' : 'sys', enc(b), !!b?.cache_control);
    }
  }

  // tools[]
  if (Array.isArray(reqJson.tools)) {
    for (const t of reqJson.tools) {
      toolDefs.push({
        name: t?.name ?? '(unnamed)',
        bytes: enc(t),
        description: typeof t?.description === 'string' ? t.description : '',
        schemaKeys: t?.input_schema?.properties ? Object.keys(t.input_schema.properties) : [],
      });
      bump('tools', enc(t), !!t?.cache_control);
    }
  }

  // messages[] — categorise each content block; the LAST user message's text is
  // the fresh input, everything earlier is history, tool_result = tool outputs.
  const msgs = Array.isArray(reqJson.messages) ? reqJson.messages : [];
  const lastIdx = msgs.length - 1;
  msgs.forEach((m, i) => {
    // The LAST user message is the fresh input this turn (a text prompt OR the
    // tool_result that just came back) — classify it as 'user' FIRST so the
    // newest input doesn't leak into the historical tool-outputs bucket.
    const isLastUser = i === lastIdx && m?.role === 'user';
    const content = m?.content;
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
    for (const b of blocks) {
      const bytes = enc(b);
      const hasCC = !!b?.cache_control;
      const btext = typeof b?.text === 'string' ? b.text : (b?.type === 'tool_result' ? (typeof b?.content === 'string' ? b.content : JSON.stringify(b?.content ?? '')) : JSON.stringify(b ?? ''));
      if (isLastUser) { bump('user', bytes, hasCC); samples.user.push({ role: m?.role, bytes, text: btext }); continue; }
      if (b?.type === 'tool_result') { bump('tout', bytes, hasCC); samples.tout.push({ role: 'tool', bytes, text: btext }); continue; }
      if (typeof b?.text === 'string' && KB_RE.test(b.text)) { captureKb(b.text); bump('know', bytes, hasCC); continue; }
      bump('hist', bytes, hasCC); samples.hist.push({ role: m?.role, bytes, text: btext });
    }
  });

  const LABELS = {
    sys: 'System Instructions', tools: 'Tool Descriptions', know: 'Retrieved Knowledge',
    hist: 'Conversation History', tout: 'Tool Outputs', user: 'User Input',
  };
  // The reused prefix = everything EXCEPT this turn's fresh input. That is the
  // honest "read from cache vs new this turn" split for a long agentic session —
  // far more informative than the raw cache_control offset (Claude marks a
  // breakpoint on the last block, so that offset is ≈100%). We still report the
  // real cache_control breakpoint COUNT for reference.
  void cachePrefixBytes;
  const reusedPrefixBytes = Math.max(0, totalBytes - cats.user);
  // Build the drill-down detail map (never-throw: a failure here must not break
  // the byte-split the dashboard already relies on).
  let catDetails = {};
  try {
    catDetails = buildCategoryDetails({ toolDefs, sysText, sysBlocks, knowledgeText, knowledgeOccurrences, samples });
  } catch (e) { catDetails = { _error: String(e && e.message || e) }; }
  // Phase 84-04 (RESEARCH Open-Q 2): in addition to the cache_control COUNT
  // above (which existing consumers rely on), emit the MESSAGE indices that
  // carry a cache_control marker (D-08 breakpoints-as-indices). Pure/never-throw.
  const cacheBreakpointIndices = [];
  msgs.forEach((m, i) => {
    const content = m?.content;
    const blocks = Array.isArray(content) ? content : [];
    if (blocks.some((b) => b && b.cache_control)) cacheBreakpointIndices.push(i);
  });
  return {
    total_bytes: totalBytes,
    est_tokens: Math.round(totalBytes / 4),
    cacheable_prefix_bytes: reusedPrefixBytes,
    fresh_input_bytes: cats.user,
    cache_breakpoints: cacheBreakpoints,
    cache_breakpoint_indices: cacheBreakpointIndices,
    message_count: msgs.length,
    tool_count: Array.isArray(reqJson.tools) ? reqJson.tools.length : 0,
    // The REAL injected knowledge block (most-recent occurrence, capped) + how
    // many injections are still in the buffer. Cadence is per-user-prompt (a
    // UserPromptSubmit hook), so occurrences ≈ user prompts retained in history.
    knowledge_text: knowledgeText,
    knowledge_occurrences: knowledgeOccurrences,
    knowledge_cadence: 'per-prompt (UserPromptSubmit hook — once per user submission, then cached in history)',
    categories: ['sys', 'tools', 'know', 'hist', 'tout', 'user'].map((k) => ({ key: k, label: LABELS[k], bytes: cats[k], detail: catDetails[k] })),
  };
}

// OpenAI chat/completions variant (opencode / mastra route via the /v1/chat/
// completions shim). Same 6-category output as analyzeAnthropicRequest, but the
// wire shape differs: system prompt is a role:'system' message (no separate
// `system` field), tool results are role:'tool' messages, and tool defs live in
// `tools[]` (function-schema shape). No cache_control markers exist on this path
// (OpenAI format), so the prompt-cache prefix is reported as "everything except
// the fresh input" and cache_breakpoints is 0 — matching the observed
// opencode reality (no provider-side prompt cache on this route).
export function analyzeOpenAIRequest(oaBody) {
  const enc = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? ''), 'utf8');
  const cats = { sys: 0, tools: 0, know: 0, hist: 0, tout: 0, user: 0 };
  let totalBytes = 0;
  const KB_RE = /##\s+Working Memory\s*\r?\n\s*\*\*Project:\*\*/;
  let knowledgeText = null;
  let knowledgeOccurrences = 0;
  const KB_CAP = 8000;
  const bump = (cat, bytes) => { cats[cat] += bytes; totalBytes += bytes; };
  const toolDefs = [];
  const sysBlocks = [];
  let sysText = '';
  const samples = { hist: [], tout: [], user: [] };
  const textOf = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
    return '';
  };
  const captureKb = (text) => {
    const idx = typeof text === 'string' ? text.search(KB_RE) : -1;
    if (idx === -1) return;
    knowledgeOccurrences++;
    knowledgeText = text.slice(idx, idx + KB_CAP);
  };

  if (Array.isArray(oaBody.tools)) {
    for (const t of oaBody.tools) {
      bump('tools', enc(t));
      const fn = t && (t.function || t);
      toolDefs.push({
        name: fn?.name || '(unnamed)',
        bytes: enc(t),
        description: typeof fn?.description === 'string' ? fn.description : '',
        schemaKeys: fn?.parameters?.properties ? Object.keys(fn.parameters.properties) : [],
      });
    }
  }

  const msgs = Array.isArray(oaBody.messages) ? oaBody.messages : [];
  // Index of the last user message = this turn's fresh input.
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i]?.role === 'user') { lastUserIdx = i; break; } }
  msgs.forEach((m, i) => {
    const bytes = enc(m);
    const role = m?.role;
    const txt = textOf(m?.content);
    if (txt && KB_RE.test(txt)) { captureKb(txt); bump('know', bytes); return; }
    if (role === 'system') { bump('sys', bytes); sysText += (sysText ? '\n\n' : '') + txt; sysBlocks.push({ chars: txt.length, cached: false, text: txt }); return; }
    if (role === 'tool') { bump('tout', bytes); samples.tout.push({ role: 'tool', bytes, text: txt }); return; }
    if (i === lastUserIdx) { bump('user', bytes); samples.user.push({ role, bytes, text: txt }); return; }
    bump('hist', bytes); // assistant + earlier user turns
    samples.hist.push({ role, bytes, text: txt });
  });

  const LABELS = {
    sys: 'System Instructions', tools: 'Tool Descriptions', know: 'Retrieved Knowledge',
    hist: 'Conversation History', tout: 'Tool Outputs', user: 'User Input',
  };
  const reusedPrefixBytes = Math.max(0, totalBytes - cats.user);
  let catDetails = {};
  try {
    catDetails = buildCategoryDetails({ toolDefs, sysText, sysBlocks, knowledgeText, knowledgeOccurrences, samples });
  } catch (e) { catDetails = { _error: String(e && e.message || e) }; }
  return {
    total_bytes: totalBytes,
    est_tokens: Math.round(totalBytes / 4),
    cacheable_prefix_bytes: reusedPrefixBytes,
    fresh_input_bytes: cats.user,
    cache_breakpoints: 0,
    // Phase 84-04: OpenAI wire has no cache_control markers → no breakpoint indices.
    cache_breakpoint_indices: [],
    message_count: msgs.length,
    tool_count: Array.isArray(oaBody.tools) ? oaBody.tools.length : 0,
    knowledge_text: knowledgeText,
    knowledge_occurrences: knowledgeOccurrences,
    knowledge_cadence: 'per-prompt (UserPromptSubmit hook — once per user submission, then cached in history)',
    categories: ['sys', 'tools', 'know', 'hist', 'tout', 'user'].map((k) => ({ key: k, label: LABELS[k], bytes: cats[k], detail: catDetails[k] })),
  };
}
