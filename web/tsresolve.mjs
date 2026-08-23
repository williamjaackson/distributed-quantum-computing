// Let Node resolve the app's extensionless relative imports.
//
// Node strips types from `.ts` files on its own, but its resolver still wants a
// file extension, while the app source is written for Vite's resolver and omits
// them. Rather than write `.ts` on every import in the app to suit one script,
// this fills the extension in for Node only. Used as
// `node --import ./tsresolve.mjs ./verify.mjs`.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = ['.ts', '.tsx'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of EXTENSIONS) {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
