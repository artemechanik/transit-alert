import fs from 'node:fs';
import vm from 'node:vm';

// Each load gets its own browser globals, module scopes and module cache.
export async function loadBrowserModule(entryUrl, globals) {
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error('Run with: node --experimental-vm-modules --test frontend/tests/*.test.mjs');
  }
  const context = vm.createContext(globals);
  const modules = new Map();
  function load(url) {
    if (!modules.has(url)) {
      modules.set(url, new vm.SourceTextModule(fs.readFileSync(new URL(url), 'utf8'), {
        context, identifier: url,
      }));
    }
    return modules.get(url);
  }
  const entry = load(entryUrl.href);
  await entry.link((specifier, parent) => load(new URL(specifier, parent.identifier).href));
  await entry.evaluate();
  return entry.namespace;
}
