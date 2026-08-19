'use strict';

/**
 * Getting from where the buddy is to where it was asked to be.
 *
 * habitat.js describes the arena — which screens exist, how they touch, where
 * a window is. This works out journeys across it: whether a spot is somewhere
 * a buddy could actually stand, the nearest place it could if not, and the
 * route between two points when they're on different screens.
 *
 * Pure geometry, like habitat: it computes a path and returns it. Animating
 * along that path — how fast, how straight, whether the walk is abandoned
 * because a real card arrived — belongs to whoever owns the window.
 *
 * A journey is a list of legs. Most are ordinary walking; the ones marked
 * `crossing: true` are where the window passes from one display to the next.
 * They matter because a macOS window straddling two displays with different
 * `scaleFactor`s misbehaves, so the caller walks to the boundary, moves the
 * window across in one step, and resumes — which also happens to read as the
 * pet squeezing through.
 */

const { displayFor, sharedEdge } = require('./habitat');

/** Keep a value inside a range. */
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** The centre of a rectangle. */
const centre = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/**
 * Could a buddy stand here?
 *
 * "Here" is a whole window, not a point: a rectangle that hangs off the side
 * of a display is not somewhere to stand, even if its top-left corner is on
 * one. The work area rather than the raw bounds, so the answer respects the
 * menu bar, the notch and the dock.
 *
 * @param {object} world  habitatFrom's answer
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @returns {{ok:boolean, displayId:number|null, reason:string}}
 */
function canStandAt(world, bounds) {
  if (!world || !world.displays.length) return { ok: false, displayId: null, reason: 'no screens' };
  if (!bounds) return { ok: false, displayId: null, reason: 'nowhere given' };

  const display = displayFor(world.displays, bounds);
  if (!display) return { ok: false, displayId: null, reason: 'no screen there' };

  const wa = display.workArea;
  const inside =
    bounds.x >= wa.x &&
    bounds.y >= wa.y &&
    bounds.x + bounds.width <= wa.x + wa.width &&
    bounds.y + bounds.height <= wa.y + wa.height;

  return inside
    ? { ok: true, displayId: display.id, reason: '' }
    : { ok: false, displayId: display.id, reason: 'hangs off the edge' };
}

/**
 * The nearest spot a buddy could actually stand, given somewhere it can't.
 *
 * Slides the window back inside the work area of whichever display already
 * holds most of it — the same correction a person makes when they drop a
 * window half off the screen. A window larger than the display it's on is
 * pinned to the top-left rather than centred on nothing.
 *
 * @returns {{x:number,y:number,displayId:number}|null} null only with no screens
 */
function nearestSpot(world, bounds) {
  if (!world || !world.displays.length || !bounds) return null;
  const display = displayFor(world.displays, bounds);
  if (!display) return null;
  const wa = display.workArea;
  return {
    x: Math.round(clamp(bounds.x, wa.x, Math.max(wa.x, wa.x + wa.width - bounds.width))),
    y: Math.round(clamp(bounds.y, wa.y, Math.max(wa.y, wa.y + wa.height - bounds.height))),
    displayId: display.id,
  };
}

/**
 * The chain of displays to walk through to get from one to another.
 *
 * Breadth-first over the neighbour graph, so the answer is the fewest screens
 * crossed. Returns display ids starting with `fromId` and ending with `toId`,
 * or null when there is no way through — two monitors that touch nothing, or
 * a display that has just been unplugged.
 */
function displayPath(world, fromId, toId) {
  if (fromId === toId) return [fromId];
  const queue = [[fromId]];
  const seen = new Set([fromId]);
  while (queue.length) {
    const path = queue.shift();
    const last = path[path.length - 1];
    for (const hop of world.neighbors.filter((n) => n.from === last)) {
      if (seen.has(hop.to)) continue;
      const next = [...path, hop.to];
      if (hop.to === toId) return next;
      seen.add(hop.to);
      queue.push(next);
    }
  }
  return null;
}

/**
 * Where on the shared edge between two displays the buddy crosses.
 *
 * The portal is a stretch, not a point, so the crossing happens as close to
 * the straight line of travel as the doorway allows — walk toward where you're
 * going, and squeeze through at the nearest part of the gap. `at` is the
 * boundary itself; the buddy's leading edge stops there and the window is
 * moved across in one step rather than straddling.
 */
