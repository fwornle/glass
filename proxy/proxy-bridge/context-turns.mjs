// proxy-bridge/context-turns.mjs
//
// Phase 84-04 — pure, never-throw helpers for the per-request context-turns
// JSONL line. Imported by BOTH server.mjs (the two write sites + the read route)
// and the coding-repo unit tests (tests/context-turns/*). This module has NO
// side effects on import (server.mjs itself starts an HTTP server on import, so
// the tests cannot import it directly — they import THIS module instead).
//
// Line contract (pinned by 84-04-PLAN <objective>):
//   { ts, task_id, agent, wire:'anthropic'|'openai', request_id, model,
//     usage:{ input, output, cache_read, cache_write },
//     cache_breakpoints:[msgIdx…], categories:[…],
//     messages:[{ i, role, bytes, tool:{name,size}|null, preview }],
//     observation_ref: null }
// OpenAI wire sets usage.cache_write === null (provider reports none → UI N/A, D-12).
import fs from 'node:fs';
import path from 'node:path';

const enc = (v) => {
  try { return Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? ''), 'utf8'); }
  catch { return 0; }
};

/** UTF-8 byte size of a message's payload (content, else the whole message). */
export function messageBytes(m) {
  const content = m?.content;
  if (content === undefined || content === null) return enc(m ?? '');
  return enc(content);
}

/**
 * Tool metadata for a message that carries a tool_use / tool_result (Anthropic
 * wire) or tool_calls / role:'tool' (OpenAI wire). Returns { name, size } or null.
 */
export function toolMeta(m) {
  try {
    // OpenAI wire: assistant tool_calls[] / role:'tool' result.
    if (Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      const tc = m.tool_calls[0];
      return { name: tc?.function?.name || tc?.name || 'tool_call', size: enc(tc) };
    }
    if (m?.role === 'tool') {
      return { name: m?.name || 'tool_result', size: enc(m?.content) };
    }
    // Anthropic wire: scan content blocks for the first tool_use / tool_result.
    const content = m?.content;
    const blocks = Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b?.type === 'tool_use') return { name: b?.name || 'tool_use', size: enc(b?.input ?? b) };
      if (b?.type === 'tool_result') return { name: 'tool_result', size: enc(b?.content) };
    }
    return null;
  } catch {
    return null;
  }
}

/** ≤`cap`-char single-line text preview of a message (D-07 fallback). */
export function shortPreview(m, cap = 120) {
  try {
    const textOf = (content) => {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((b) => {
            if (typeof b === 'string') return b;
            if (typeof b?.text === 'string') return b.text;
            if (b?.type === 'tool_use') return `[tool_use:${b?.name || ''}]`;
            if (b?.type === 'tool_result') {
              return typeof b?.content === 'string' ? b.content : JSON.stringify(b?.content ?? '');
            }
            return '';
          })
          .join(' ');
      }
      return '';
    };
    let s = textOf(m?.content);
    if (!s && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      s = `[tool_call:${m.tool_calls[0]?.function?.name || ''}]`;
    }
    s = String(s ?? '').replace(/\s+/g, ' ').trim();
    return s.length > cap ? s.slice(0, cap) : s;
  } catch {
    return '';
  }
}

/** Message indices that carry a cache_control marker (Anthropic wire). */
export function cacheBreakpointIndices(messages) {
  const out = [];
  const msgs = Array.isArray(messages) ? messages : [];
  msgs.forEach((m, i) => {
    const content = m?.content;
    const blocks = Array.isArray(content) ? content : [];
    if (blocks.some((b) => b && b.cache_control)) out.push(i);
  });
  return out;
}

/** Per-message digest array: { i, role, bytes, tool, preview }. */
export function mapMessages(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  return msgs.map((m, i) => ({
    i,
    role: m?.role ?? null,
    bytes: messageBytes(m),
    tool: toolMeta(m),
    preview: shortPreview(m, 120),
  }));
}

/**
 * Build one Anthropic-wire context-turns line from the /v1/messages request body
 * + the tapped usage split. Pure; the cache_breakpoints field carries the
 * message indices (D-08), never a bare count.
 */
export function buildAnthropicLine({ reqJson, taskId, agent, requestId, model, usage, categories }) {
  return {
    ts: new Date().toISOString(),
    task_id: taskId,
    agent: agent ?? '',
    wire: 'anthropic',
    request_id: requestId ?? '',
    model: model ?? 'unknown',
    usage: {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cache_read: usage?.cache_read ?? 0,
      cache_write: usage?.cache_write ?? 0,
    },
    cache_breakpoints: cacheBreakpointIndices(reqJson?.messages),
    categories: Array.isArray(categories) ? categories : [],
    messages: mapMessages(reqJson?.messages),
    observation_ref: null,
  };
}

/**
 * Build one OpenAI-wire context-turns line from the internal /api/complete body.
 * usage.cache_write is forced to null so the UI renders N/A (D-12 — parseOpenAICache
 * always reports 0; null signals "provider reports none", not "zero writes").
 */
export function buildOpenAILine({ internalBody, taskId, agent, requestId, model, usage, categories }) {
  return {
    ts: new Date().toISOString(),
    task_id: taskId,
    agent: agent ?? '',
    wire: 'openai',
    request_id: requestId ?? '',
    model: model ?? 'unknown',
    usage: {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cache_read: usage?.cache_read ?? 0,
      cache_write: null,
    },
    cache_breakpoints: [],
    categories: Array.isArray(categories) ? categories : [],
    messages: mapMessages(internalBody?.messages),
    observation_ref: null,
  };
}

/**
 * Best-effort synchronous append of one line to <dir>/context-turns.jsonl.
 * Never throws (a failure is swallowed — the caller is on a request hot path).
 * A falsy dir (empty/traversal task_id) is skipped so nothing lands at the
 * measurements root. Used by the unit tests; server.mjs mirrors this with an
 * async fire-and-forget variant on the hot path.
 */
export function appendContextTurn(dir, line) {
  try {
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'context-turns.jsonl'), JSON.stringify(line) + '\n');
  } catch {
    /* never-throw: best-effort */
  }
}
