'use strict';

/**
 * The buddy's world: which monitors exist, how they touch, and where a window
 * sits among them.
 *
 * Pure geometry over what `screen.getAllDisplays()` returns, so all of it is
 * testable with made-up display lists and no Electron. macOS lays every
 * display into one shared coordinate space, which is why adjacency is
 * computable at all: two displays are neighbours exactly where their bounds
 * touch, and the stretch of edge they share is the portal a buddy could cross
 * through. Nothing here moves a window — this module only says what's there.
 *
 * Displays get names a person would use. Electron marks the built-in panel
 * `internal: true`, so "the MacBook screen" is machine-identifiable without
 * configuration; everything else goes by its label, told apart by position
 * when two share one ("left Studio Display", "right Studio Display").
 */

/** The straight-line centre of a rectangle, for tie-breaks and sorting. */
const centre = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** How much two rectangles overlap, in square pixels. Zero when apart. */
function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * What one display is called before any telling-apart: the built-in panel is
 * "the MacBook screen" to everyone who has ever pointed at one, a labelled
 * monitor goes by its label, and a monitor macOS couldn't name is still a
 * display, just an anonymous one.
 */
function baseName(display) {
  if (display.internal) return 'MacBook screen';
  const label = String(display.label || '').trim();
  return label || 'external display';
}

/**
 * Friendly, unambiguous names for every display: a Map from display id to
 * name. Two monitors with the same label are told apart the way a person
 * would — by where they sit. A pair becomes "left X" and "right X" (or upper
 * and lower, if that is how they're arranged), a trio gets a middle, and a
 * wall of four or more falls back to counting along the row.
 *
 * @param {Array<{id:number,bounds:object,label?:string,internal?:boolean}>} displays
 * @returns {Map<number,string>}
 */
function friendlyNames(displays) {
  const groups = new Map();
  for (const d of displays) {
    const name = baseName(d);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(d);
  }

  const names = new Map();
  for (const [name, group] of groups) {
    if (group.length === 1) {
      names.set(group[0].id, name);
      continue;
    }
    // Tell duplicates apart along the axis they're actually spread over.
    const xs = group.map((d) => centre(d.bounds).x);
    const ys = group.map((d) => centre(d.bounds).y);
    const across = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
    const sorted = [...group].sort((a, b) =>
      across ? centre(a.bounds).x - centre(b.bounds).x : centre(a.bounds).y - centre(b.bounds).y
    );
    const words =
      sorted.length === 2
        ? across
          ? ['left', 'right']
          : ['upper', 'lower']
        : sorted.length === 3
          ? across
            ? ['left', 'middle', 'right']
            : ['upper', 'middle', 'lower']
          : null;
    sorted.forEach((d, i) => {
      names.set(d.id, words ? `${words[i]} ${name}` : `${name} ${i + 1}`);
    });
  }
  return names;
}

/**
 * Where two displays touch, if they do.
 *
 * A shared edge is a real stretch, never a point: displays that only meet at
 * a corner are not neighbours, because there is nothing to walk through. The
 * portal is the interval they share — y-values along a vertical boundary
 * (side left/right), x-values along a horizontal one (side above/below) —
 * and `at` is where that boundary sits on the other axis.
 *
 * @returns {{side:'left'|'right'|'above'|'below',portal:{at:number,start:number,end:number}}|null}
 *   how to leave `a` for `b`, or null if they don't touch
 */
function sharedEdge(a, b) {
  const vertical = [
    { side: 'right', at: a.x + a.width, other: b.x },
    { side: 'left', at: a.x, other: b.x + b.width },
  ];
  for (const { side, at, other } of vertical) {
    if (at !== other) continue;
    const start = Math.max(a.y, b.y);
    const end = Math.min(a.y + a.height, b.y + b.height);
    if (end > start) return { side, portal: { at, start, end } };
  }
  const horizontal = [
    { side: 'below', at: a.y + a.height, other: b.y },
    { side: 'above', at: a.y, other: b.y + b.height },
  ];
  for (const { side, at, other } of horizontal) {
    if (at !== other) continue;
    const start = Math.max(a.x, b.x);
    const end = Math.min(a.x + a.width, b.x + b.width);
    if (end > start) return { side, portal: { at, start, end } };
  }
  return null;
}

