// #521 · the bike chooser's camera keeps the whole bike across the width.
//
// The preview camera has a fixed 28° VERTICAL field of view, tuned on a box
// about 1.5 wide for every 1 tall. A TV box that grows taller (but can't grow
// wider) would keep that vertical view and narrow the horizontal one, cutting
// off the bike's ends as it turns side-on. Below that shape, widen the
// vertical view so the horizontal view stays what it was tuned at; the extra
// height shows more ground and sky round the same-sized bike.

export const PREVIEW_FOV = 28;          // vertical, degrees, at PREVIEW_ASPECT or wider
export const PREVIEW_ASPECT = 1.5;      // width / height the framing was tuned on

/** Vertical field of view (degrees) for a preview box of `aspect` (w / h). */
export function previewFov(aspect) {
  if (!(aspect > 0) || aspect >= PREVIEW_ASPECT) return PREVIEW_FOV;
  const halfH = Math.tan((PREVIEW_FOV / 2) * Math.PI / 180) * PREVIEW_ASPECT / aspect;
  return 2 * Math.atan(halfH) * 180 / Math.PI;
}
