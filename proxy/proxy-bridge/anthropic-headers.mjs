/**
 * Header construction for the /v1/messages Anthropic passthrough.
 *
 * Its own module because proxy-bridge/server.mjs calls server.listen() at import
 * time with no main guard — anything exported from there can never be imported
 * by a test without starting a real proxy on the port.
 */

/**
 * Build the header set forwarded by the /v1/messages Anthropic passthrough.
 *
 * Forwards verbatim minus hop-by-hop headers, forces identity encoding so the
 * SSE tap reads raw text, and injects the Max-OAuth bearer ONLY when the caller
 * sent no credential of its own (transparent otherwise).
 *
 * REGRESSION ANCHOR: `getToken()` returns the whole keychain RECORD
 * ({ accessToken, expiresAt, refreshToken, subscriptionType }), not a string.
 * The original inline version interpolated the record, emitting the literal
 * `Bearer [object Object]`; Anthropic answered 401 "Invalid bearer token", which
 * reads exactly like an expired or revoked subscription. The fault was invisible
 * from the outside because the sibling call site (completeClaudeCodeDirect)
 * reads `.accessToken` correctly — so the CLI-side Max path stayed healthy and
 * only credential-less callers were affected.
 *
 * @param {Record<string, string|string[]>} reqHeaders  incoming request headers
 * @param {() => ({accessToken?: string}|null|undefined)} getToken keychain accessor
 * @returns {Record<string, string|string[]>} headers to forward upstream
 */
export function buildAnthropicForwardHeaders(reqHeaders, getToken) {
  const HOP_BY_HOP = ['host', 'content-length', 'connection', 'accept-encoding'];
  const fwdHeaders = {};
  let hasAuth = false;
  for (const [k, v] of Object.entries(reqHeaders || {})) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.includes(lk)) continue;
    if (lk === 'authorization' || lk === 'x-api-key') hasAuth = true;
    fwdHeaders[k] = v;
  }
  fwdHeaders['accept-encoding'] = 'identity';
  if (!hasAuth) {
    const tok = getToken?.();
    if (tok?.accessToken) {
      fwdHeaders['authorization'] = `Bearer ${tok.accessToken}`;
      if (!fwdHeaders['anthropic-beta']) fwdHeaders['anthropic-beta'] = 'oauth-2025-04-20';
    }
  }
  return fwdHeaders;
}
