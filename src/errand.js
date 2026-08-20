'use strict';

/**
 * Working out whether you just asked the pet to go somewhere.
 *
 * "Go and check on the MacBook screen", "come over here", "go sit in the top
 * right" — a person says where they want the buddy, and it walks there. The
 * question is a small language one, which is what the pet model is already
 * there for.
 *
 * The shape is delegate.js's, for the same reason: the places are numbered
 * rather than named, so the answer is a token that cannot be half-right. "The
 * MacBook screen" could be either of two identical displays; "3" is a row or
 * it is nothing. And `none` is offered explicitly and described as the safe
 * answer, because a model given only good options will pick one.
 *
 * Being wrong is cheap here in a way it is not in delegate.js — a buddy in the
 * wrong corner is a shrug, not work in somebody's repository — so this is
 * allowed to guess where that one refuses to. What it must not do is walk off
 * on a message that was never about walking, which is what the wording of the
 * question and the strictness of the reading are both for.
 */

/** Keep prompt lines short and single-line — this text comes from a chat box. */
const line = (value, max = 160) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Worth asking the model at all?
 *
 * The pet is chatted to far more often than it is sent anywhere, and every
 * question costs a round trip and a moment of the user's allowance. A message
 * with no sense of place or motion in it is not an errand, and saying so here
 * is free.
 */
const MOVEMENT = /\b(go|goto|move|walk|come|crawl|climb|head|hop|jump|get|sit|stand|stay|wander|over)\b/i;
const PLACE = /\b(screen|display|monitor|macbook|laptop|corner|left|right|top|bottom|middle|centre|center|edge|side|here|there|terminal|window|up|down|across|over)\b/i;

function looksLikeAnErrand(text) {
  const said = String(text || '');
  return MOVEMENT.test(said) && PLACE.test(said);
}

/**
 * The question put to the model.
 *
 * @param {Array<{label: string}>} places  destinations(world) from habitat.js
 * @param {string} text  what the user typed
 */
function errandPrompt(places, text) {
  const rows = (places || []).map((p, i) => `${i + 1}. ${line(p.label, 80)}`);
  return [
    'A small pixel-art pet lives on the user\'s screen and can walk to any of',
    'these places:',
    '',
    ...rows,
    '',
    `The user said: "${line(text, 400)}"`,
    '',
    'Are they asking the pet to move, and if so where to? Answer with the',
    'number alone, or the word none.',
    'Answer none if they are making conversation, asking a question, talking',
    'about the coding session, or saying anything that is not a request to go',
    'somewhere. "Where are you?" is a question, not an errand.',
  ].join('\n');
}

/**
 * Read the model's answer.
 *
 * The number has to be the first thing said, exactly as in delegate.js: a "2"
 * fished out of the middle of a sentence is as likely to be a count as a
 * choice.
 *
 * @returns {{place: object|null, index: number}}
 */
function parseErrand(reply, places) {
  const rows = places || [];
  const said = String(reply || '').trim();
  if (!said || /^\s*none\b/i.test(said)) return { place: null, index: -1 };

  const m = /^\s*(?:#|no\.?\s*)?(\d{1,2})\b/.exec(said);
  if (!m) return { place: null, index: -1 };

  const pick = Number(m[1]);
  if (!Number.isInteger(pick) || pick < 1 || pick > rows.length) return { place: null, index: -1 };
  return { place: rows[pick - 1], index: pick - 1 };
}

/** What the buddy says on its way. Its own voice, not a status line. */
const onMyWay = (place) => `On my way to ${String(place?.label || 'it').replace(/^the /, '')}.`;

module.exports = { looksLikeAnErrand, errandPrompt, parseErrand, onMyWay };
