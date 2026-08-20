'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { askArgs, askClaude } = require('../src/pet-cli');
const { replyText } = require('../src/pet-chat');

test('the pet is asked without tools, and without a coding preamble', () => {
  const args = askArgs({ prompt: 'where are you?', system: 'You are a cat.', model: 'haiku' });
  assert.equal(args[0], '-p');
  assert.equal(args[1], 'where are you?');
  // The persona replaces Claude Code's own system prompt rather than being
  // appended to it: the pet is not a coding agent and must not be told it is.
  assert.ok(args.includes('--system-prompt'), args.join(' '));
  assert.ok(!args.includes('--append-system-prompt'), args.join(' '));
  // A sentence, not a session.
  assert.ok(args.includes('--allowed-tools'), args.join(' '));
  // Nothing of the user's setup comes with it. The hooks are the load-bearing
  // one: Clippy's own live in those settings, so without this, asking the pet
  // a question fires UserPromptSubmit at Clippy and it grows a phantom buddy
  // for a conversation the user had with an existing one.
  assert.ok(args.includes('--safe-mode'), args.join(' '));
  // --bare reads auth strictly from an API key and never touches the login the
  // user already has, which is the one thing this must never do.
  assert.ok(!args.includes('--bare'), args.join(' '));
});

test('a model with no name asks for no model, rather than an empty one', () => {
  const args = askArgs({ prompt: 'hi' });
  assert.ok(!args.includes('--model'), args.join(' '));
  assert.ok(!args.includes('--system-prompt'), args.join(' '));
});

test('an answer comes back in the shape the pet already reads', async () => {
  // /bin/echo stands in for the CLI: it prints its arguments, which is enough
  // to prove the words make the round trip without spending anything.
  const messages = await askClaude({ prompt: 'hello there', bin: '/bin/echo' });
  const { text, error } = replyText(messages);
  assert.ok(!error, `unexpected failure: ${error}`);
  assert.match(text, /-p hello there/);
});

test('a machine with no claude on it says so, and does not throw', async () => {
  const messages = await askClaude({ prompt: 'hi', bin: '/nowhere/at/all/claude' });
  const { error } = replyText(messages);
  assert.ok(error, 'a missing binary must come back as words');
  assert.equal(messages[0].is_error, true);
});
