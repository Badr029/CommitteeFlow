/// <reference types="vite/client" />

/**
 * Build-time flags.
 *
 * Declared so they can be read with dot notation. That is not a style
 * preference: Vite substitutes `import.meta.env.VITE_X` as a literal at build
 * time, which lets the bundler delete the branch behind it, while
 * `import.meta.env['VITE_X']` survives as a runtime lookup and keeps whatever
 * it guards in the bundle.
 */
interface ImportMetaEnv {
  /** "true" on the public review deployment, absent everywhere else. */
  readonly VITE_DEMO_ACCOUNTS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

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
