'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { habitatFrom } = require('../src/habitat');
const { canStandAt, nearestSpot, displayPath, routeBetween } = require('../src/travel');

// The same desk habitat.test.js uses: Studio primary, MacBook docked to its
// right and sitting lower, both in the one macOS coordinate space.
const STUDIO = {
  id: 1,
  label: 'Studio Display',
  internal: false,
  scaleFactor: 2,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 25, width: 2560, height: 1415 },
};
const MACBOOK = {
  id: 2,
  label: 'Built-in Retina Display',
  internal: true,
  scaleFactor: 2,
  bounds: { x: 2560, y: 400, width: 1512, height: 982 },
  workArea: { x: 2560, y: 425, width: 1512, height: 957 },
};
const DESK = [STUDIO, MACBOOK];
const BUDDY = { width: 124, height: 196 };
const at = (x, y) => ({ x, y, ...BUDDY });
const world = (bounds) => habitatFrom(DESK, bounds);

test('a spot inside the work area is somewhere to stand', () => {
  const { ok, displayId } = canStandAt(world(), at(400, 400));
  assert.equal(ok, true);
  assert.equal(displayId, STUDIO.id);
});

test('a window hanging off the edge is not', () => {
  const off = canStandAt(world(), at(2560 - 60, 100)); // straddling the boundary
  assert.equal(off.ok, false);
  assert.equal(off.reason, 'hangs off the edge');
  // Under the menu bar is refused for the same reason.
  assert.equal(canStandAt(world(), at(100, 0)).ok, false);
});

test('the gap between two monitors is nowhere to stand', () => {
  // Level with the Studio's top, but past its right edge — the MacBook does
  // not start until y=400, so this is empty space.
  const gap = canStandAt(world(), at(2700, 60));
  assert.equal(gap.ok, false);
});

test('nowhere legal comes back as the nearest place that is', () => {
  const fixed = nearestSpot(world(), at(100, 0));
  assert.deepEqual(fixed, { x: 100, y: STUDIO.workArea.y, displayId: STUDIO.id });
  assert.equal(canStandAt(world(), { ...fixed, ...BUDDY }).ok, true);
});

test('the way between two screens is the fewest crossings', () => {
  const w = world();
  assert.deepEqual(displayPath(w, STUDIO.id, STUDIO.id), [STUDIO.id]);
  assert.deepEqual(displayPath(w, STUDIO.id, MACBOOK.id), [STUDIO.id, MACBOOK.id]);
});

test('screens that touch nothing cannot be walked to', () => {
  const island = { ...STUDIO, id: 9, bounds: { x: 9000, y: 0, width: 1024, height: 768 },
    workArea: { x: 9000, y: 25, width: 1024, height: 743 } };
  const w = habitatFrom([...DESK, island]);
  assert.equal(displayPath(w, STUDIO.id, 9), null);
  const trip = routeBetween(w, at(100, 100), { x: 9100, y: 100 });
  assert.equal(trip.ok, false);
  assert.equal(trip.reason, 'no way across');
});

test('a walk on one screen is a single leg, no crossing', () => {
  const trip = routeBetween(world(), at(100, 100), { x: 800, y: 900 });
  assert.equal(trip.ok, true);
  assert.equal(trip.adjusted, false);
  assert.deepEqual(trip.legs, [{ x: 800, y: 900, displayId: STUDIO.id, crossing: false }]);
});

test('crossing to another screen goes to the doorway, through it, then on', () => {
  const trip = routeBetween(world(), at(100, 1000), { x: 3200, y: 800 });
  assert.equal(trip.ok, true);
  assert.equal(trip.legs.length, 3);

  const [toDoor, through, arrive] = trip.legs;
  // Walk to the boundary without crossing it: the buddy's right edge lands on
  // the shared edge, still on the Studio.
  assert.equal(toDoor.x + BUDDY.width, 2560);
  assert.equal(toDoor.displayId, STUDIO.id);
  assert.equal(toDoor.crossing, false);
  // Then the hop: one step across, never straddling both displays.
  assert.equal(through.crossing, true);
  assert.equal(through.x, 2560);
  assert.equal(through.displayId, MACBOOK.id);
  // And the final walk to where we were actually going.
  assert.deepEqual(arrive, { x: 3200, y: 800, displayId: MACBOOK.id, crossing: false });
});

test('the doorway is the part of the gap nearest the way you are heading', () => {
  // The shared edge spans y 400..1382, and the crossing slides along it to
  // meet the journey rather than always using the same spot.
  const high = routeBetween(world(), at(100, 1000), { x: 3200, y: 430 });
  const low = routeBetween(world(), at(100, 100), { x: 3200, y: 1100 });
  assert.ok(low.legs[0].y > high.legs[0].y, `${high.legs[0].y} -> ${low.legs[0].y}`);
  // Aiming above the doorway pins the crossing to its top edge; the buddy
  // cannot squeeze through where the two screens do not actually meet.
  assert.equal(high.legs[0].y, 400);
  for (const trip of [high, low]) {
    assert.ok(trip.legs[0].y >= 400, `above the gap: ${trip.legs[0].y}`);
    assert.ok(trip.legs[0].y + BUDDY.height <= 1382, `below the gap: ${trip.legs[0].y}`);
  }
});

test('every leg of a journey is somewhere a buddy could actually stand', () => {
  const trip = routeBetween(world(), at(100, 1000), { x: 3200, y: 800 });
  for (const leg of trip.legs) {
    if (leg.crossing) continue; // mid-hop is a step, not a place to stop
    assert.equal(canStandAt(world(), { x: leg.x, y: leg.y, ...BUDDY }).ok, true, JSON.stringify(leg));
  }
});

test('an impossible destination is pulled back on screen, and says so', () => {
  // Far off the bottom-right of everything.
  const trip = routeBetween(world(), at(100, 100), { x: 99999, y: 99999 });
  assert.equal(trip.ok, true);
  assert.equal(trip.adjusted, true);
  assert.equal(trip.reason, 'pulled back on screen');
  const last = trip.legs[trip.legs.length - 1];
  assert.equal(canStandAt(world(), { x: last.x, y: last.y, ...BUDDY }).ok, true);
});

test('a coordinate in the gap between monitors cannot strand the buddy', () => {
  // Exactly the failure mode that made handing a model raw pixels risky.
  const trip = routeBetween(world(), at(100, 100), { x: 2700, y: 60 });
  assert.equal(trip.adjusted, true);
  const last = trip.legs[trip.legs.length - 1];
  assert.equal(canStandAt(world(), { x: last.x, y: last.y, ...BUDDY }).ok, true);
});

test('no screens, no journey', () => {
  const empty = habitatFrom([]);
  assert.equal(routeBetween(empty, at(0, 0), { x: 10, y: 10 }).ok, false);
  assert.equal(canStandAt(empty, at(0, 0)).ok, false);
  assert.equal(nearestSpot(empty, at(0, 0)), null);
});
