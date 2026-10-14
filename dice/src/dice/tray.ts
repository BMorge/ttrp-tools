/**
 * The dice tray in world units (y is up). Physics walls and the visible rim share these numbers,
 * and the tray never changes with the window size: resizing moves the camera, not the dice.
 */
export const TRAY = {
  width: 18,
  depth: 11,
  wallHeight: 10,
} as const;
