'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  friendlyNames,
  sharedEdge,
  neighbors,
  displayFor,
  whereOn,
  habitatFrom,
  describePlace,
} = require('../src/habitat');

// A desk that actually exists: a Studio Display as the primary, with the
// MacBook's own panel docked to its right and sitting a little lower, the way
// macOS arranges them when the lid is open. Coordinates are the shared space
// Electron reports — the MacBook's top edge starts 400px down the Studio's.
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

// A buddy-sized window, for standing on things.
const BUDDY = { width: 124, height: 196 };
const at = (x, y) => ({ x, y, ...BUDDY });

test('the built-in panel is the MacBook screen, no matter what macOS labels it', () => {
  const names = friendlyNames(DESK);
  assert.equal(names.get(MACBOOK.id), 'MacBook screen');
  assert.equal(names.get(STUDIO.id), 'Studio Display');
});

test('a monitor macOS could not name is still a display', () => {
  const names = friendlyNames([{ ...STUDIO, label: '' }]);
  assert.equal(names.get(STUDIO.id), 'external display');
});

test('twin monitors side by side are told apart as left and right', () => {
  const twinA = { ...STUDIO, id: 10 };
  const twinB = { ...STUDIO, id: 11, bounds: { ...STUDIO.bounds, x: 2560 } };
  const names = friendlyNames([twinB, twinA]); // order handed in must not matter
  assert.equal(names.get(10), 'left Studio Display');
  assert.equal(names.get(11), 'right Studio Display');
});

test('twins stacked one above the other become upper and lower instead', () => {
  const twinA = { ...STUDIO, id: 10 };
  const twinB = { ...STUDIO, id: 11, bounds: { ...STUDIO.bounds, y: 1440 } };
  const names = friendlyNames([twinA, twinB]);
  assert.equal(names.get(10), 'upper Studio Display');
  assert.equal(names.get(11), 'lower Studio Display');
});

test('three across get a middle; a wall of four falls back to counting', () => {
  const across = (n) =>
    Array.from({ length: n }, (_, i) => ({
      ...STUDIO,
      id: 20 + i,
      bounds: { ...STUDIO.bounds, x: i * 2560 },
    }));
  const trio = friendlyNames(across(3));
  assert.equal(trio.get(21), 'middle Studio Display');
  const wall = friendlyNames(across(4));
  assert.equal(wall.get(20), 'Studio Display 1');
  assert.equal(wall.get(23), 'Studio Display 4');
});

test('displays that touch share a portal exactly as long as their common edge', () => {
  const edge = sharedEdge(STUDIO.bounds, MACBOOK.bounds);
  // Leaving the Studio for the MacBook means going right, through the stretch
  // of boundary both displays actually own: from where the MacBook's panel
  // starts (y=400) down to where it ends (y=1382) — the Studio goes on below,
  // but there is no doorway past a neighbour's edge.
  assert.deepEqual(edge, { side: 'right', portal: { at: 2560, start: 400, end: 1382 } });
});

test('the way back mirrors the way there', () => {
  const back = sharedEdge(MACBOOK.bounds, STUDIO.bounds);
  assert.equal(back.side, 'left');
  assert.deepEqual(back.portal, { at: 2560, start: 400, end: 1382 });
});

test('displays stacked vertically meet above and below', () => {
  const below = { x: 0, y: 1440, width: 2560, height: 1440 };
  assert.equal(sharedEdge(STUDIO.bounds, below).side, 'below');
  assert.deepEqual(sharedEdge(below, STUDIO.bounds), {
    side: 'above',
    portal: { at: 1440, start: 0, end: 2560 },
  });
});

test('meeting at a single corner is not a doorway', () => {
  const diagonal = { x: 2560, y: 1440, width: 1512, height: 982 };
  assert.equal(sharedEdge(STUDIO.bounds, diagonal), null);
});

test('displays that do not touch are not neighbours at all', () => {
  const far = { ...MACBOOK, bounds: { ...MACBOOK.bounds, x: 3000 } };
  assert.deepEqual(neighbors([STUDIO, far]), []);
});

test('neighbours come in matched pairs, one entry standing on each side', () => {
  const found = neighbors(DESK);
  assert.equal(found.length, 2);
  const [going, coming] = [
    found.find((n) => n.from === STUDIO.id),
    found.find((n) => n.from === MACBOOK.id),
  ];
  assert.equal(going.to, MACBOOK.id);
  assert.equal(going.side, 'right');
  assert.equal(coming.side, 'left');
  assert.deepEqual(going.portal, coming.portal);
});

test('a window belongs to the display holding most of it', () => {
  assert.equal(displayFor(DESK, at(100, 100)).id, STUDIO.id);
  // Straddling the boundary, but most of it hangs over the MacBook side.
  assert.equal(displayFor(DESK, at(2560 - 30, 500)).id, MACBOOK.id);
});

test('a window lost in empty space still belongs somewhere nearby', () => {
  // Above the MacBook's panel there is no display at all — mid-hop, or a
  // monitor that was just unplugged. Its nearest centre is the MacBook's.
  assert.equal(displayFor(DESK, at(3000, 100)).id, MACBOOK.id);
  assert.equal(displayFor([], at(0, 0)), null);
});

