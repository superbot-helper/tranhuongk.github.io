// Loads a binary asset referenced as `new URL('./x', import.meta.url)`.
// In the browser build Vite rewrites that URL to the emitted asset and fetch()
// reads it. Under Vitest (Node) the URL is file:, which fetch() cannot read, so
// the file is read through process.getBuiltinModule: no `node:` import appears
// in the module graph, so nothing Node-specific reaches the browser bundle.

interface NodeFs {
  readFileSync(path: URL): Uint8Array;
}

export class AssetLoadError extends Error {
  constructor(url: URL, cause: unknown) {
    super(`failed to load ${url.pathname.split('/').pop() ?? 'asset'}`, { cause });
    this.name = 'AssetLoadError';
  }
}

export async function loadBinaryAsset(url: URL): Promise<Uint8Array> {
  try {
    if (url.protocol === 'file:') {
      const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
      const fs = proc?.getBuiltinModule?.('node:fs') as NodeFs | undefined;
      if (!fs) throw new Error('file: assets need Node.js');
      const bytes = fs.readFileSync(url);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (e) {
    throw new AssetLoadError(url, e);
  }
}
