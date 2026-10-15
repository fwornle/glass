// proxy-bridge/no-proxy.mjs
//
// Which outbound URLs must NOT go through the corporate HTTPS proxy.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// server.mjs installs an undici ProxyAgent as soon as HTTPS_PROXY is set and then
// sends EVERY request through it. That was fine while every provider was on the
// public internet. It stops being fine the moment a provider lives on the
// corporate LAN: a self-hosted model server there is reachable ONLY on
// the corporate network — which is exactly the network on which HTTPS_PROXY is
// set — so without a bypass every call to it would be tunnelled through
// corp-proxy:8080 and fail.
//
// bin/start-llm-proxy.sh already exports NO_PROXY=localhost,127.0.0.1,::1, and
// the ProxyAgent ignores it: undici has no NO_PROXY support. This module is the
// missing half. config/agents/opencode.sh carries the agent-side version of the
// same workaround (CODING_OPENCODE_NO_PROXY), which is the precedent.
//
// PURE — takes the env value as an argument so it is testable without touching
// process.env.

/** RFC1918 + loopback + link-local + CGNAT. Private space is never proxied. */
function isPrivateHost(host) {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (/\.local$/i.test(host)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, Number(m[2]), Number(m[3]), Number(m[4])].some(n => n > 255)) return false;
  if (a === 127 || a === 10) return true;                 // loopback, 10/8
  if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16/12
  if (a === 192 && b === 168) return true;                 // 192.168/16
  if (a === 169 && b === 254) return true;                 // link-local
  if (a === 100 && b >= 64 && b <= 127) return true;        // CGNAT 100.64/10
  return false;
}

/**
 * Parse a NO_PROXY value into comparable entries. Accepts the usual spellings:
 * comma or whitespace separated, optional leading dot, optional :port, and the
 * wildcard `*` meaning "bypass everything".
 * @param {string} [noProxy]
 */
export function parseNoProxy(noProxy) {
  return String(noProxy || '')
    .split(/[,\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .map(entry => {
      if (entry === '*') return { wildcard: true };
      const withoutPort = entry.replace(/:\d+$/, '');
      return { host: withoutPort.replace(/^\./, ''), suffix: withoutPort.startsWith('.') };
    });
}

/**
 * True when `url` must be fetched directly, bypassing HTTPS_PROXY.
 *
 * Bypasses on either ground:
 *   • the host is in NO_PROXY (exact, or a `.suffix` / bare-domain suffix match)
 *   • the host is a private/loopback address — a corporate proxy cannot route
 *     RFC1918 space, so proxying it can only ever fail
 *
 * Never throws: an unparseable URL is reported as "do not bypass", which keeps
 * today's behaviour for anything unexpected.
 *
 * @param {string} url
 * @param {string} [noProxy] the NO_PROXY env value
 * @returns {boolean}
 */
export function shouldBypassProxy(url, noProxy) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  const bare = host.replace(/^\[|\]$/g, '');
  if (isPrivateHost(bare)) return true;
  for (const e of parseNoProxy(noProxy)) {
    if (e.wildcard) return true;
    if (!e.host) continue;
    if (bare === e.host) return true;
    if (bare.endsWith(`.${e.host}`)) return true;
  }
  return false;
}
