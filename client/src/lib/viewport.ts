import { useEffect, useState } from 'react';

/**
 * Which shape of the application is on screen.
 *
 * The Committee Plan is a genuinely different screen on a phone than on a
 * desktop — an agenda of committee sessions rather than a table of rows — so
 * the choice cannot be made in CSS alone. Rendering both and hiding one with
 * `display: none` would put two copies of the plan in the accessibility tree
 * and ask the browser to build a 12-column grid nobody sees, so the layout is
 * chosen in JavaScript and only one is ever mounted.
 *
 * The breakpoints are content-driven, not device-driven:
 *
 * - `desktop` starts at 1100px because the plan table needs ~1000px before its
 *   columns start colliding, plus the application chrome.
 * - `tablet` starts at 768px: wide enough for two session cards side by side
 *   and a two-column form, too narrow for the table.
 * - `mobile` is everything below that — one column, bottom navigation, sheets.
 */

export type Viewport = 'mobile' | 'tablet' | 'desktop';

export const BREAKPOINT_TABLET = 768;
export const BREAKPOINT_DESKTOP = 1100;

/**
 * Matches a media query, kept in sync with the browser.
 *
 * Returns `false` on the first render when `matchMedia` is missing, which is
 * the case in jsdom — so tests see the desktop layout unless they say otherwise.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

export function useViewport(): Viewport {
  const isTabletOrWider = useMediaQuery(`(min-width: ${BREAKPOINT_TABLET}px)`);
  const isDesktop = useMediaQuery(`(min-width: ${BREAKPOINT_DESKTOP}px)`);

  if (isDesktop) return 'desktop';
  if (isTabletOrWider) return 'tablet';
  return 'mobile';
}

/** True for phone and tablet — everywhere the agenda replaces the table. */
export function useIsCompact(): boolean {
  return !useMediaQuery(`(min-width: ${BREAKPOINT_DESKTOP}px)`);
}

/**
 * True where the primary input cannot hover.
 *
 * Used to decide whether an action may live behind a hover state. It is a
 * separate question from width: a touchscreen laptop is wide and cannot hover.
 */
export function useIsTouch(): boolean {
  return useMediaQuery('(hover: none), (pointer: coarse)');
}
