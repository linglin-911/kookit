/** Keep horizontal character edges intact; only trim excess font-metric space. */
export function textBand(rect: DOMRect) {
  const inset = Math.min(3, rect.height * 0.08);
  return { left: rect.left, right: rect.right, top: rect.top + inset,
    bottom: rect.bottom - inset, width: rect.width, height: rect.height - inset * 2 };
}
export function hitsText(rect: DOMRect, x: number, y: number) {
  const band = textBand(rect);
  return x >= band.left && x < band.right && y >= band.top && y < band.bottom;
}
