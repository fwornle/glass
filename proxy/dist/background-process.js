/**
 * Background-daemon process identity (WIRE-03 span-leakage guard II, Phase 82-06).
 *
 * The `/api/complete` write path historically stamped `task_id` from the ambient
 * active-measurement span (`resolveLiveTaskId()`) for ANY caller that omitted an
 * explicit `body.task_id`. That fallback is correct for an interactive session
 * whose calls genuinely belong to the open span — but WRONG for the long-running
 * coding-side background daemons (the health coordinator, the consolidator
 * family, the observation writer, the token-adapter taps, the wave-analysis
 * workflow) which fire on their OWN cadence, unrelated to any measured
 * experiment cell. When a cell's span is the ambient span, those daemon calls
 * get their unrelated tokens stamped with the cell's `task_id` — the exact
 * cross-contamination Plan 82-02 killed on the `/v1/messages` tap, still
 * reproduced by the `/api/complete` ambient fallback.
 *
 * A cell's OWN agent calls always arrive with an EXPLICIT `body.task_id` (the
 * experiment runner sets `x-task-id` for claude and the `/v1/copilot/t/<id>`
 * task-scoped path / shim `X-Task-Id` for opencode & friends), so denying the
 * ambient fallback to these daemon processes can NEVER unbind a legitimate cell
 * row — it only stops a daemon from borrowing a cell's identity.
 *
 * Process identity is the discriminator: each coding-side daemon sets its
 * `process` field client-side on the `/api/complete` body. This is a DENYLIST,
 * not an allowlist — any unlisted process keeps the prior `resolveLiveTaskId()`
 * behaviour (backward compatible). Pure, never throws, no I/O.
 */
/**
 * Background daemon processes matched by EXACT name. These are long-lived
 * coding-side services that call the proxy on their own schedule and are never
 * part of a measured experiment cell.
 */
export const BACKGROUND_PROCESS_EXACT = new Set([
    'health-coordinator',
    'observation-writer',
]);
/**
 * Background daemon process FAMILIES matched by name prefix:
 *   - `consolidator-`  → consolidator-insight / -digest / -mentions
 *   - `token-adapter-` → token-adapter-claude / -copilot / -opencode
 *   - `wave-analysis-` → the UKB wave-analysis workflow steps
 */
export const BACKGROUND_PROCESS_PREFIXES = [
    'consolidator-',
    'token-adapter-',
    'wave-analysis-',
];
/**
 * True iff `procName` names a coding-side background daemon that must NOT
 * inherit the ambient measurement span's task_id on the `/api/complete`
 * fallback. A non-string / empty / unlisted process returns false (keeps the
 * legacy `resolveLiveTaskId()` behaviour).
 *
 * @param procName the request's `body.process` value (untrusted; coalesced).
 */
export function isBackgroundProcess(procName) {
    const p = typeof procName === 'string' ? procName.trim() : '';
    if (!p)
        return false;
    if (BACKGROUND_PROCESS_EXACT.has(p))
        return true;
    return BACKGROUND_PROCESS_PREFIXES.some((pre) => p.startsWith(pre));
}
