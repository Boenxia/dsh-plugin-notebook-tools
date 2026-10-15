import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { changelogSection, git, githubToken, hasLinkRef, parseArgs, parseRemoteUrl, tagCommitRef } from '../scripts/release.mjs';

const SAMPLE = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [0.2.1] - 2026-10-15',
  '',
  '### Added',
  '',
  '- a release script',
  '',
  '## [0.2.0] - 2026-10-15',
  '',
  'Fidelity and guard hardening.',
  '',
  '[Unreleased]: https://example.test/compare/v0.2.1...HEAD',
  '[0.2.1]: https://example.test/compare/v0.2.0...v0.2.1',
  '[0.2.0]: https://example.test/compare/v0.1.2...v0.2.0',
  '',
].join('\n');

test('parseRemoteUrl accepts the URL shapes git hands out', () => {
  assert.deepEqual(parseRemoteUrl('https://github.com/Boenxia/dsh-plugin-notebook-tools.git'), {
    owner: 'Boenxia',
    repo: 'dsh-plugin-notebook-tools',
  });
  assert.deepEqual(parseRemoteUrl('https://github.com/Boenxia/dsh-plugin-notebook-tools'), {
    owner: 'Boenxia',
    repo: 'dsh-plugin-notebook-tools',
  });
  assert.deepEqual(parseRemoteUrl('git@github.com:Boenxia/dsh-plugin-notebook-tools.git\n'), {
    owner: 'Boenxia',
    repo: 'dsh-plugin-notebook-tools',
  });
  assert.throws(() => parseRemoteUrl('https://gitlab.com/Boenxia/dsh-plugin-notebook-tools.git'), /cannot derive owner\/repo/);
});

test('changelogSection returns the section for a version, heading included', () => {
  assert.equal(
    changelogSection(SAMPLE, '0.2.1'),
    ['## [0.2.1] - 2026-10-15', '', '### Added', '', '- a release script'].join('\n'),
  );
  assert.equal(
    changelogSection(SAMPLE, '0.2.0'),
    ['## [0.2.0] - 2026-10-15', '', 'Fidelity and guard hardening.'].join('\n'),
  );
  assert.equal(changelogSection(SAMPLE, '9.9.9'), null);
  assert.equal(changelogSection(SAMPLE, '0.2.1.1'), null);
});

test('hasLinkRef only accepts the exact version', () => {
  assert.equal(hasLinkRef(SAMPLE, '0.2.1'), true);
  assert.equal(hasLinkRef(SAMPLE, '0.2.0'), true);
  assert.equal(hasLinkRef(SAMPLE, '0.2'), false);
  assert.equal(hasLinkRef(SAMPLE, '0.3.0'), false);
});

test('parseArgs reads flags, defaults, and inline values', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, skipTests: false, branch: 'main', remote: 'origin', title: null, help: false });
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
  assert.equal(parseArgs(['--skip-tests']).skipTests, true);
  assert.equal(parseArgs(['--title', 'v1.0.0 - hello']).title, 'v1.0.0 - hello');
  assert.equal(parseArgs(['--title=v1.0.0 - hello']).title, 'v1.0.0 - hello');
  assert.equal(parseArgs(['--branch', 'release/x']).branch, 'release/x');
  assert.equal(parseArgs(['--remote=upstream']).remote, 'upstream');
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.throws(() => parseArgs(['--title']), /--title needs a value/);
  assert.throws(() => parseArgs(['--title=']), /--title needs a value/);
  assert.throws(() => parseArgs(['--title', '--dry-run']), /--title needs a value/);
});

test('githubToken prefers the environment over the credential store', () => {
  assert.equal(githubToken({ GITHUB_TOKEN: ' ghp_from_env ' }), 'ghp_from_env');
  assert.equal(githubToken({ GH_TOKEN: 'gho_fallback' }), 'gho_fallback');
});

test('tagCommitRef peels an annotated tag down to the commit it marks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-tag-'));
  try {
    git(['init', '-q'], { cwd: dir });
    git(['config', 'user.email', 'release-test@example.test'], { cwd: dir });
    git(['config', 'user.name', 'Release Test'], { cwd: dir });
    writeFileSync(join(dir, 'file.txt'), 'hi\n');
    git(['add', '.'], { cwd: dir });
    git(['commit', '-q', '-m', 'first'], { cwd: dir });
    git(['tag', '-a', 'v9.9.9', '-m', 'annotated tag'], { cwd: dir });

    const head = git(['rev-parse', 'HEAD'], { cwd: dir }).out;
    // The bare ref is the tag object itself, so it never equals HEAD …
    assert.notEqual(git(['rev-parse', 'refs/tags/v9.9.9'], { cwd: dir }).out, head);
    // … while the peeled ref is the commit the tag marks.
    assert.equal(git(['rev-parse', '-q', '--verify', tagCommitRef('v9.9.9')], { cwd: dir }).out, head);
    assert.equal(git(['rev-parse', '-q', '--verify', tagCommitRef('v9.9.8')], { cwd: dir, allowFailure: true }).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
