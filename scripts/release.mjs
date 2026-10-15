#!/usr/bin/env node
/**
 * `npm run release` — publish the version that is already committed in
 * package.json. Everything is verified before anything leaves the machine.
 *
 *   1. read the version and require a non-empty `## [x.y.z]` section plus a
 *      `[x.y.z]:` link reference in CHANGELOG.md
 *   2. require a clean tree, the release branch, and that HEAD is the commit
 *      that carries the version bump
 *   3. run the test suite
 *   4. push the release branch (skipped when it is already up to date)
 *   5. create the annotated tag `v<x.y.z>` (skipped when it already points at HEAD)
 *   6. push the tag
 *   7. create the GitHub Release through the REST API: the tag annotation is the
 *      title, the CHANGELOG section is the body, and credentials come from
 *      GITHUB_TOKEN / GH_TOKEN or `git credential fill` (never printed)
 *
 * Usage:
 *   npm run release -- --title "v0.2.1 - short one-line summary"
 *   npm run release -- --dry-run
 *   npm run release -- --skip-tests --branch main --remote origin
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Parse the command line into release options. Throws on unknown options. */
export function parseArgs(argv) {
  const options = { dryRun: false, skipTests: false, branch: 'main', remote: 'origin', title: null, help: false };
  const value = (name, inline, argv2, index) => {
    const raw = inline ?? argv2[index + 1];
    if (raw === undefined || raw === '' || raw.startsWith('--')) throw new Error(`${name} needs a value`);
    return raw;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    if (name === '--dry-run') options.dryRun = true;
    else if (name === '--skip-tests') options.skipTests = true;
    else if (name === '--help' || name === '-h') options.help = true;
    else if (name === '--branch') options.branch = value(name, inline, argv, i);
    else if (name === '--remote') options.remote = value(name, inline, argv, i);
    else if (name === '--title') options.title = value(name, inline, argv, i);
    else throw new Error(`unknown option ${JSON.stringify(arg)} (try --help)`);
    if (inline === null && ['--branch', '--remote', '--title'].includes(name)) i += 1;
  }
  return options;
}

/** Derive {owner, repo} from a GitHub remote URL (https, ssh, or scp-like). */
export function parseRemoteUrl(url) {
  const cleaned = String(url).trim().replace(/\.git$/, '');
  const match = /github\.com[:/]+([^/]+)\/([^/]+)$/.exec(cleaned);
  if (!match) throw new Error(`cannot derive owner/repo from remote URL ${JSON.stringify(url)}`);
  return { owner: match[1], repo: match[2] };
}

