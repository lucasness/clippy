'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { looksLikeAnErrand, errandPrompt, parseErrand, onMyWay } = require('../src/errand');

const PLACES = [
  { label: 'the top-left of the Studio Display', displayId: 1, region: 'top-left' },
  { label: 'the top-right of the Studio Display', displayId: 1, region: 'top-right' },
  { label: 'the middle of the MacBook screen', displayId: 2, region: 'middle' },
];

test('an errand is a message with somewhere in it, and going in it', () => {
  for (const said of [
    'go to the top right',
    'come over here',
    'walk to the MacBook screen',
    'get off my terminal window',
    'climb up the left edge',
  ]) {
    assert.equal(looksLikeAnErrand(said), true, said);
  }
});

test('conversation is not an errand, and never costs a round trip', () => {
  for (const said of [
    'hello!',
    'what are you up to?',
    'how is the build going',
    'do you like it here',
    'what model are you',
  ]) {
    assert.equal(looksLikeAnErrand(said), false, said);
  }
});

test('the places are numbered, so an answer is a row or it is nothing', () => {
  const prompt = errandPrompt(PLACES, 'go to the top right');
  assert.match(prompt, /1\. the top-left of the Studio Display/);
  assert.match(prompt, /3\. the middle of the MacBook screen/);
  assert.match(prompt, /go to the top right/);
  // The safe answer has to be offered, or a model given only good options
  // picks one of them.
  assert.match(prompt, /or the word none/);
  // And "where are you?" must be named as a question, not an errand — it is
  // the likeliest thing to be misread as one.
  assert.match(prompt, /"Where are you\?" is a question, not an errand/);
});

test('a row number is read, and nothing else is', () => {
  assert.equal(parseErrand('2', PLACES).place.region, 'top-right');
  assert.equal(parseErrand('2. the top right of the Studio', PLACES).index, 1);
  assert.equal(parseErrand('none', PLACES).place, null);
  assert.equal(parseErrand('', PLACES).place, null);
  // A number buried mid-sentence is as likely to be a count as a choice.
  assert.equal(parseErrand('I think maybe 2 of those', PLACES).place, null);
  // And a row that does not exist is not a row.
  assert.equal(parseErrand('9', PLACES).place, null);
  assert.equal(parseErrand('0', PLACES).place, null);
});

test('the pet says where it is going, in its own voice', () => {
  assert.equal(onMyWay(PLACES[1]), 'On my way to top-right of the Studio Display.');
  assert.match(onMyWay(null), /On my way/);
});
