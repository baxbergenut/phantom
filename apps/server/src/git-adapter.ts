import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';

import type { CodexFinalResult } from '@phantom/shared';

export interface GitProject {
  localPath: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitStartState {
  repositoryPath: string;
  startingHead: string;
  startingRemoteSha: string;
}

export interface GitEndState extends GitStartState {
  endingHead: string;
  endingRemoteSha: string;
  changedFiles: Array<{ status: string; path: string }>;
  commitMetadata: {
    sha: string;
    subject: string;
    authorName: string;
    authorEmail: string;
    authoredAt: string;
  } | null;
}

export class GitSafetyError extends Error {
  constructor(
    message: string,
    public readonly category:
      | 'not_repository'
      | 'dirty_tree'
      | 'wrong_branch'
      | 'missing_remote'
      | 'unreachable_remote'
      | 'diverged'
      | 'verification_failed',
    public readonly state?: Partial<GitEndState>,
  ) {
    super(message);
  }
}

export interface GitWorkflow {
  preflight(project: GitProject): Promise<GitStartState>;
  verifyCompletion(
    project: GitProject,
    start: GitStartState,
    result: CodexFinalResult,
  ): Promise<GitEndState>;
}

export class GitAdapter implements GitWorkflow {
  constructor(private readonly executable = 'git') {}

