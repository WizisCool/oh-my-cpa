/**
 * Node's ESM resolver requires an explicit file extension, while the web sources
 * import each other the way a bundler expects - extensionless. Until now every
 * module that scripts/test-*.ts loaded happened to have only type imports, so the
 * difference never showed; a module that imports another for its runtime values
 * fails to link with ERR_MODULE_NOT_FOUND.
 *
 * This hook appends the TypeScript extension when a relative specifier does not
 * resolve as written, which lets the harness follow the real module graph. It is
 * resolution only - no transformation - and it mirrors the bundler's behaviour
 * instead of asking production code to carry a test-runner constraint.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      for (const extension of ['.ts', '.tsx']) {
        try {
          return nextResolve(`${specifier}${extension}`, context);
        } catch {
          // Try the next candidate, then fall back to the original specifier so
          // a genuine typo still reports the specifier the author wrote.
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
