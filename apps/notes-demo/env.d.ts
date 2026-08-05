// Ambient decl so `import "./x.css"` (a no-bundle side-effect import handled by
// webrun-modules) type-checks. Kept OUTSIDE src/ so the build scanner does not
// emit an empty stub for it.
declare module "*.css";
