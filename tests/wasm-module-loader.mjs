import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.wasm')) return nextLoad(url, context);
  const bytes = await readFile(fileURLToPath(url));
  const base64 = bytes.toString('base64');
  return {
    format: 'module',
    shortCircuit: true,
    source: `import { Buffer } from 'node:buffer';\nexport default await WebAssembly.compile(Buffer.from(${JSON.stringify(base64)}, 'base64'));`,
  };
}
