'use strict';

// The postinstall script is the part of the installer that cannot be checked
// by inspecting the .pkg: it decides where the panel lands and whether CEP will
// load it at all. Running it for real against a fake HOME, with the
// system commands it calls stubbed, is the only way to know it does what the
// conclusion screen promises.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const POSTINSTALL = path.join(REPO, 'pkg', 'scripts', 'postinstall');
const BUNDLE_ID = 'com.danielgutierrez.audiopro';

// Stubs for the commands that would otherwise touch the real machine. `defaults`
// and `killall` record their calls instead of writing preferences; `dscl` is
// what the script uses to find the home directory, so it is what redirects the
// install into the sandbox; `sudo -u <user> <cmd>` drops the user and runs the
// stub directly.
function stubPath(dir, fakeHome, calls) {
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, body) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '#!/bin/sh\n' + body);
    fs.chmodSync(p, 0o755);
  };
  write('dscl', `echo "NFSHomeDirectory: ${fakeHome}"`);
  write('defaults', `echo "defaults $*" >> "${calls}"`);
  write('killall', `echo "killall $*" >> "${calls}"`);
  write('chown', `echo "chown $*" >> "${calls}"`);
  write('xattr', `echo "xattr $*" >> "${calls}"`);
  // `sudo -u someone cmd args` → `cmd args`
  write('sudo', 'if [ "$1" = "-u" ]; then shift 2; fi\nexec "$@"');
  return dir;
}

function runPostinstall({ withPayload = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-pkg-'));
  const fakeHome = path.join(root, 'home');
  const support = path.join(root, 'support');
  const template = path.join(support, 'Premiere', 'extension');
  const calls = path.join(root, 'calls.txt');
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.writeFileSync(calls, '');

  if (withPayload) {
    // A stand-in for the real payload: enough shape for the script to copy.
    fs.mkdirSync(path.join(template, 'CSXS'), { recursive: true });
    fs.mkdirSync(path.join(template, 'js'), { recursive: true });
    fs.mkdirSync(path.join(template, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(template, 'CSXS', 'manifest.xml'), '<ExtensionManifest/>');
    fs.writeFileSync(path.join(template, 'js', 'main.js'), '// panel');
    fs.writeFileSync(path.join(template, 'bin', 'leftover'), 'should not travel');
    fs.mkdirSync(path.join(support, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(support, 'bin', 'ffmpeg'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(support, 'bin', 'ffprobe'), '#!/bin/sh\n');
  }

  // The script hardcodes /Library/Application Support/AudioPro, so the copy
  // under test is rewritten to point at the sandbox instead. Everything else
  // runs verbatim.
  const script = fs.readFileSync(POSTINSTALL, 'utf8')
    .replace('SUPPORT_DIR="/Library/Application Support/AudioPro"', `SUPPORT_DIR="${support}"`);
  const scriptPath = path.join(root, 'postinstall');
  fs.writeFileSync(scriptPath, script);
  fs.chmodSync(scriptPath, 0o755);

  const stubs = stubPath(path.join(root, 'stubs'), fakeHome, calls);
  let status = 0;
  let output;
  try {
    output = execFileSync('/bin/sh', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
    });
  } catch (err) {
    status = err.status;
    output = String(err.stdout || '') + String(err.stderr || '');
  }

  return {
    status,
    output,
    extDir: path.join(fakeHome, 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions', BUNDLE_ID),
    calls: fs.readFileSync(calls, 'utf8'),
    support,
    template,
  };
}

test('the panel lands in the console user\'s own CEP extensions directory', () => {
  const res = runPostinstall();
  assert.equal(res.status, 0, res.output);

  // Not the system-wide one: CEP only loads unsigned extensions from the user's
  // directory, and the payload installs as root, so a root-owned extension in
  // ~/Library would leave the panel's own ⟳ updater unable to write to it.
  assert.ok(fs.existsSync(path.join(res.extDir, 'CSXS', 'manifest.xml')));
  assert.ok(fs.existsSync(path.join(res.extDir, 'js', 'main.js')));
  assert.match(res.calls, /chown -R \S+ .*extensions/, 'ownership is handed to the person at the machine');
});

test('bin/ is not copied into the extension — the binaries live in the shared dir', () => {
  const res = runPostinstall();
  assert.equal(fs.existsSync(path.join(res.extDir, 'bin', 'leftover')), false);
  assert.ok(fs.existsSync(path.join(res.support, 'bin', 'ffmpeg')));
});

test('PlayerDebugMode is set for every CEP version in range', () => {
  const res = runPostinstall();
  // Without it CEP ignores an unsigned extension *silently* — no error, and
  // nothing in the Extensions menu. Which CSXS version Premiere uses depends on
  // the Premiere release, so all three in range are set.
  for (const v of [11, 12, 13]) {
    assert.match(res.calls, new RegExp(`defaults write com\\.adobe\\.CSXS\\.${v} PlayerDebugMode 1`));
  }
  // Preferences are cached per process; without this a running Premiere would
  // not see the change.
  assert.match(res.calls, /killall cfprefsd/);
});

test('a reinstall replaces the extension instead of layering over it', () => {
  const res = runPostinstall();
  const stale = path.join(res.extDir, 'js', 'from-an-older-version.js');
  fs.writeFileSync(stale, '// left behind');

  // rsync --delete: the panel loads whatever is on disk, so a stale js/ file
  // is a bug that reproduces on exactly one machine.
  const again = runPostinstall();
  assert.equal(again.status, 0, again.output);
  assert.equal(fs.existsSync(path.join(again.extDir, 'js', 'from-an-older-version.js')), false);
});

test('a missing payload aborts the install rather than reporting success', () => {
  const res = runPostinstall({ withPayload: false });
  assert.notEqual(res.status, 0);
  assert.match(res.output, /payload missing/);
});

test('the other Adobe panel\'s preset cache is left alone', () => {
  // It belongs to a different extension that may still be installed and
  // signed in. This panel ships its own .epr and caches under its own name,
  // so there is nothing to clean up.
  const script = fs.readFileSync(POSTINSTALL, 'utf8');
  assert.doesNotMatch(script, /rm .*APEnhance_wav_preset/);
});

test('the uninstaller removes the panel but never the editor\'s audio', () => {
  const script = fs.readFileSync(path.join(REPO, 'pkg', 'uninstall-premiere.sh'), 'utf8');
  assert.match(script, /rm -rf "\$EXT_DIR"/);
  assert.match(script, /rm -rf "\$SUPPORT_DIR"/);
  // Audio_Process holds the exports, the Adobe passes and the masters, and
  // some of them are linked from open sequences — it is only ever mentioned to
  // tell the user it was spared, never on an rm line.
  for (const line of script.split('\n')) {
    if (/\brm\b/.test(line)) {
      assert.doesNotMatch(line, /Audio_Process/, `uninstaller would delete the editor's audio: ${line}`);
    }
  }
  assert.match(script, /Audio_Process\/ folders were left untouched/);
  // The token is shared with the Adobe Podcast panel, which may still be in use.
  assert.doesNotMatch(script, /rm .*adobe-podcast-premiere-token/);
});