/**
 * Every neighbouring pair, in both directions: an entry saying B is to the
 * right of A comes with its mirror saying A is to the left of B, so a caller
 * standing on either display finds its exits without flipping anything.
 *
 * @param {Array<{id:number,bounds:object}>} displays
 * @returns {Array<{from:number,to:number,side:string,portal:object}>}
 */
function neighbors(displays) {
  const found = [];
  for (const a of displays) {
    for (const b of displays) {
      if (a.id === b.id) continue;
      const edge = sharedEdge(a.bounds, b.bounds);
      if (edge) found.push({ from: a.id, to: b.id, ...edge });
    }
  }
  return found;
}

/**
 * Which display a window is on: the one holding most of it, the same call
 * Electron's `screen.getDisplayMatching` makes. A window lost in empty space
 * (mid-hop, or left behind by an unplugged monitor) belongs to whichever
 * display its centre is nearest, so the answer is never "nowhere".
 *
 * @param {Array<{id:number,bounds:object}>} displays
 * @param {{x:number,y:number,width:number,height:number}} bounds  a window
 * @returns {object|null} the display, or null only when there are no displays
 */
function displayFor(displays, bounds) {
  if (!displays.length) return null;
  let best = null;
  let bestArea = 0;
  for (const d of displays) {
    const area = overlapArea(d.bounds, bounds);
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  if (best) return best;
  const c = centre(bounds);
  return displays.reduce((near, d) => {
    const dc = centre(d.bounds);
    const nc = centre(near.bounds);
    const dd = (dc.x - c.x) ** 2 + (dc.y - c.y) ** 2;
    const nd = (nc.x - c.x) ** 2 + (nc.y - c.y) ** 2;
    return dd < nd ? d : near;
  });
}

/**
 * Where on a display a window sits, in words: the work area is cut into
 * thirds each way and the window's centre names its cell — "bottom-right",
 * "top", or plain "middle" for the centre cell. The work area, not the raw
 * bounds, so a buddy under the menu bar is "top", not somewhere impossible.
 *
 * @param {{workArea:object}} display
 * @param {{x:number,y:number,width:number,height:number}} bounds  a window
 * @returns {{region:string,x:number,y:number}} region plus the centre's
 *   position across the work area, each 0..1 and clamped
 */
function whereOn(display, bounds) {
  const wa = display.workArea;
  const c = centre(bounds);
  const x = Math.min(1, Math.max(0, (c.x - wa.x) / wa.width));
  const y = Math.min(1, Math.max(0, (c.y - wa.y) / wa.height));
  const third = (v) => (v < 1 / 3 ? 0 : v > 2 / 3 ? 2 : 1);
  const down = ['top', '', 'bottom'][third(y)];
  const along = ['left', '', 'right'][third(x)];
  const region = down && along ? `${down}-${along}` : down || along || 'middle';
  return { region, x, y };
}

/**
 * The whole world in one description: every display with its friendly name,
 * which is primary (macOS keeps the primary's corner at the origin) and which
 * is the built-in panel, how they touch, and — given a window — where that
 * window is right now. Displays come sorted left to right so the description
 * reads the way the desk looks.
 *
 * @param {Array<object>} displays  what screen.getAllDisplays() returned
 * @param {{x:number,y:number,width:number,height:number}} [windowBounds]
 * @returns {{displays:Array<object>,neighbors:Array<object>,where:object|null}}
 */
function habitatFrom(displays, windowBounds) {
  const names = friendlyNames(displays);
  const described = [...displays]
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((d) => ({
      id: d.id,
      name: names.get(d.id),
      internal: !!d.internal,
      primary: d.bounds.x === 0 && d.bounds.y === 0,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
    }));

  let where = null;
  if (windowBounds) {
    const on = displayFor(displays, windowBounds);
    if (on) {
      const { region, x, y } = whereOn(on, windowBounds);
      where = { displayId: on.id, name: names.get(on.id), region, x, y };
    }
  }

  return { displays: described, neighbors: neighbors(displays), where };
}

module.exports = { friendlyNames, sharedEdge, neighbors, displayFor, whereOn, habitatFrom };
