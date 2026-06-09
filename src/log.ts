/**
 * Opt-in lifecycle tracing, gated behind STATUS_BAR_PARAM_DEBUG=1 (off by default)
 * so it doesn't spam every user's console. Genuine errors go through console.error
 * directly and are intentionally not gated, so they stay visible for bug reports.
 */
export function debug(...args: unknown[]): void {
    // read the flag per-call so it can be toggled without reloading the module
    if (process.env.STATUS_BAR_PARAM_DEBUG) {
        console.debug(...args);
    }
}
