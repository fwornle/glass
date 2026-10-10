// proxy-bridge/model-canonical.mjs — outbound model canonicalization (Phase 36-06).
//
// Collapse the various upstream spellings of the same underlying model into
// a single canonical key for the token-usage dashboard. Each provider
// (claude-code CLI, Copilot, Anthropic API) returns its own shape — dash-
// version, dot-version, title-case, dated-snapshot, bare alias — so without
// canonicalization the "By Model" panel showed 8 rows for what is really 3
// Claude models. The raw upstream value is preserved per row in `model_raw`
// so debugging "which snapshot did Copilot serve us?" stays possible.
//
// Recognized aliases collapse; unrecognized names pass through unchanged
// (defense against a new Anthropic snapshot appearing before the map is
// updated — the new variant becomes a visible row in the dashboard, NOT
// silent data corruption).
export const MODEL_CANONICAL_MAP = {
  // Sonnet 4.6 family
  'sonnet':                       'claude-sonnet-4.6',
  'claude-sonnet-4-6':            'claude-sonnet-4.6',
  'claude-sonnet-4.6':            'claude-sonnet-4.6',
  'claude sonnet 4.6':            'claude-sonnet-4.6',
  'claude-sonnet-4-20250514':     'claude-sonnet-4.6',
  // Haiku 4.5 family
  'haiku':                        'claude-haiku-4.5',
  'claude-haiku-4-5':             'claude-haiku-4.5',
  'claude-haiku-4.5':             'claude-haiku-4.5',
  'claude haiku 4.5':             'claude-haiku-4.5',
  'claude-haiku-4-5-20251001':    'claude-haiku-4.5',
  'claude-haiku-4-20250414':      'claude-haiku-4.5',
  // Opus family. The floating `opus` alias names the CURRENT generation; every
  // explicit 4.6 spelling below still collapses to claude-opus-4.6, because
  // 3,268 real rows carry it (Copilot, 2026-03-06..2026-07-26) and relabelling
  // them would rewrite history rather than fix it.
  'opus':                         'claude-opus-5',
  'claude-opus-4-6':              'claude-opus-4.6',
  'claude-opus-4.6':              'claude-opus-4.6',
  'claude opus 4.6':              'claude-opus-4.6',
  'claude-opus-4-20250514':       'claude-opus-4.6',
};

export function canonicalizeModelName(raw) {
  if (typeof raw !== 'string' || !raw) return raw;
  const key = raw.toLowerCase().trim();
  return MODEL_CANONICAL_MAP[key] || raw;
}
