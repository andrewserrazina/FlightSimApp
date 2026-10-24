/**
 * Route map label placement (Ops Center L7). Greedy and deterministic: the departure and
 * destination are placed first, then the other fixes in route order. Each label tries a few spots
 * around its fix and takes the first that stays inside the map and overlaps no other label and no
 * other fix marker (the endpoints may cover a marker, so they are always labelled). A label with no
 * free spot is left out rather than drawn over another; the fix marker is always drawn.
 */

export interface LabelPoint {
  x: number;
  y: number;
  text: string;
}

export interface PlacedLabel {
  /** Index into the input points. */
  index: number;
  x: number;
  y: number;
  anchor: "start" | "end";
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LabelOptions {
  width: number;
  height: number;
  /** Font size in map units; the box height follows it. */
  fontSize: number;
  /** Glyph advance as a fraction of the font size (monospace ≈ 0.6; the default leaves a margin). */
  charWidth?: number;
  /** Radius kept clear around every fix marker. */
  markerRadius?: number;
  /** Extra circles labels keep clear of, such as the aircraft position. */
  obstacles?: ReadonlyArray<{ x: number; y: number; r: number }>;
}

const GAP = 6;

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

// Font ascent and descent as fractions of the font size; generous, so the box covers the glyphs as rendered.
const ASCENT = 0.95;
const DESCENT = 0.25;

/** Text box for a label at (x, y) baseline with the given anchor. */
function boxFor(x: number, y: number, anchor: "start" | "end", w: number, h: number): Box {
  const x0 = anchor === "start" ? x : x - w;
  return { x0, y0: y - h * ASCENT, x1: x0 + w, y1: y + h * DESCENT };
}

export function placeLabels(points: LabelPoint[], opts: LabelOptions): PlacedLabel[] {
  const { width, height, fontSize } = opts;
  const cw = (opts.charWidth ?? 0.62) * fontSize;
  const r = opts.markerRadius ?? 4;
  const markers: Box[] = points.map((p) => ({ x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r }));
  // Other things to keep clear (the aircraft dot); they never match a label's own fix.
  for (const o of opts.obstacles ?? []) markers.push({ x0: o.x - o.r, y0: o.y - o.r, x1: o.x + o.r, y1: o.y + o.r });
  const placed: Box[] = [];
  const out: PlacedLabel[] = [];
  const last = points.length - 1;
  const order = points.length <= 1 ? [0] : [0, last, ...points.map((_, i) => i).slice(1, last)];

  for (const i of order) {
    const p = points[i];
    if (!p || !p.text) continue;
    const endpoint = i === 0 || i === last;
    const w = p.text.length * cw;
    const h = fontSize;
    const d = r + GAP / 2;
    // Above-right, above-left, below-right, below-left, then level right and left.
    const candidates: Array<{ x: number; y: number; anchor: "start" | "end" }> = [
      { x: p.x + d, y: p.y - d, anchor: "start" },
      { x: p.x - d, y: p.y - d, anchor: "end" },
      { x: p.x + d, y: p.y + d + h * ASCENT, anchor: "start" },
      { x: p.x - d, y: p.y + d + h * ASCENT, anchor: "end" },
      { x: p.x + d + 2, y: p.y + h * 0.3, anchor: "start" },
      { x: p.x - d - 2, y: p.y + h * 0.3, anchor: "end" },
    ];
    const fits = (c: (typeof candidates)[number], coverMarkers: boolean) => {
      const b = boxFor(c.x, c.y, c.anchor, w, h);
      if (b.x0 < 0 || b.y0 < 0 || b.x1 > width || b.y1 > height) return null;
      if (placed.some((o) => overlaps(o, b))) return null;
      if (!coverMarkers && markers.some((m, j) => j !== i && overlaps(m, b))) return null;
      return b;
    };
    // The departure and destination are always labelled: when no clear spot exists they may cover
    // a nearby fix marker, and every later label keeps clear of them.
    for (const coverMarkers of endpoint ? [false, true] : [false]) {
      const c = candidates.find((k) => fits(k, coverMarkers));
      if (c) {
        placed.push(fits(c, coverMarkers)!);
        out.push({ index: i, ...c });
        break;
      }
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** True when any two placed labels overlap (used by tests and the capture check). */
export function labelsOverlap(points: LabelPoint[], placed: PlacedLabel[], opts: LabelOptions): boolean {
  const cw = (opts.charWidth ?? 0.62) * opts.fontSize;
  const boxes = placed.map((l) => boxFor(l.x, l.y, l.anchor, points[l.index]!.text.length * cw, opts.fontSize));
  return boxes.some((a, i) => boxes.some((b, j) => j > i && overlaps(a, b)));
}
