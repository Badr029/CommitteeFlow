import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom gaps the components rely on.
 *
 * Radix measures scrollbars and observes elements; jsdom implements neither.
 * Stubbing them here keeps every suite from repeating the same boilerplate.
 */
/**
 * A `matchMedia` that actually answers the question.
 *
 * The layout is chosen in JavaScript, not only in CSS — the plan is a table on
 * a desktop and an agenda of committee sessions on a phone — so a stub that
 * answers `false` to everything does not mean "no media query matched", it
 * means "every min-width query failed", which is a 0px-wide screen. Tests would
 * silently run against the phone layout.
 *
 * So the stub evaluates `min-width` and `max-width` against `window.innerWidth`
 * and the suite says which width it is testing. The default is a desktop, since
 * that is what the existing suite was written against.
 */
export const DESKTOP_WIDTH = 1280;

interface Registration {
  query: string;
  handler: (event: { matches: boolean; media: string }) => void;
}

const listeners = new Set<Registration>();

export function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  // Each listener is handed the result of its own query, in the shape a real
  // `change` event has, so a hook reading `event.matches` behaves as it would
  // in a browser.
  for (const { query, handler } of listeners) {
    handler({ matches: evaluate(query), media: query });
  }
}

function evaluate(query: string): boolean {
  const width = window.innerWidth;
  let matched = false;
  for (const part of query.split(',')) {
    const min = /min-width:\s*(\d+)px/.exec(part);
    const max = /max-width:\s*(\d+)px/.exec(part);
    if (!min && !max) continue;
    const okMin = min ? width >= Number(min[1]) : true;
    const okMax = max ? width <= Number(max[1]) : true;
    if (okMin && okMax) matched = true;
  }
  return matched;
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => {
    const list = {
      get matches() {
        return evaluate(query);
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, handler: Registration['handler']) =>
        listeners.add({ query, handler }),
      removeEventListener: (_type: string, handler: Registration['handler']) => {
        for (const registration of listeners) {
          if (registration.handler === handler) listeners.delete(registration);
        }
      },
      addListener: (handler: Registration['handler']) => listeners.add({ query, handler }),
      removeListener: (handler: Registration['handler']) => {
        for (const registration of listeners) {
          if (registration.handler === handler) listeners.delete(registration);
        }
      },
      dispatchEvent: () => false,
    };
    return list;
  },
});

setViewportWidth(DESKTOP_WIDTH);

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // A test that changed the viewport must not leak that into the next one.
  listeners.clear();
  setViewportWidth(DESKTOP_WIDTH);
});
