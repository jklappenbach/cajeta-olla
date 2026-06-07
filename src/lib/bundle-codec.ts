// tar.zst bundle codec (§14). Produces the exact wire shape the C++ client
// reads (src/cajeta/buildtool/repo/TarZstd.cpp): a POSIX ustar archive (one
// 512-byte header per flat regular file, two zero blocks at end) wrapped in a
// single zstd frame. Members are content-addressed: `<sha256-hex>.cja`, plus a
// `bundle.json` index — matching `consumeBundle` in HttpRepository.cpp, which
// looks up tar members by `<hex>.cja`.
//
// zstd runs via @bokuweb/zstd-wasm. Workers can't compile wasm from bytes at
// request time, so we import the `.wasm` (wrangler compiles it at bundle time
// into a WebAssembly.Module) and inject a synchronous instantiation through the
// emscripten glue's `Module.instantiateWasm` hook.
//
// The zstd glue is vendored under src/vendor/zstd (the package's exports map
// blocks the deep imports esbuild/wrangler needs). wrangler compiles the
// imported .wasm at bundle time into a WebAssembly.Module.
import wasmModule from '../vendor/zstd/zstd.wasm';
import { Module, waitInitialized } from '../vendor/zstd/module.js';
import { compress, decompress } from '../vendor/zstd/index.web.js';

let zstdReady: Promise<void> | null = null;

function ensureZstd(): Promise<void> {
  if (!zstdReady) {
    zstdReady = (async () => {
      (Module as any).instantiateWasm = (
        imports: WebAssembly.Imports,
        success: (instance: WebAssembly.Instance) => void,
      ) => {
        const instance = new WebAssembly.Instance(wasmModule as WebAssembly.Module, imports);
        success(instance);
        return instance.exports;
      };
      (Module as any)['init'](); // instantiateWasm short-circuits the fetch path
      await waitInitialized();
    })();
  }
  return zstdReady;
}

// ── ustar writer (mirrors TarZstd.cpp::appendHeader exactly) ──

const BLOCK = 512;

export interface TarEntry {
  name: string; // ≤ 99 bytes
  data: Uint8Array;
}

function writeOctal(hdr: Uint8Array, off: number, width: number, value: number) {
  // width-1 octal digits, zero-padded, then a NUL terminator.
  const digits = value.toString(8).padStart(width - 1, '0').slice(-(width - 1));
  for (let i = 0; i < width - 1; i++) hdr[off + i] = digits.charCodeAt(i);
  hdr[off + width - 1] = 0;
}

function buildTar(entries: TarEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    if (nameBytes.length === 0 || nameBytes.length >= 100) {
      throw new Error(`tar: name out of range (1..99 bytes): '${e.name}'`);
    }
    const hdr = new Uint8Array(BLOCK);
    hdr.set(nameBytes, 0);
    writeOctal(hdr, 100, 8, 0o644); // mode
    writeOctal(hdr, 108, 8, 0); // uid
    writeOctal(hdr, 116, 8, 0); // gid
    writeOctal(hdr, 124, 12, e.data.length); // size
    writeOctal(hdr, 136, 12, 0); // mtime (deterministic)
    hdr[156] = '0'.charCodeAt(0); // typeflag: regular file
    hdr.set(enc.encode('ustar'), 257); // magic
    hdr[262] = 0;
    hdr[263] = '0'.charCodeAt(0); // version "00"
    hdr[264] = '0'.charCodeAt(0);
    // checksum: field reads as spaces during computation.
    for (let i = 148; i < 156; i++) hdr[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += hdr[i];
    writeOctal(hdr, 148, 7, sum);
    hdr[155] = 0x20; // trailing space after the 6 octal digits + NUL

    blocks.push(hdr);
    blocks.push(e.data);
    const rem = e.data.length % BLOCK;
    if (rem !== 0) blocks.push(new Uint8Array(BLOCK - rem));
  }
  blocks.push(new Uint8Array(2 * BLOCK)); // end-of-archive

  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

// Default bundle compression level. A solid single-frame stream lets zstd
// match repeated sections *across* members (the core cross-library dedup
// win, §14). Level 19's window (~8 MiB) is far larger than level 3's, and any
// frame with windowLog ≤ 27 decodes with the client's simple ZSTD_decompress
// (TarZstd.cpp), so it stays interoperable. (True `--long`/LDM and a trained
// dictionary need advanced cctx params the wasm build doesn't expose, plus a
// client that opts into a larger window / dict — tracked as supercompress.)
const DEFAULT_LEVEL = 19;

/** Build a tar from entries and zstd-compress it as one solid frame. */
export async function writeTarZstd(
  entries: TarEntry[],
  level: number = DEFAULT_LEVEL,
): Promise<Uint8Array> {
  await ensureZstd();
  const tar = buildTar(entries);
  return compress(tar, level) as Uint8Array;
}

/** Decompress + parse a tar.zst (used in tests / round-trip checks). */
export async function readTarZstd(zstdBytes: Uint8Array): Promise<TarEntry[]> {
  await ensureZstd();
  const tar = decompress(zstdBytes) as Uint8Array;
  const entries: TarEntry[] = [];
  let pos = 0;
  const dec = new TextDecoder();
  while (pos + BLOCK <= tar.length) {
    let allZero = true;
    for (let i = 0; i < BLOCK; i++) {
      if (tar[pos + i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;
    let nameLen = 0;
    while (nameLen < 100 && tar[pos + nameLen] !== 0) nameLen++;
    const name = dec.decode(tar.subarray(pos, pos + nameLen));
    let size = 0;
    for (let i = 124; i < 136; i++) {
      const ch = tar[pos + i];
      if (ch === 0 || ch === 0x20) break;
      if (ch >= 0x30 && ch <= 0x37) size = size * 8 + (ch - 0x30);
    }
    pos += BLOCK;
    entries.push({ name, data: tar.subarray(pos, pos + size) });
    pos += size;
    const rem = size % BLOCK;
    if (rem !== 0) pos += BLOCK - rem;
  }
  return entries;
}
