/**
 * Pure cache-usage extraction for the Anthropic /v1/messages wire (WIRE-02).
 *
 * The Anthropic Messages API surfaces prompt-cache accounting on the SAME
 * `usage` object that carries `input_tokens` / `output_tokens` — both in the
 * SSE `message_start.message.usage` frame and in the non-streaming JSON
 * response. Two wire shapes exist and BOTH must be handled:
 *
 *   1. Flat form (current):
 *        usage.cache_read_input_tokens      → cacheRead
 *        usage.cache_creation_input_tokens  → cacheWrite
 *   2. Object form (newer, breakpoint-typed cache-creation):
 *        usage.cache_creation = { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens, ... }
 *      In which cacheWrite is the SUM of the object's numeric sub-fields.
 *
 * Contract: this helper is PURE — no I/O, never throws. Every field is
 * coalesced to 0 when absent or non-numeric, so a malformed usage object can
 * never crash the proxy tap (STRIDE T-82-02-04). Cache counters are surfaced
 * SEPARATELY from `total_tokens` (which stays input+output) — the caller must
 * NOT fold these into the total (matches lib/lsl/token/token-db.mjs semantics).
 */
/** Coalesce any value to a finite non-negative-safe number, else 0. */
function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
/**
 * Extract `{ cacheRead, cacheWrite }` from an Anthropic `usage` object.
 * Handles the flat and `cache_creation`-object wire forms; never throws.
 *
 * @param usage the `usage` object off message_start / non-streaming JSON
 */
export function parseUsageCache(usage) {
    if (!usage || typeof usage !== 'object') {
        return { cacheRead: 0, cacheWrite: 0 };
    }
    const u = usage;
    const cacheRead = num(u.cache_read_input_tokens);
    let cacheWrite = 0;
    if (typeof u.cache_creation_input_tokens === 'number' && Number.isFinite(u.cache_creation_input_tokens)) {
        cacheWrite = u.cache_creation_input_tokens;
    }
    else if (u.cache_creation && typeof u.cache_creation === 'object') {
        for (const v of Object.values(u.cache_creation)) {
            cacheWrite += num(v);
        }
    }
    return { cacheRead, cacheWrite };
}
/**
 * Extract prompt-cache accounting from an OpenAI-wire `usage` object
 * (D-09 / IN-05). The OpenAI Chat Completions API surfaces cache reads on
 * `usage.prompt_tokens_details.cached_tokens`; there is NO cache-write field,
 * so `cache_write_tokens` is always 0. This is the shim/copilot/opencode
 * counterpart to {@link parseUsageCache} (the Anthropic tap helper).
 *
 * Contract mirrors parseUsageCache exactly: PURE — no I/O, never throws. Every
 * field is coalesced to 0 when absent or non-numeric, so a malformed `usage`
 * object can never crash the shim completion path (STRIDE T-83-02-01).
 *
 * IMPORTANT — this counter is NOT additive to `prompt_tokens`, unlike its
 * Anthropic counterpart. See {@link openAIFreshInputTokens}.
 *
 * @param usage the `usage` object off an OpenAI-compatible completion response
 */
export function parseOpenAICache(usage) {
    if (!usage || typeof usage !== 'object') {
        return { cache_read_tokens: 0, cache_write_tokens: 0 };
    }
    const u = usage;
    const details = u.prompt_tokens_details;
    let cacheRead = 0;
    if (details && typeof details === 'object') {
        cacheRead = num(details.cached_tokens);
    }
    // OpenAI has no cache-creation/write counter — always 0.
    return { cache_read_tokens: cacheRead, cache_write_tokens: 0 };
}
/**
 * Fresh (uncached) prompt tokens from an OpenAI-wire `usage` object.
 *
 * THE TWO WIRES DISAGREE, AND THIS IS WHERE THAT GETS RECONCILED.
 *
 *   Anthropic: `usage.input_tokens` counts ONLY fresh input. Cache reads are a
 *              separate, ADDITIVE counter (`cache_read_input_tokens`).
 *   OpenAI:    `usage.prompt_tokens` counts EVERYTHING sent, cache hits
 *              included. `prompt_tokens_details.cached_tokens` is a BREAKDOWN
 *              of that number, not an addition to it.
 *
 * Both files in this module have always documented the invariant "total_tokens
 * stays input+output, cache is separate" — and on the OpenAI path that
 * invariant was silently false, because the provider had already folded the
 * cache in before we looked at it. Nothing was folding it in on our side, which
 * is why the note telling callers not to fold it in did not prevent the bug.
 *
 * The consequence was that `total_tokens` meant different things per provider
 * and could not be summed or compared. Measured on 2026-08-29: a foreground
 * Claude Code turn on the Anthropic wire recorded 2 input + 824 output with
 * 470,512 cache reads — a `total_tokens` of 826 for what was really ~471K —
 * while an OpenAI-wire background classifier recorded 23,779 input of which
 * 23,265 were cache hits, and got the full 23,779 into its total. Aggregated
 * over 24h the dashboard therefore showed the background consolidator at 51.9M
 * tokens and intensive foreground Opus-5 work at 726K, understating the latter
 * by ~450x and inverting which one dominated.
 *
 * Subtracting here makes `input` mean fresh input on BOTH wires, so
 * `total_tokens` is finally the same quantity everywhere and the cache columns
 * are additive everywhere.
 *
 * Clamped at 0: a provider reporting more cached tokens than prompt tokens is
 * incoherent, and a negative token count would corrupt every downstream sum.
 *
 * @param usage the `usage` object off an OpenAI-compatible completion response
 */
export function openAIFreshInputTokens(usage) {
    if (!usage || typeof usage !== 'object')
        return 0;
    const u = usage;
    const prompt = num(u.prompt_tokens);
    const { cache_read_tokens: cached } = parseOpenAICache(usage);
    return Math.max(0, prompt - cached);
}
/**
 * Usage off an OpenAI Responses-API `usage` object ({input_tokens, output_tokens,
 * input_tokens_details.cached_tokens}), normalised like the chat wire: `input` is
 * FRESH input (cached tokens subtracted — see openAIFreshInputTokens), cache read
 * is separate and additive, OpenAI has no cache-write counter.
 *
 * PURE — no I/O, never throws; absent / non-numeric fields count 0.
 *
 * @param usage the `usage` object off a Responses-API response (or its
 *   `response.completed` event's `response.usage`)
 */
export function parseResponsesUsage(usage) {
    if (!usage || typeof usage !== 'object')
        return { input: 0, output: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    const u = usage;
    const details = u.input_tokens_details;
    const cached = details && typeof details === 'object' ? num(details.cached_tokens) : 0;
    return {
        input: Math.max(0, num(u.input_tokens) - cached),
        output: num(u.output_tokens),
        cache_read_tokens: cached,
        cache_write_tokens: 0,
    };
}
