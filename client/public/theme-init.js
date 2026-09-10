/*
 * Theme bootstrap.
 *
 * Runs before first paint so a dark-mode user never sees a light flash. It is a
 * separate file rather than an inline <script> on purpose: the application's CSP
 * is `script-src 'self'` with no `unsafe-inline` and no nonce, and weakening
 * that for a five-line convenience would be a poor trade (spec §61).
 */
(function () {
  try {
    var stored = localStorage.getItem('committeeflow.theme');
    document.documentElement.dataset.theme =
      stored === 'light' || stored === 'dark'
        ? stored
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
  } catch (error) {
    // Private browsing or blocked site data: fall back to the light palette.
    document.documentElement.dataset.theme = 'light';
  }
})();
