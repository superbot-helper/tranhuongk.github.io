/// <reference types="vite/client" />

/**
 * Worker pipe endpoint (not a secret; the Worker needs no token).
 * PLACEHOLDER: the repo owner fills this in with the `*.workers.dev` URL (as `wss://...`)
 * after running `wrangler deploy` for viewer-src/worker (see worker/wrangler.toml).
 */
export const PROD_WORKER_URL = '';

/** `wrangler dev` listens here by default. */
export const DEV_WORKER_URL = 'ws://127.0.0.1:8787';

export const WORKER_URL: string = import.meta.env.DEV ? DEV_WORKER_URL : PROD_WORKER_URL;
