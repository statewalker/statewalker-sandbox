// Theia's esbuild config loads `.wasm` imports as data: URLs.
declare module "*.wasm" {
  const url: string;
  export default url;
}
