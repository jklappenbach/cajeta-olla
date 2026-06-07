# Vendored: @bokuweb/zstd-wasm (web build)

These files are the **web build** of [`@bokuweb/zstd-wasm`](https://github.com/bokuweb/zstd-wasm)
(`dist/web/*`), copied verbatim from `node_modules`.

**Why vendored:** the package's `exports` map does not expose the deep
subpaths (`dist/web/module.js`, `dist/web/zstd.wasm`, …) that the Worker bundle
needs, so esbuild/wrangler rejects importing them from `node_modules`. Copying
the web build here sidesteps the exports-map restriction. We import
`zstd.wasm` directly (wrangler compiles it to a `WebAssembly.Module` at bundle
time) and inject a synchronous `Module.instantiateWasm` so no runtime
`fetch()`/compile is needed — Cloudflare Workers forbid compiling wasm from
bytes at request time.

See `../../lib/bundle-codec.ts` for the wiring.

**License:** MIT (© bokuweb). Upstream license travels with the package in
`node_modules/@bokuweb/zstd-wasm`.
