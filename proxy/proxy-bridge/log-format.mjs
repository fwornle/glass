// proxy-bridge/log-format.mjs
//
// Two things the proxy's logs lacked on 2026-10-24, when a laptop lost all
// egress after a wake from sleep and stayed that way for half an hour:
//
//   - WHEN. stdout.log and stderr.log had no time on any line, so the outage
//     could only be dated from the token DB and the health coordinator's log.
//   - WHY. Every upstream failure read `fetch failed`. undici puts the reason
//     — ENOTFOUND, ECONNREFUSED, a connect timeout — on err.cause (and, when it
//     tried several addresses, on an AggregateError's .errors), and nothing
//     printed it. Offline, DNS and a refused port all looked the same.
//
// PURE apart from stampLines, which wraps the stream it is given.

const STAMPED = Symbol.for('llm-proxy.log-stamped');

/** One error's own text: its message, with the code in front when the message lacks it. */
function describe(e) {
  const msg = typeof e.message === 'string' ? e.message : '';
  const code = typeof e.code === 'string' && !msg.includes(e.code) ? e.code : '';
  return [code, msg].filter(Boolean).join(' ');
}

/**
 * An error as one log string: its message, then every distinct cause under it.
 *
 *   fetch failed (cause: getaddrinfo ENOTFOUND api.anthropic.com)
 *   fetch failed (cause: UND_ERR_CONNECT_TIMEOUT Connect Timeout Error (attempted address: …))
 *
 * Follows err.cause and AggregateError .errors, five levels at most; repeated
 * texts are printed once. A non-Error is String()ed.
 * @param {unknown} err
 * @returns {string}
 */
export function errorDetail(err) {
  if (err === null || typeof err !== 'object') return String(err);
  const head = describe(err) || String(err);
  const seen = new Set([head]);
  const causes = [];
  const visit = (e, depth) => {
    if (!e || typeof e !== 'object' || depth > 5) return;
    if (depth > 0) {
      const text = describe(e);
      if (text && !seen.has(text)) { seen.add(text); causes.push(text); }
    }
    if (Array.isArray(e.errors)) for (const sub of e.errors) visit(sub, depth + 1);
    visit(e.cause, depth + 1);
  };
  visit(err, 0);
  return causes.length ? `${head} (cause: ${causes.join('; ')})` : head;
}

/**
 * Prefix every line written to `stream` with an ISO-8601 UTC timestamp — the
 * format the health coordinator's log uses, so the two read side by side.
 * Covers every writer in the process (console.*, process.stdout.write, the
 * compiled TypeScript providers), not only the proxy's own log helpers. A line
 * written in several pieces is stamped once, at its start. Idempotent.
 * @param {NodeJS.WriteStream} stream
 * @param {() => Date} [now]
 */
export function stampLines(stream, now = () => new Date()) {
  if (stream[STAMPED]) return;
  stream[STAMPED] = true;
  const write = stream.write.bind(stream);
  let atLineStart = true;
  stream.write = (chunk, encoding, cb) => {
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (!text) return write(chunk, encoding, cb);
    const ts = `${now().toISOString()} `;
    let out = '';
    for (const part of text.split(/(?<=\n)/)) {
      if (atLineStart) out += ts;
      out += part;
      atLineStart = part.endsWith('\n');
    }
    return write(out, 'utf8', cb);
  };
}
