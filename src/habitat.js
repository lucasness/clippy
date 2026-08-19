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
 * The buddy's own window and the terminal it is watching are located the same
 * way, because "which screen is that on" is one question however it is asked.
 *
 * @param {Array<object>} displays  what screen.getAllDisplays() returned
 * @param {{x:number,y:number,width:number,height:number}} [windowBounds]
 * @param {{x:number,y:number,width:number,height:number}} [terminalBounds]
 *   the perched session's window, when Clippy has measured it
 * @returns {{displays:Array,neighbors:Array,where:object|null,terminal:object|null}}
 */
function habitatFrom(displays, windowBounds, terminalBounds) {
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

  let terminal = null;
  if (terminalBounds) {
    const on = displayFor(displays, terminalBounds);
    if (on) {
      terminal = {
        displayId: on.id,
        name: names.get(on.id),
        region: whereOn(on, terminalBounds).region,
        // Whether the buddy can see it from where it stands, which is the only
        // thing that changes how you'd say it out loud.
        sameScreen: !!where && where.displayId === on.id,
      };
    }
  }

  return { displays: described, neighbors: neighbors(displays), where, terminal };
}

/** How a neighbour reads from where the buddy is standing. */
const SIDE_WORDS = {
  right: 'to its right',
  left: 'to its left',
  above: 'above it',
  below: 'below it',
};

/** "a, b and c" — an English list, not a comma-joined array. */
function listOf(parts) {
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The world in a sentence or three, for a prompt.
 *
 * This is what the pet is *told* about where it is: which screen it's standing
 * on and whereabouts, what's next to that screen, and anything else on the
 * desk it can't see from there. Prose rather than JSON because it goes into a
 * system prompt, and pure like the rest of this module so the wording is
 * something a test can hold still.
 *
 * @param {{displays:Array,neighbors:Array,where:object|null}} world  habitatFrom's answer
 * @returns {string} '' when there is nothing worth saying
 */
function describePlace(world) {
  if (!world || !world.displays.length) return '';
  const { displays, neighbors: exits, where, terminal } = world;
  const nameOf = (id) => displays.find((d) => d.id === id)?.name || 'another screen';
  const said = new Set();
  const sentences = [];

  // Sizes come along because the pet gets asked about them ("how big is my
  // screen?"), and because "the big one" is how people refer to a display.
  const sizeOf = (id) => {
    const d = displays.find((x) => x.id === id);
    return d ? ` (${d.bounds.width}×${d.bounds.height})` : '';
  };

  if (where) {
    said.add(where.displayId);
    const spot = where.region === 'middle' ? 'in the middle of' : `near the ${where.region} of`;
    const only = displays.length === 1 ? ', the only screen there is' : '';
    sentences.push(`You are standing ${spot} the ${where.name}${sizeOf(where.displayId)}${only}.`);

    const near = exits.filter((n) => n.from === where.displayId);
    if (near.length) {
      for (const n of near) said.add(n.to);
      const listed = listOf(
        near.map((n) => `the ${nameOf(n.to)}${sizeOf(n.to)} is ${SIDE_WORDS[n.side]}`)
      );
      sentences.push(`${listed[0].toUpperCase()}${listed.slice(1)}.`);
    }
  }

  // The session's own window, when Clippy is perched and has measured it.
  // Worth saying because it is the thing the pet sits on top of: "the screen
  // the work is on" is the most useful landmark it has.
  if (terminal) {
    said.add(terminal.displayId);
    sentences.push(
      terminal.sameScreen
        ? "The session's terminal is on this screen too."
        : `The session's terminal is over on the ${terminal.name}.`
    );
  }

  // Screens the sentences above never mentioned: either the buddy's own
  // display has no neighbours, or there was no window to place at all.
  const rest = displays.filter((d) => !said.has(d.id));
  if (rest.length && rest.length < displays.length) {
    sentences.push(`Further off: ${listOf(rest.map((d) => `the ${d.name}`))}.`);
  } else if (rest.length) {
    sentences.push(`The screens here are ${listOf(rest.map((d) => `the ${d.name}`))}.`);
  }

  return sentences.join(' ');
}

/**
 * The spots a person actually names: the four corners and the middle. Not all
 * nine regions `whereOn` can report — "the left edge of the Studio Display" is
 * something code computes for a patrol, not something anybody asks for out
 * loud, and every extra row is a row the model has to read.
 */
const SPOTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle'];

/**
 * Everywhere a buddy could be sent, as an ordered list.
 *
 * Meant to be numbered by the caller and offered to the pet model the way
 * delegate.js offers its roster: the answer is a row or it is nothing. A model
 * asked for coordinates can return a plausible, wrong pixel — between two
 * monitors, or off the bottom of a shorter one — and nothing downstream can
 * tell that from a good answer. A row number either resolves or it doesn't,
 * and the geometry stays here where it is exact.
 *
 * @param {object} world  habitatFrom's answer
 * @returns {Array<{label:string,displayId:number,region:string}>}
 */
function destinations(world) {
  if (!world || !world.displays.length) return [];
  const out = [];
  for (const d of world.displays) {
    for (const region of SPOTS) {
      out.push({ label: `the ${region} of the ${d.name}`, displayId: d.id, region });
    }
  }
  // A landmark worth naming, because it is where the work is and the user is
  // more likely to say "come over to my terminal" than to name a corner.
  if (world.terminal) {
    out.push({
      label: `where the session's terminal is (the ${world.terminal.name})`,
      displayId: world.terminal.displayId,
      region: world.terminal.region,
    });
  }
  return out;
}

/**
 * A chosen destination as an actual top-left corner for the window.
 *
 * The work area rather than the raw bounds, so a corner is never under the
 * menu bar or behind the dock — the same bargain arrange.js makes.
 *
 * @param {object} display   one of world.displays
 * @param {string} region    a SPOTS value (anything else centres on that axis)
 * @param {{width:number,height:number}} size  the buddy window
 * @param {number} [gap]     breathing room from the edges
 * @returns {{x:number,y:number}}
 */
function spotFor(display, region, size, gap = 0) {
  const wa = display.workArea;
  const name = String(region || '');
  const x = name.includes('left')
    ? wa.x + gap
    : name.includes('right')
      ? wa.x + wa.width - gap - size.width
      : Math.round(wa.x + (wa.width - size.width) / 2);
  const y = name.startsWith('top')
    ? wa.y + gap
    : name.startsWith('bottom')
      ? wa.y + wa.height - gap - size.height
      : Math.round(wa.y + (wa.height - size.height) / 2);
  return { x, y };
}

module.exports = {
  friendlyNames,
  sharedEdge,
  neighbors,
  displayFor,
  whereOn,
  habitatFrom,
  describePlace,
  destinations,
  spotFor,
  SPOTS,
};
