import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CodexFinalResult } from '@phantom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitAdapter, GitSafetyError } from './git-adapter.js';

describe('Git safety adapter', () => {
  let root: string;
  let local: string;
  let remote: string;
  let adapter: GitAdapter;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'phantom-git-'));
    local = path.join(root, 'local');
    remote = path.join(root, 'remote.git');
    git(root, ['init', '--bare', remote]);
    git(root, ['init', '-b', 'main', local]);
    configure(local);
    writeFileSync(path.join(local, 'README.md'), 'initial\n');
    git(local, ['add', 'README.md']);
    git(local, ['commit', '-m', 'Initial commit']);
    git(local, ['remote', 'add', 'origin', remote]);
    git(local, ['push', '-u', 'origin', 'main']);
    adapter = new GitAdapter();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('verifies a clean commit that is reachable from the remote branch', async () => {
    const start = await adapter.preflight(project());
    writeFileSync(path.join(local, 'README.md'), 'implemented\n');
    git(local, ['add', 'README.md']);
    git(local, ['commit', '-m', 'Implement requested behavior']);
    const sha = git(local, ['rev-parse', 'HEAD']);
    git(local, ['push', 'origin', 'main']);
    const end = await adapter.verifyCompletion(project(), start, completed(sha, true));
    expect(end.endingHead).toBe(sha);
    expect(end.endingRemoteSha).toBe(sha);
    expect(end.changedFiles).toEqual([{ status: 'M', path: 'README.md' }]);
    expect(end.commitMetadata).toMatchObject({ sha, subject: 'Implement requested behavior' });
  });

  it('accepts an explained no-change completion without an empty commit', async () => {
    const start = await adapter.preflight(project());
    const end = await adapter.verifyCompletion(
      project(),
      start,
      completed(null, false, 'No change was needed because the requested state already exists.'),
    );
    expect(end.endingHead).toBe(start.startingHead);
    expect(end.changedFiles).toEqual([]);
    expect(end.commitMetadata).toBeNull();
  });

  it('blocks a dirty tree, wrong branch, and missing or unreachable remote', async () => {
    await expect(adapter.preflight({ ...project(), localPath: root })).rejects.toMatchObject({
      category: 'not_repository',
    });

    writeFileSync(path.join(local, 'dirty.txt'), 'dirty\n');
    await expect(adapter.preflight(project())).rejects.toMatchObject({ category: 'dirty_tree' });
    rmSync(path.join(local, 'dirty.txt'));

    git(local, ['switch', '-c', 'other']);
    await expect(adapter.preflight(project())).rejects.toMatchObject({ category: 'wrong_branch' });
    git(local, ['switch', 'main']);

    git(local, ['remote', 'remove', 'origin']);
    await expect(adapter.preflight(project())).rejects.toMatchObject({
      category: 'missing_remote',
    });
    git(local, ['remote', 'add', 'origin', path.join(root, 'missing.git')]);
    await expect(adapter.preflight(project())).rejects.toMatchObject({
      category: 'unreachable_remote',
    });
  });

  it('fast-forwards a behind branch and blocks diverged history', async () => {
    const peer = clonePeer();
    writeFileSync(path.join(peer, 'remote.txt'), 'remote\n');
    git(peer, ['add', 'remote.txt']);
    git(peer, ['commit', '-m', 'Advance remote']);
    git(peer, ['push', 'origin', 'main']);
    const remoteSha = git(peer, ['rev-parse', 'HEAD']);
    const synchronized = await adapter.preflight(project());
    expect(synchronized.startingHead).toBe(remoteSha);

    writeFileSync(path.join(local, 'local.txt'), 'local\n');
    git(local, ['add', 'local.txt']);
    git(local, ['commit', '-m', 'Advance local']);
    writeFileSync(path.join(peer, 'peer.txt'), 'peer\n');
    git(peer, ['add', 'peer.txt']);
    git(peer, ['commit', '-m', 'Advance peer again']);
    git(peer, ['push', 'origin', 'main']);
    await expect(adapter.preflight(project())).rejects.toMatchObject({ category: 'diverged' });
  });

  it('rejects a completion whose claimed commit did not reach an advanced remote', async () => {
    const start = await adapter.preflight(project());
    const peer = clonePeer();
    writeFileSync(path.join(peer, 'peer.txt'), 'peer\n');
    git(peer, ['add', 'peer.txt']);
    git(peer, ['commit', '-m', 'Advance remote']);
    git(peer, ['push', 'origin', 'main']);

    writeFileSync(path.join(local, 'local.txt'), 'local\n');
    git(local, ['add', 'local.txt']);
    git(local, ['commit', '-m', 'Local task result']);
    const localSha = git(local, ['rev-parse', 'HEAD']);
    expect(() => git(local, ['push', 'origin', 'main'])).toThrow();
    await expect(
      adapter.verifyCompletion(project(), start, completed(localSha, true)),
    ).rejects.toBeInstanceOf(GitSafetyError);
  });

  function project() {
    return { localPath: local, remoteName: 'origin', remoteBranch: 'main' };
  }

  function clonePeer() {
    const peer = path.join(root, `peer-${Math.random().toString(16).slice(2)}`);
    git(root, ['clone', '--branch', 'main', remote, peer]);
    configure(peer);
    return peer;
  }
});

function completed(
  commitSha: string | null,
  pushed: boolean,
  summary = 'Implemented the requested change and pushed it safely.',
): CodexFinalResult {
  return {
    schemaVersion: 1,
    status: 'completed',
    summary,
    completedItems: ['Requested task'],
    incompleteItems: [],
    failureCategory: 'none',
    failureReason: null,
    retryRecommended: false,
    commitSha,
    pushed,
  };
}

function configure(repository: string) {
  git(repository, ['config', 'user.email', 'phantom-test@localhost']);
  git(repository, ['config', 'user.name', 'Phantom Test']);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