function portalPoint(edge, aim, size) {
  const { side, portal } = edge;
  if (side === 'left' || side === 'right') {
    const low = portal.start;
    const high = Math.max(portal.start, portal.end - size.height);
    return {
      x: side === 'right' ? portal.at - size.width : portal.at,
      y: Math.round(clamp(aim.y - size.height / 2, low, high)),
    };
  }
  const low = portal.start;
  const high = Math.max(portal.start, portal.end - size.width);
  return {
    x: Math.round(clamp(aim.x - size.width / 2, low, high)),
    y: side === 'below' ? portal.at - size.height : portal.at,
  };
}

/**
 * A journey from where the buddy is to where it should be.
 *
 * The destination is validated first and pulled back inside the work area if
 * it isn't somewhere a window can sit, so a caller may pass any coordinate it
 * likes — including one a language model suggested — without being able to
 * strand the buddy in the gap between two monitors or off the bottom of a
 * shorter screen. What comes back is honest about what it did.
 *
 * @param {object} world  habitatFrom's answer
 * @param {{x,y,width,height}} from   the buddy's window now
 * @param {{x:number,y:number}} to    a top-left corner to end at
 * @returns {{ok:boolean, legs:Array<{x,y,displayId,crossing:boolean}>,
 *            adjusted:boolean, reason:string}}
 */
function routeBetween(world, from, to) {
  const nowhere = { ok: false, legs: [], adjusted: false, reason: 'no screens' };
  if (!world || !world.displays.length || !from || !to) return nowhere;

  const size = { width: from.width, height: from.height };
  const wanted = { ...to, ...size };
  const check = canStandAt(world, wanted);

  // Anywhere is allowed to be asked for; only somewhere real is walked to.
  let target = { x: wanted.x, y: wanted.y };
  let adjusted = false;
  if (!check.ok) {
    const fixed = nearestSpot(world, wanted);
    if (!fixed) return { ...nowhere, reason: check.reason };
    target = { x: fixed.x, y: fixed.y };
    adjusted = true;
  }

  const start = displayFor(world.displays, from);
  const end = displayFor(world.displays, { ...target, ...size });
  if (!start || !end) return { ...nowhere, reason: 'no screen there' };

  const chain = displayPath(world, start.id, end.id);
  if (!chain) {
    return { ok: false, legs: [], adjusted, reason: 'no way across' };
  }

  // One leg per screen boundary, then the final walk to the destination.
  const legs = [];
  let standing = from;
  for (let i = 0; i < chain.length - 1; i += 1) {
    const hop = world.neighbors.find((n) => n.from === chain[i] && n.to === chain[i + 1]);
    const edge = hop || sharedEdge(
      world.displays.find((d) => d.id === chain[i]).bounds,
      world.displays.find((d) => d.id === chain[i + 1]).bounds
    );
    if (!edge) return { ok: false, legs: [], adjusted, reason: 'no way across' };
    const door = portalPoint(edge, target, size);
    legs.push({ ...door, displayId: chain[i], crossing: false });
    // The step through the doorway: the window lands on the far side rather
    // than straddling two displays, which is what different scale factors
    // cannot survive.
    const through =
      edge.side === 'right'
        ? { x: door.x + size.width, y: door.y }
        : edge.side === 'left'
          ? { x: door.x - size.width, y: door.y }
          : edge.side === 'below'
            ? { x: door.x, y: door.y + size.height }
            : { x: door.x, y: door.y - size.height };
    legs.push({ ...through, displayId: chain[i + 1], crossing: true });
    standing = { ...through, ...size };
  }
  legs.push({ ...target, displayId: end.id, crossing: false });

  return { ok: true, legs, adjusted, reason: adjusted ? 'pulled back on screen' : '' };
}

/**
 * How long a leg should take.
 *
 * A fixed duration per leg is what the point-at-prompt walk uses, and it is
 * right there because the distance is always about the same. Across a desk it
 * is wrong in both directions: a hop to the next corner crawls, and a march
 * across two monitors arrives too fast to read as walking. So a journey moves
 * at a speed instead, with a floor so short legs are still visible and a
 * ceiling so a wide arrangement doesn't become a wait.
 */
const WALK_SPEED = 420; // pixels per second
const MIN_WALK_MS = 260;
const MAX_WALK_MS = 2400;

function walkMsFor(from, to, speed = WALK_SPEED) {
  const dx = (to.x || 0) - (from.x || 0);
  const dy = (to.y || 0) - (from.y || 0);
  const distance = Math.sqrt(dx * dx + dy * dy);
  const ms = (distance / Math.max(1, speed)) * 1000;
  return Math.round(clamp(ms, MIN_WALK_MS, MAX_WALK_MS));
}

module.exports = {
  canStandAt,
  nearestSpot,
  displayPath,
  portalPoint,
  routeBetween,
  walkMsFor,
  WALK_SPEED,
  MIN_WALK_MS,
  MAX_WALK_MS,
};
