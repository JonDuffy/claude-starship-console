// The band's LCARS-inspired look: flat pastel segments with dark ink on
// them. A Box is always square, so the row's rounded ends are SVG, which the
// app draws as an image. The type is the app's own.

export const INK = '#15161b'
export const AMBER = '#ffa348'
export const PEACH = '#ffc391'
export const LILAC = '#c8a8ea'
export const VIOLET = '#a093f5'
export const BLUE = '#8fb6ff'
export const ICE = '#aad8f2'
export const ROSE = '#e592ab'
export const RED = '#ef5d62'
export const SAND = '#f1d197'
export const MINT = '#86d3a8'

export const CAP_WIDTH = 9
export const CAP_HEIGHT = 18

/** A rounded end for the band's row of segments: half a disc, as an image. */
export function capSvg(side: 'left' | 'right', color: string): string {
  const half = CAP_HEIGHT / 2
  const path =
    side === 'left'
      ? `M${CAP_WIDTH} 0A${half} ${half} 0 0 0 ${CAP_WIDTH} ${CAP_HEIGHT}Z`
      : `M0 0A${half} ${half} 0 0 1 0 ${CAP_HEIGHT}Z`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CAP_WIDTH}" height="${CAP_HEIGHT}" viewBox="0 0 ${CAP_WIDTH} ${CAP_HEIGHT}"><path fill="${color}" d="${path}"/></svg>`
}
