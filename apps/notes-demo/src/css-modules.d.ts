// CSS is imported for its side effect (the build wraps it into a <style> injector
// `.js` module). Declare the module so `import "./styles.css"` typechecks.
declare module "*.css" {
  const content: string;
  export default content;
}
