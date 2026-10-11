/**
 * Hybrid logical clock (Kulkarni et al.). A timestamp is a fixed-width string
 * `<wall:9 base36>.<counter:4 base36>.<node>` so that plain string comparison is the total order
 * (wall, counter, node). It respects causality (a device that has seen an operation stamps every later
 * operation above it) and survives wrong wall clocks as long as the skew is bounded.
 */

const WALL_WIDTH = 9;
const COUNTER_WIDTH = 4;
const MAX_COUNTER = 36 ** COUNTER_WIDTH - 1;
const MAX_WALL = 36 ** WALL_WIDTH - 1;

/** Remote timestamps further ahead of the local wall clock than this are clamped, never trusted. */
export const DEFAULT_MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

export interface HlcState {
  wall: number;
  counter: number;
}

export interface ParsedHlc extends HlcState {
  node: string;
}

export const HLC_PATTERN = /^[0-9a-z]{9}\.[0-9a-z]{4}\.[0-9A-Za-z_-]{1,64}$/;

export function formatHlc(wall: number, counter: number, node: string): string {
  const w = Math.min(Math.max(0, Math.trunc(wall)), MAX_WALL);
  const c = Math.min(Math.max(0, Math.trunc(counter)), MAX_COUNTER);
  return `${w.toString(36).padStart(WALL_WIDTH, '0')}.${c
    .toString(36)
    .padStart(COUNTER_WIDTH, '0')}.${node}`;
}

export function parseHlc(value: string): ParsedHlc | null {
  if (!HLC_PATTERN.test(value)) return null;
  const [wall, counter, node] = value.split('.') as [string, string, string];
  return { wall: parseInt(wall, 36), counter: parseInt(counter, 36), node };
}

/** Greater of two timestamps; null is "no timestamp". */
export function maxHlc(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

/**
 * Timestamp for a local event. `floor` lists timestamps the writer has already seen (the clocks in
 * its metadata for the entity being written): the result is strictly greater than all of them even
 * when the persisted clock state is stale, so a device can never write "before" something it read.
 */
export function tick(
  state: HlcState,
  nowMs: number,
  node: string,
  floor: readonly (string | null | undefined)[] = [],
): { state: HlcState; hlc: string } {
  let wall = Math.max(state.wall, Math.trunc(nowMs));
  let counter = wall === state.wall ? state.counter + 1 : 0;
  for (const f of floor) {
    const p = f ? parseHlc(f) : null;
    if (p && (p.wall > wall || (p.wall === wall && p.counter >= counter))) {
      wall = p.wall;
      counter = p.counter + 1;
    }
  }
  if (counter > MAX_COUNTER) {
    wall += 1;
    counter = 0;
  }
  return { state: { wall, counter }, hlc: formatHlc(wall, counter, node) };
}

/** Fold a remote timestamp into the local clock. Far-future values are clamped (poisoned-clock guard). */
export function receive(
  state: HlcState,
  remote: string,
  nowMs: number,
  maxDriftMs: number = DEFAULT_MAX_DRIFT_MS,
): HlcState {
  const p = parseHlc(remote);
  if (!p) return state;
  const now = Math.trunc(nowMs);
  const clamped = p.wall > now + maxDriftMs;
  const remoteWall = clamped ? now + maxDriftMs : p.wall;
  const remoteCounter = clamped ? 0 : p.counter;
  const wall = Math.max(state.wall, remoteWall, now);
  let counter: number;
  if (wall === state.wall && wall === remoteWall) {
    counter = Math.max(state.counter, remoteCounter) + 1;
  } else if (wall === state.wall) {
    counter = state.counter + 1;
  } else if (wall === remoteWall) {
    counter = remoteCounter + 1;
  } else {
    counter = 0;
  }
  return counter > MAX_COUNTER ? { wall: wall + 1, counter: 0 } : { wall, counter };
}

/** Wall-clock milliseconds encoded in a timestamp, or null when malformed. */
export function hlcWallMs(value: string): number | null {
  return parseHlc(value)?.wall ?? null;
}
