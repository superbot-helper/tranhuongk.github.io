/// <reference types="vite/client" />

/** Worker pipe endpoint (not a secret; the Worker needs no token). Deployed 2026-10-21. */
export const PROD_WORKER_URL = 'wss://uv-web-viewer-pipe.uv-web-viewer-worker.workers.dev';

/** `wrangler dev` listens here by default. */
export const DEV_WORKER_URL = 'ws://127.0.0.1:8787';

export const WORKER_URL: string = import.meta.env.DEV ? DEV_WORKER_URL : PROD_WORKER_URL;
