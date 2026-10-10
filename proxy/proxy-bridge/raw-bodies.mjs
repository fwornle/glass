// proxy-bridge/raw-bodies.mjs
//
// Phase 84, Plan 84-06 — flag-gated full raw request/response body capture at
// the proxy, the phase's single highest-value secret-leak surface (D-05/D-06).
//
// This is a PURE, side-effect-free sibling of server.mjs (server.mjs boots an
// HTTP server on import and cannot be imported by a unit test — mirror of the
// Plan 04 context-turns.mjs extraction). The coding-repo test imports THIS
// module cross-repo and exercises the REAL production redaction + append path.
//
// Security contract (threat register T-84-06-01..04):
//   - Every raw body is redacted via the 27-pattern configured set BEFORE write,
//     compiled from ONE config file — LLM_PROXY_REDACTION_CONFIG, else the coding
//     repo's config/redaction/redaction-patterns.json — with the same field
//     mapping as coding's loadRedactionPatterns (scripts/enhanced-redaction-system.cjs;
//     parity is asserted by coding's tests/redaction/proxy-raw-body.test.mjs).
//   - Redaction is fail-closed on CONTENT: any error yields
//     '[REDACTION_ERROR_CONTENT_BLOCKED]' in place of the body — but NEVER throws
//     (a redaction error must not crash the proxy daemon).
//   - Capture is default OFF; a body is only ever appended when the per-span flag
//     span.meta.capture_raw_bodies === true (rawBodyCaptureEnabled).
//   - Raw bodies land in a SEPARATE raw-bodies.jsonl sibling so retention (Plan
//     03 sweeper) can drop them independently of the always-on context-turns.
import fs from 'node:fs';
import path from 'node:path';

// Same field mapping as coding's loadRedactionPatterns: { id, re: new RegExp(pattern,
// flags), replacement }, enabled patterns only, compile-guarded (skip a bad pattern
// with a stderr note). No cross-repo require — glass ships this file without coding.
function compileRedactionPatterns(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (cfg.enabled === false) return [];
  return (cfg.patterns || [])
    .filter((p) => p.enabled)
    .map((p) => {
      try {
        return { id: p.id, re: new RegExp(p.pattern, p.flags), replacement: p.replacement };
      } catch (e) {
        process.stderr.write(`[redaction] bad pattern ${p.id}: ${e.message}\n`);
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Compile the redaction pattern set from its single config file. Never throws —
 * returns [] on any failure so redactRawBody fail-closes to content-blocked
 * (fail-closed on content, never on the daemon).
 *
 * @param {string} codingRoot - absolute path to the coding repo root
 * @param {string} [configPath] - override (LLM_PROXY_REDACTION_CONFIG); defaults to
 *   <codingRoot>/config/redaction/redaction-patterns.json
 * @returns {{ id: string, re: RegExp, replacement: string }[]}
 */
export function loadRawBodyRedactionPatterns(codingRoot, configPath) {
  try {
    return compileRedactionPatterns(
      configPath || path.join(codingRoot, 'config', 'redaction', 'redaction-patterns.json'),
    );
  } catch (e) {
    process.stderr.write(`[redaction] raw-body pattern load failed: ${e?.message || e}\n`);
    return [];
  }
}

/**
 * Build a fail-closed redactor bound to a compiled pattern list. Applies the
 * patterns in order; ANY error (including a non-stringifiable input) returns
 * '[REDACTION_ERROR_CONTENT_BLOCKED]'. NEVER throws.
 *
 * @param {{ re: RegExp, replacement: string }[]} patterns
 * @returns {(str: unknown) => string}
 */
export function makeRedactRawBody(patterns) {
  return function redactRawBody(str) {
    try {
      let out = typeof str === 'string' ? str : String(str);
      for (const { re, replacement } of patterns) {
        out = out.replace(re, replacement);
      }
      return out;
    } catch {
      return '[REDACTION_ERROR_CONTENT_BLOCKED]';
    }
  };
}

/**
 * The per-span default-OFF gate. Raw bodies are captured ONLY when the active
 * measurement span carries meta.capture_raw_bodies === true. A missing span,
 * missing meta, or any non-`true` value → false (a non-consenting span never
 * persists raw bodies, T-84-06-02).
 *
 * @param {{ meta?: { capture_raw_bodies?: unknown } } | null | undefined} span
 * @returns {boolean}
 */
export function rawBodyCaptureEnabled(span) {
  return span?.meta?.capture_raw_bodies === true;
}

/**
 * Best-effort, never-throw append of ONE raw-bodies JSONL line to the SEPARATE
 * raw-bodies.jsonl sibling under the measurements dir. A falsy dir (empty/
 * traversal task_id) is skipped so nothing lands at the measurements root.
 * Returns a Promise that RESOLVES (never rejects) to true on a successful write,
 * false otherwise — server.mjs calls it fire-and-forget (ignores the result);
 * the unit test awaits it for determinism.
 *
 * The `line` passed here MUST already carry redacted request/response fields —
 * redaction is applied by the caller BEFORE the object is built (never here).
 *
 * @param {string} dir
 * @param {object} line
 * @returns {Promise<boolean>}
 */
export function appendRawBody(dir, line) {
  return new Promise((resolve) => {
    try {
      if (!dir) return resolve(false);
      fs.mkdir(dir, { recursive: true }, (e1) => {
        if (e1) return resolve(false);
        fs.appendFile(
          path.join(dir, 'raw-bodies.jsonl'),
          JSON.stringify(line) + '\n',
          (e2) => resolve(!e2),
        );
      });
    } catch {
      resolve(false);
    }
  });
}
