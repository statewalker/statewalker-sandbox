declare module "*.pack" {
  const bytes: Uint8Array;
  export default bytes;
}
declare module "*.idx" {
  const bytes: Uint8Array;
  export default bytes;
}
declare module "*?url" {
  const url: string;
  export default url;
}
