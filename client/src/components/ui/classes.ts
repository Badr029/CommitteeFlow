import controls from './controls.module.css';
import overlay from './overlay.module.css';

/**
 * Shared class names from the UI stylesheets.
 *
 * These live apart from the components so each component file exports only
 * components — which is what keeps React Fast Refresh working during
 * development, and keeps the module boundary honest.
 */

export const controlClass = controls['control'];
export const numericClass = controls['numeric'];
export const checkboxRowClass = controls['checkboxRow'];
export const checkboxLabelClass = controls['checkboxLabel'];
export const drawerFootSpacer = overlay['footSpacer'];
