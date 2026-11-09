// workerd (and Cloudflare's bundling convention): importing a .wasm file yields a compiled Module.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
