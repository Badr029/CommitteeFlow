/// <reference types="vite/client" />

/**
 * CSS Modules.
 *
 * Vite's own declaration types a module's default export as `any`, which throws
 * away the one guarantee worth having here: that a class name exists. Narrowing
 * it to a string record keeps `styles.typo` a type error.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
