/*
 * D2 loads real stylesheets as side-effect imports — hightable's own CSS and
 * fm-ui's grid host rules. Vite handles these at run time; TypeScript needs to
 * be told they are modules, or every browser suite fails to typecheck.
 */
declare module "*.css";
