/**
 * The Workers runtime refuses fetch() called as a method of another object
 * ("TypeError: Illegal invocation"). Classes keep this wrapper instead of the bare global
 * fetch, so `this.fetcher(...)` always calls fetch unbound. Found on staging 15 Nov 2026:
 * every email (and every real provider call) failed before leaving the Worker.
 */
export const workerFetch: typeof fetch = (input, init) => fetch(input, init);
