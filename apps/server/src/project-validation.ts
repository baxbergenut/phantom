import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class ProjectPathError extends Error {}

export async function validateProjectPath(localPath: string): Promise<string> {
  const resolvedPath = path.resolve(localPath);

  try {
    const details = await stat(resolvedPath);
    if (!details.isDirectory()) {
      throw new ProjectPathError('Project path must point to a directory.');
    }
  } catch (error) {
    if (error instanceof ProjectPathError) throw error;
    throw new ProjectPathError(`Project path does not exist: ${resolvedPath}`);
  }

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', resolvedPath, 'rev-parse', '--is-inside-work-tree'],
      { windowsHide: true, timeout: 5000 },
    );
    if (stdout.trim() !== 'true') throw new Error('Not a work tree');
  } catch {
    throw new ProjectPathError('Project path is not a Git working tree.');
  }

  return resolvedPath;
}
