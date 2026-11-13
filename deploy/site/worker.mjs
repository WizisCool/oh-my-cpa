/**
 * Entry Worker for the public site (`omc.junze.dev`).
 *
 * Only `/demo` and `/demo/*` run through this Worker (`run_worker_first` in `wrangler.jsonc`),
 * mounting the shared Cloudflare demo handler under `/demo` while keeping `/`, `/api-docs/*`,
 * and any future landing site purely on static assets.
 */
import { createDemoHandler } from '../cloudflare/worker.mjs';

export default createDemoHandler({ basePath: '/demo' });
