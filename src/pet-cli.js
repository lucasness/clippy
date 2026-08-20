'use strict';

/**
 * Talking to the small model through the `claude` binary the user already has.
 *
 * The Agent SDK does the same job and does it well, but on a subscription plan
 * its usage draws on a *separate* Agent SDK allowance rather than the one the
 * user's own terminal sessions spend. A desk pet that quietly bills you for
 * saying hello is a pet nobody should install — so the pet talks through the
 * same `claude` the user already runs, on the same login, spending the same
 * allowance they already understand. Nothing here can bill an API key that
 * wasn't already going to be billed.
 *
 * Finding the binary is the whole difficulty. A Finder-launched Electron app
 * has a bare /usr/bin:/bin PATH, and `claude` lives in ~/.local/bin, a brew
 * prefix, an nvm shim, or is a shell function — so it is resolved once through
 * an interactive login shell, exactly as tmux.js resolves it for a real
 * session, and remembered. That is the only definition of "where claude comes
 * from" that survives nvm, mise and asdf.
 *
 * `--bare` is deliberately NOT used: it reads auth strictly from an API key and
 * never touches the OAuth login, which is the opposite of what this is for.
 */

const { execFile } = require('node:child_process');
const { loginShell } = require('./tmux');

/** How long to wait for a one-line answer before giving up on it. */
const ASK_TIMEOUT_MS = 45_000;
/** Resolving the binary runs a login shell; rc files can be slow, but not this slow. */
const RESOLVE_TIMEOUT_MS = 12_000;

/** Places worth trying directly before paying for a login shell. */
const DIRECT = [
  `${process.env.HOME || ''}/.local/bin/claude`,
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];

let found = null; // resolved path, cached for the life of the app
let looking = null; // the in-flight lookup, so ten messages don't start ten shells

function runFile(bin, args, { timeout = ASK_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        reject(err);
      } else resolve(String(stdout));
    });
  });
}

/**
 * Where `claude` is, or null if this machine hasn't got one.
 *
 * `command -v` rather than `which`: it is the shell builtin, so it finds a
 * `claude` that is a function or an alias too, which is how some version
 * managers install it.
 */
async function findClaude({ shell = loginShell(), fs = require('node:fs') } = {}) {
  if (found !== null) return found;
  if (looking) return looking;
  looking = (async () => {
    for (const path of DIRECT) {
      try {
        fs.accessSync(path, fs.constants.X_OK);
        return path;
      } catch {
        /* not there — try the next */
      }
    }
    try {
      const out = await runFile(shell, ['-ilc', 'command -v claude'], {
        timeout: RESOLVE_TIMEOUT_MS,
      });
      const path = out.trim().split('\n').pop().trim();
      return path.startsWith('/') ? path : null;
    } catch {
      return null; // no claude on this machine, or a login shell that hangs
    }
  })();
  found = await looking;
  looking = null;
  return found;
}

/** Forget the resolved binary — for tests, and for a machine that just installed one. */
function forgetClaude() {
  found = null;
  looking = null;
}

/**
 * The arguments for one throwaway question. Pure, so the shape of the call is
 * something a test can hold rather than something only a subprocess knows.
 *
 * `--system-prompt` replaces Claude Code's own preamble rather than appending
 * to it: the pet is not a coding agent and should not be told that it is.
 * `--strict-mcp-config` with no config keeps a user's MCP servers out of a
 * question about what a small animal thinks.
 */
function askArgs({ prompt, system = '', model = '' }) {
  const args = ['-p', String(prompt)];
  if (model) args.push('--model', String(model));
  if (system) args.push('--system-prompt', String(system));
  // No tools: this is a sentence, not a session. The pet has never had them.
  args.push('--allowed-tools', '');
  // Nothing of the user's setup comes with it — no CLAUDE.md, no skills, no
  // MCP servers, and above all no hooks. Two reasons, and the second is the
  // load-bearing one:
  //
  // A pet carrying a repository's coding instructions is a pet paying for them
  // on every "hello", and answering as if it had been asked about the code.
  //
  // And Clippy's own hooks live in the settings this would otherwise read, so
  // asking the pet a question would fire UserPromptSubmit at Clippy, which
  // would take it for a real session starting: a phantom buddy for a
  // conversation the user had with an existing one. The pet must not be able
  // to summon itself.
  //
  // Unlike --bare, auth is untouched, which is the whole point — the login the
  // user already has is what pays for this.
  args.push('--safe-mode');
  args.push('--strict-mcp-config'); // belt and braces; --safe-mode covers it
  return args;
}

/**
 * Ask the pet model something and get its words back.
 *
 * Returns the SDK's message shape rather than a bare string so the callers and
 * their tests are unchanged by where the answer came from — replyText() still
 * reads it, and a failure still arrives as a result message it can recognise.
 *
 * @returns {Promise<Array<object>>}
 */
async function askClaude({
  prompt,
  system = '',
  model = '',
  timeoutMs = ASK_TIMEOUT_MS,
  bin: given = '',
} = {}) {
  const bin = given || (await findClaude());
  if (!bin) {
    return [
      {
        type: 'result',
        is_error: true,
        result:
          'Clippy talks to the pet through the `claude` command, and cannot find one on this machine.',
      },
    ];
  }
  try {
    const text = (await runFile(bin, askArgs({ prompt, system, model }), {
      timeout: timeoutMs,
    })).trim();
    return [
      { type: 'assistant', message: { content: [{ type: 'text', text }] } },
      { type: 'result', result: text },
    ];
  } catch (err) {
    // A CLI that failed says why on stderr; its exit code says nothing worth
    // repeating to somebody looking at a speech bubble.
    const said = String(err.stderr || err.message || '').trim();
    return [{ type: 'result', is_error: true, result: said.slice(0, 300) || 'no answer' }];
  }
}

/**
 * The same call wearing the SDK's async-iterable coat, so it can be dropped in
 * where `query()` used to be without anything downstream noticing.
 */
function cliRunQuery({ prompt, options = {} } = {}) {
  const system = options.systemPrompt || '';
  const model = options.model || '';
  return (async function* run() {
    for (const message of await askClaude({ prompt, system, model })) yield message;
  })();
}

module.exports = { findClaude, forgetClaude, askArgs, askClaude, cliRunQuery, ASK_TIMEOUT_MS };
