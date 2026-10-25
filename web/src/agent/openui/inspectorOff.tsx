/**
 * What `@openuidev/devtools` resolves to in this console.
 *
 * The official renderer auto-mounts its own inspector widget when a build runs in development: a
 * floating launcher in the bottom-right corner, which is exactly where the conversation's own
 * controls sit and where the browser checks click. It belongs to the SDK's demo, not to a product
 * surface, so `web/vite.config.ts` aliases the package here and the integration's dynamic import
 * resolves to nothing mountable. A production build drops the import altogether.
 */
export const OpenUIDevtools = () => null;