/** The CHANGELOG section for `version`, heading included; null when absent. */
export function changelogSection(text, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = new RegExp(`^## \\[${escaped}\\]`, 'm').exec(text);
  if (!start) return null;
  const after = text.slice(start.index + start[0].length);
  // The section ends at the next version heading or at the link-reference block.
  const boundaries = [/^## \[/m.exec(after), /^\[[^\]]+\]:\s/m.exec(after)]
    .filter(Boolean)
    .map((match) => match.index);
  const end = boundaries.length > 0 ? Math.min(...boundaries) : after.length;
  return text.slice(start.index, start.index + start[0].length + end).trim();
}

/** True when the CHANGELOG carries the `[version]: <url>` link reference. */
export function hasLinkRef(text, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\[${escaped}\\]:`, 'm').test(text);
}

/** Read the GitHub token from the environment, else from the git credential store. */
export function githubToken(env = process.env) {
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const fromEnv = env[key];
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  }
  const result = spawnSync('git', ['credential', 'fill'], {
    cwd: ROOT,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(`no stored GitHub credential (${result.error.message}); set GITHUB_TOKEN or authenticate once with git push`);
  }
  const match = /^password=(.*)$/m.exec(result.stdout ?? '');
  if (!match) {
    throw new Error('git credential fill returned no password; set GITHUB_TOKEN or authenticate once with git push');
  }
  return match[1].replace(/\r$/, '');
}

export function createRelease({ owner, repo, tag, title, notes, token }) {
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'dsh-plugin-notebook-tools/release-script',
  };
  return fetch(`${base}/releases`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tag_name: tag, name: title, body: notes, draft: false, prerelease: false }),
  }).then(async (response) => {
    if (response.ok) return { release: await response.json(), created: true };
    const detail = (await response.text()).slice(0, 500);
    if (response.status === 422) {
      const existing = await fetch(`${base}/releases/tags/${tag}`, { headers });
      if (existing.ok) return { release: await existing.json(), created: false };
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`GitHub rejected the credential (${response.status}): ${detail}`);
    }
    throw new Error(`GitHub API error ${response.status}: ${detail}`);
  });
}

/**
 * The revision expression that peels a tag down to the commit it points at.
 * Without the peel, `git rev-parse refs/tags/v1` returns the *tag object* for an
 * annotated tag, which never equals HEAD.
 */
export function tagCommitRef(tag) {
  return `refs/tags/${tag}^{commit}`;
}

export function git(args, { allowFailure = false, cwd = ROOT } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  const ok = result.status === 0;
  if (!ok && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${(result.stderr ?? '').trim()}`);
  }
  return { ok, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

function runTests() {
  execFileSync(process.execPath, ['--test'], { cwd: ROOT, stdio: 'inherit' });
}

const USAGE = `npm run release -- [options]

  --title <text>   title for the tag annotation and the GitHub Release
                   (default: the tag name, e.g. v0.2.1)
  --dry-run        print the plan and change nothing
  --skip-tests     do not run "node --test" first
  --branch <name>  branch the release must be made from (default: main)
  --remote <name>  git remote to push to (default: origin)
`;

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const tag = `v${version}`;
  const title = options.title ?? tag;
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

  const notes = changelogSection(changelog, version);
  if (!notes) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  if (notes.replace(/^## .*$/m, '').trim().length < 20) throw new Error(`the "## [${version}]" CHANGELOG section is empty`);
  if (!hasLinkRef(changelog, version)) throw new Error(`CHANGELOG.md has no "[${version}]:" link reference`);

  const dirty = git(['status', '--porcelain']).out;
  if (dirty) throw new Error(`the working tree is not clean:\n${dirty}`);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (branch !== options.branch) throw new Error(`HEAD is on ${branch}, expected ${options.branch} (use --branch)`);

  const head = git(['rev-parse', 'HEAD']).out;
  const headPkg = JSON.parse(git(['show', 'HEAD:package.json']).out);
  if (headPkg.version !== version) {
    throw new Error(`HEAD still carries version ${headPkg.version}; commit the ${version} bump first`);
  }

  const localTag = git(['rev-parse', '-q', '--verify', tagCommitRef(tag)], { allowFailure: true });
  if (localTag.ok && localTag.out !== head) {
    throw new Error(`tag ${tag} exists but points at ${localTag.out}, not HEAD (${head})`);
  }
  const remoteUrl = git(['remote', 'get-url', options.remote]).out;
  const { owner, repo } = parseRemoteUrl(remoteUrl);
  const remoteTag = git(['ls-remote', '--tags', options.remote, `refs/tags/${tag}`], { allowFailure: true }).out;

  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFailure: true });
  const count = (range) => Number(git(['rev-list', '--count', range], { allowFailure: true }).out || '0');
  const ahead = upstream.ok ? count(`@{u}..HEAD`) : 0;
  const behind = upstream.ok ? count(`HEAD..@{u}`) : 0;
  if (behind > 0) throw new Error(`${upstream.out} is ${behind} commit(s) ahead of HEAD; pull or rebase first`);

  console.log(`${title}  →  ${owner}/${repo}`);
  console.log(`  version  ${version} (committed at ${head.slice(0, 7)})`);
  console.log(`  notes    ${notes.split('\n').length} lines from CHANGELOG.md`);
  console.log(`  branch   ${branch} (${ahead > 0 ? `${ahead} commit(s) to push` : 'up to date'})`);
  console.log(`  tag      ${localTag.ok ? 'already present' : 'will be created'} / remote ${remoteTag ? 'present' : 'absent'}`);

  if (options.dryRun) {
    console.log('  tests    would run "node --test"');
    console.log('\n--dry-run: nothing was tagged, pushed, or published.');
    return 0;
  }

  if (!options.skipTests) {
    console.log('  tests    node --test');
    runTests();
  }

  if (ahead > 0) {
    git(['push', options.remote, branch]);
    console.log(`  pushed   ${branch} → ${options.remote}`);
  }
  if (!localTag.ok) {
    git(['tag', '-a', tag, '-m', title]);
    console.log(`  tagged   ${tag}`);
  }
  if (!remoteTag) {
    git(['push', options.remote, tag]);
    console.log(`  pushed   ${tag} → ${options.remote}`);
  }

  const { release, created } = await createRelease({ owner, repo, tag, title, notes, token: githubToken() });
  console.log(`\n${created ? 'published' : 'already published'}  ${release.html_url}`);
  return 0;
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  main().catch((error) => {
    console.error(`\n✗ ${error.message}`);
    process.exit(1);
  });
}