test('where on a display reads like directions, thirds each way', () => {
  const wa = STUDIO.workArea;
  const corner = whereOn(STUDIO, at(wa.x + wa.width - BUDDY.width, wa.y + wa.height - BUDDY.height));
  assert.equal(corner.region, 'bottom-right');
  const centred = whereOn(STUDIO, at(wa.x + wa.width / 2 - BUDDY.width / 2, wa.y + wa.height / 2));
  assert.equal(centred.region, 'middle');
  const topOnly = whereOn(STUDIO, at(wa.x + wa.width / 2 - BUDDY.width / 2, wa.y));
  assert.equal(topOnly.region, 'top');
});

test('the work area is the map, so the menu bar cannot be stood on', () => {
  // A window pinned to the display's very top: its centre sits above the work
  // area, which clamps to the top edge rather than inventing a negative spot.
  const { y, region } = whereOn(STUDIO, { x: 0, y: -180, ...BUDDY });
  assert.equal(y, 0);
  assert.ok(region.startsWith('top'));
});

test('the whole habitat reads the way the desk looks', () => {
  const world = habitatFrom(DESK, at(2600, 1100));
  assert.deepEqual(
    world.displays.map((d) => d.name),
    ['Studio Display', 'MacBook screen']
  );
  const [studio, macbook] = world.displays;
  assert.equal(studio.primary, true); // its corner is the origin
  assert.equal(macbook.primary, false);
  assert.equal(macbook.internal, true);
  assert.equal(world.neighbors.length, 2);
  assert.equal(world.where.name, 'MacBook screen');
  assert.equal(world.where.region, 'bottom-left');
});

test('no window means no where, not a crash', () => {
  assert.equal(habitatFrom(DESK).where, null);
  assert.deepEqual(habitatFrom([]), { displays: [], neighbors: [], where: null, terminal: null });
});

/* ---------- Saying it out loud ---------- */

test('the pet is told where it stands and what is next door', () => {
  const said = describePlace(habitatFrom(DESK, at(2600, 1100)));
  assert.equal(
    said,
    'You are standing near the bottom-left of the MacBook screen. ' +
      'The Studio Display is to its left.'
  );
});

test('one screen is described as the only one, with no neighbours invented', () => {
  const said = describePlace(habitatFrom([STUDIO], at(100, 100)));
  assert.match(said, /the only screen there is/);
  assert.ok(!said.includes('right'), said);
});

test('the middle of a screen is the middle, not "near the middle"', () => {
  const wa = STUDIO.workArea;
  const middle = at(wa.x + wa.width / 2 - BUDDY.width / 2, wa.y + wa.height / 2);
  assert.match(describePlace(habitatFrom([STUDIO], middle)), /standing in the middle of/);
});

test('two neighbours are read out as a list, not a run-on', () => {
  const above = { ...STUDIO, id: 3, label: 'TV', bounds: { x: 0, y: -1440, width: 2560, height: 1440 } };
  const said = describePlace(habitatFrom([...DESK, above], at(100, 100)));
  assert.match(said, /The MacBook screen is to its right and the TV is above it\./);
});

test('a screen the buddy cannot see from here is still mentioned', () => {
  // An island: touching nothing, so it is nobody's neighbour.
  const island = { ...STUDIO, id: 4, label: 'Sidecar', bounds: { x: 9000, y: 0, width: 1024, height: 768 } };
  const said = describePlace(habitatFrom([...DESK, island], at(100, 100)));
  assert.match(said, /Further off: the Sidecar\./);
});

test('with no window to place, the desk is still described', () => {
  const said = describePlace(habitatFrom(DESK));
  assert.equal(said, 'The screens here are the Studio Display and the MacBook screen.');
});

test('no screens at all is silence, not a broken sentence', () => {
  assert.equal(describePlace(habitatFrom([])), '');
  assert.equal(describePlace(null), '');
});

test('the pet is told which screen the work is on', () => {
  // Buddy on the Studio, terminal over on the MacBook panel.
  const said = describePlace(habitatFrom(DESK, at(100, 100), at(2700, 700)));
  assert.match(said, /The session's terminal is over on the MacBook screen\./);
});

test('a terminal on the same screen is said differently', () => {
  const said = describePlace(habitatFrom(DESK, at(100, 100), at(300, 300)));
  assert.match(said, /terminal is on this screen too\./);
  assert.doesNotMatch(said, /over on/);
});

test('a terminal Clippy has not measured is not guessed at', () => {
  assert.equal(habitatFrom(DESK, at(100, 100)).terminal, null);
  assert.doesNotMatch(describePlace(habitatFrom(DESK, at(100, 100))), /terminal/);
});

test('naming the terminal screen does not also list it as further off', () => {
  const island = { ...STUDIO, id: 4, label: 'Sidecar', bounds: { x: 9000, y: 0, width: 1024, height: 768 } };
  const said = describePlace(habitatFrom([...DESK, island], at(100, 100), at(9100, 100)));
  assert.match(said, /terminal is over on the Sidecar\./);
  assert.doesNotMatch(said, /Further off/);
});
