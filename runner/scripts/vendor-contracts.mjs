import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep the emitted module layout intact: framework assets and the CLI version
// are resolved relative to their modules. Include contracts in this package so
// installs never depend on the private @localfirst/contracts npm namespace.
const runner = fileURLToPath(new URL('../', import.meta.url));
const output = join(runner, 'dist');
const vendor = join(output, 'contracts');
await rm(vendor, { recursive: true, force: true });
await cp(join(runner, '../packages/contracts/dist'), vendor, { recursive: true });

async function rewrite(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewrite(path);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) {
      let target = relative(dirname(path), join(vendor, 'index.js')).split(sep).join('/');
      if (!target.startsWith('.')) target = './' + target;
      const original = await readFile(path, 'utf8');
      const rewritten = original.replace(/(['"])@localfirst\/contracts\1/g, (_, quote) => quote + target + quote);
      if (original !== rewritten) await writeFile(path, rewritten);
    }
  }
}
await rewrite(output);
