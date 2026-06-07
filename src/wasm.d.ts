// wrangler resolves an imported .wasm file to a compiled WebAssembly.Module.
declare module '*.wasm' {
  const mod: WebAssembly.Module;
  export default mod;
}
