import data from './catalog.json';

/**
 * Every gallery page, state and scenario (catalog.json). Also read by capture.mjs and the overview,
 * so a state added there is captured and listed. Address-only states are declared there (query,
 * hash); states that need data or clicks also have a script in states.ts.
 */
export interface CatalogState {
  id: string;
  title: string;
  /** Scenarios this state is shown with; default: the surface's. */
  scenarios?: string[];
  /** Address parameters the state sets when the page address does not already name them. */
  query?: Record<string, string>;
  hash?: string;
  /** Capture the whole page (default: the surface's setting). */
  fullPage?: boolean;
}

export interface CatalogSurface {
  id: string;
  title: string;
  viewport: { width: number; height: number };
  /** Further widths captured at the same height (side panel: 320). */
  widths?: number[];
  fullPage: boolean;
  scenarios: string[];
  states: CatalogState[];
}

export const catalog = data as {
  scenarios: { id: string; title: string }[];
  surfaces: CatalogSurface[];
};

export function findState(surface: string, state: string): CatalogState {
  const found = catalog.surfaces.find((s) => s.id === surface)?.states.find((s) => s.id === state);
  if (!found)
    throw new Error(`Unknown gallery state "${state}" for ${surface} (gallery/catalog.json).`);
  return found;
}