  async preflight(project: GitProject): Promise<GitStartState> {
    const repositoryPath = await this.resolve(project.localPath);
    const inside = await this.git(repositoryPath, ['rev-parse', '--is-inside-work-tree'], true);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      throw new GitSafetyError('Configured path is not a Git working tree.', 'not_repository');
    }
    const dirty = await this.git(repositoryPath, [
      'status',
      '--porcelain=v1',
      '--untracked-files=normal',
    ]);
    if (dirty.stdout.trim()) {
      throw new GitSafetyError(
        'Working tree is dirty; commit or remove local changes first.',
        'dirty_tree',
      );
    }
    const branch = (
      await this.git(repositoryPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)
    ).stdout.trim();
    if (branch !== project.remoteBranch) {
      throw new GitSafetyError(
        `Expected branch ${project.remoteBranch}, but ${branch || 'detached HEAD'} is checked out.`,
        'wrong_branch',
      );
    }
    const remote = await this.git(repositoryPath, ['remote', 'get-url', project.remoteName], true);
    if (remote.code !== 0 || !remote.stdout.trim()) {
      throw new GitSafetyError(
        `Git remote ${project.remoteName} is not configured.`,
        'missing_remote',
      );
    }
    const fetch = await this.git(
      repositoryPath,
      ['fetch', '--no-tags', project.remoteName, project.remoteBranch],
      true,
    );
    if (fetch.code !== 0) {
      throw new GitSafetyError(
        `Git remote ${project.remoteName}/${project.remoteBranch} is unreachable: ${fetch.stderr.trim() || 'fetch failed'}`,
        'unreachable_remote',
      );
    }
    const remoteRef = `${project.remoteName}/${project.remoteBranch}`;
    let localHead = (await this.git(repositoryPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const remoteSha = (await this.git(repositoryPath, ['rev-parse', remoteRef])).stdout.trim();
    if (localHead !== remoteSha) {
      const localBehind = await this.isAncestor(repositoryPath, localHead, remoteSha);
      const remoteBehind = await this.isAncestor(repositoryPath, remoteSha, localHead);
      if (!localBehind && !remoteBehind) {
        throw new GitSafetyError(
          `Local ${project.remoteBranch} and ${remoteRef} have diverged. Resolve the history manually.`,
          'diverged',
        );
      }
      if (localBehind) {
        const merge = await this.git(repositoryPath, ['merge', '--ff-only', remoteRef], true);
        if (merge.code !== 0) {
          throw new GitSafetyError(
            `Fast-forward synchronization failed: ${merge.stderr.trim() || merge.stdout.trim()}`,
            'diverged',
          );
        }
        localHead = (await this.git(repositoryPath, ['rev-parse', 'HEAD'])).stdout.trim();
      }
    }
    return { repositoryPath, startingHead: localHead, startingRemoteSha: remoteSha };
  }

  async verifyCompletion(
    project: GitProject,
    start: GitStartState,
    result: CodexFinalResult,
  ): Promise<GitEndState> {
    const repositoryPath = await this.resolve(project.localPath);
    if (repositoryPath !== start.repositoryPath) {
      throw new GitSafetyError(
        'Resolved repository path changed during execution.',
        'verification_failed',
      );
    }
    const dirty = await this.git(repositoryPath, [
      'status',
      '--porcelain=v1',
      '--untracked-files=normal',
    ]);
    const fetch = await this.git(
      repositoryPath,
      ['fetch', '--no-tags', project.remoteName, project.remoteBranch],
      true,
    );
    if (fetch.code !== 0) {
      throw new GitSafetyError(
        `Could not verify the remote after execution: ${fetch.stderr.trim() || 'fetch failed'}`,
        'verification_failed',
      );
    }
    const remoteRef = `${project.remoteName}/${project.remoteBranch}`;
    const endingHead = (await this.git(repositoryPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const endingRemoteSha = (
      await this.git(repositoryPath, ['rev-parse', remoteRef])
    ).stdout.trim();
    const changedFiles = await this.changedFiles(repositoryPath, start.startingHead, endingHead);
    const endState = {
      ...start,
      endingHead,
      endingRemoteSha,
      changedFiles,
    };

    if (dirty.stdout.trim()) {
      throw new GitSafetyError(
        'Codex left uncommitted changes in the working tree.',
        'verification_failed',
        endState,
      );
    }

    if (endingHead === start.startingHead) {
      if (result.commitSha || result.pushed) {
        throw new GitSafetyError(
          'Codex claimed a commit or push, but local HEAD did not change.',
          'verification_failed',
          endState,
        );
      }
      if (result.summary.trim().length < 10) {
        throw new GitSafetyError(
          'A no-change completion must explain why no commit was needed.',
          'verification_failed',
          endState,
        );
      }
      return {
        ...endState,
        commitMetadata: null,
      };
    }

    if (!result.commitSha || !result.pushed) {
      throw new GitSafetyError(
        'Changes require a claimed commit SHA and pushed=true.',
        'verification_failed',
        endState,
      );
    }
    if (changedFiles.length === 0) {
      throw new GitSafetyError(
        'Codex created a commit without file changes; empty task commits are not accepted.',
        'verification_failed',
        endState,
      );
    }
    const claimedSha = (
      await this.git(repositoryPath, ['rev-parse', result.commitSha])
    ).stdout.trim();
    if (claimedSha !== endingHead) {
      throw new GitSafetyError(
        `Claimed commit ${result.commitSha} is not the checked-out HEAD ${endingHead}.`,
        'verification_failed',
        endState,
      );
    }
    if (!(await this.isAncestor(repositoryPath, claimedSha, endingRemoteSha))) {
      throw new GitSafetyError(
        `Claimed commit ${claimedSha} is not reachable from ${remoteRef}; the push may have been rejected because the remote advanced.`,
        'verification_failed',
        endState,
      );
    }
    const metadata = (
      await this.git(repositoryPath, [
        'show',
        '-s',
        '--format=%H%x00%s%x00%an%x00%ae%x00%aI',
        claimedSha,
      ])
    ).stdout
      .trim()
      .split('\0');
    const commitMetadata = {
      sha: metadata[0] ?? claimedSha,
      subject: metadata[1] ?? '',
      authorName: metadata[2] ?? '',
      authorEmail: metadata[3] ?? '',
      authoredAt: metadata[4] ?? '',
    };
    if (
      commitMetadata.subject.trim().length < 8 ||
      /^(update|changes|fix|task)$/i.test(commitMetadata.subject.trim())
    ) {
      throw new GitSafetyError(
        'The task commit message is not informative enough.',
        'verification_failed',
        { ...endState, commitMetadata },
      );
    }
    return {
      ...endState,
      commitMetadata,
    };
  }

  private async changedFiles(repositoryPath: string, from: string, to: string) {
    if (from === to) return [];
    const output = (
      await this.git(repositoryPath, ['diff', '--name-status', '-z', `${from}..${to}`])
    ).stdout;
    const fields = output.split('\0').filter(Boolean);
    const changes: Array<{ status: string; path: string }> = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++] ?? '';
      const firstPath = fields[index++] ?? '';
      const renamed = status.startsWith('R') || status.startsWith('C');
      const targetPath = renamed ? (fields[index++] ?? firstPath) : firstPath;
      changes.push({ status, path: targetPath });
    }
    return changes;
  }

  private async isAncestor(repositoryPath: string, ancestor: string, descendant: string) {
    return (
      (await this.git(repositoryPath, ['merge-base', '--is-ancestor', ancestor, descendant], true))
        .code === 0
    );
  }

  private async resolve(repositoryPath: string): Promise<string> {
    try {
      return await realpath(repositoryPath);
    } catch {
      throw new GitSafetyError(
        `Repository path does not exist: ${repositoryPath}`,
        'not_repository',
      );
    }
  }

  private async git(repositoryPath: string, args: string[], allowFailure = false) {
    const result = await run(this.executable, ['-C', repositoryPath, ...args]);
    if (!allowFailure && result.code !== 0) {
      throw new GitSafetyError(
        result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed.`,
        'verification_failed',
      );
    }
    return result;
  }
}

async function run(executable: string, args: string[]) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
