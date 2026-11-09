import {execFileSync} from 'child_process';
import * as core from '@actions/core';
import * as github from '@actions/github';

const fetchedRefs = new Set<string>();

export function normalizeGitPath(filePath: string): string {
  const posix = filePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  return posix || '.';
}

export function refExists(ref: string, cwd: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], {
      cwd,
      stdio: 'pipe'
    });
    return true;
  } catch {
    return false;
  }
}

export function ensureRefAvailable(ref: string, cwd: string): boolean {
  if (refExists(ref, cwd)) {
    return true;
  }

  const cacheKey = `${cwd}::${ref}`;
  if (fetchedRefs.has(cacheKey)) {
    return false;
  }
  fetchedRefs.add(cacheKey);

  const remoteBranch = ref.startsWith('origin/')
    ? ref.slice('origin/'.length)
    : ref;
  try {
    core.info(`Ref "${ref}" is not present locally. Attempting git fetch...`);
    execFileSync(
      'git',
      ['fetch', '--no-tags', '--depth=1', 'origin', remoteBranch],
      {
        cwd,
        stdio: 'pipe'
      }
    );
  } catch {
    // Ignore fetch error; refExists check below will report the final status
  }

  return refExists(ref, cwd) || refExists('FETCH_HEAD', cwd);
}

export function getFileFromRef(
  ref: string,
  filePath: string,
  cwd: string
): string | null {
  const normalizedPath = normalizeGitPath(filePath);
  ensureRefAvailable(ref, cwd);

  const effectiveRef =
    !refExists(ref, cwd) && refExists('FETCH_HEAD', cwd) ? 'FETCH_HEAD' : ref;
  const refFilePath = `${effectiveRef}:${normalizedPath}`;

  try {
    return execFileSync('git', ['show', refFilePath], {
      encoding: 'utf8',
      cwd,
      stdio: 'pipe',
      maxBuffer: 1024 * 1024 * 100
    });
  } catch (e) {
    core.error(`Failed to get file from ref "${refFilePath}": ${e}`);
    return null;
  }
}

export function tryGetJSONFromRef<T>(
  ref: string,
  filePath: string,
  cwd: string
): T | null {
  const content = getFileFromRef(ref, filePath, cwd);
  if (content) {
    try {
      return JSON.parse(content);
    } catch (e) {
      const refFilePath = `${ref}:${normalizeGitPath(filePath)}`;
      core.error(`Failed to get json from ref "${refFilePath}": ${e}`);
      return null;
    }
  }
  return null;
}

export function getBaseRef(cwd = process.cwd()): string {
  const inputBaseRef = core.getInput('base-ref')?.trim();

  if (inputBaseRef) {
    if (inputBaseRef.includes('/') || refExists(inputBaseRef, cwd)) {
      return inputBaseRef;
    }
    return `origin/${inputBaseRef}`;
  }

  const githubBaseSha = github.context.payload.pull_request?.base?.sha;
  if (githubBaseSha) {
    return githubBaseSha;
  }

  const gitlabBaseSha = process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA;
  if (gitlabBaseSha) {
    return gitlabBaseSha;
  }

  const bitbucketTarget = process.env.BITBUCKET_PR_DESTINATION_BRANCH;
  if (bitbucketTarget) {
    return `origin/${bitbucketTarget}`;
  }

  return 'origin/main';
}

export function getCurrentRef(): string {
  const inputHeadRef = core.getInput('head-ref')?.trim();
  if (inputHeadRef) {
    return inputHeadRef;
  }

  return (
    github.context.payload.pull_request?.head?.sha ||
    github.context.sha ||
    process.env.CI_COMMIT_SHA ||
    process.env.BITBUCKET_COMMIT ||
    'HEAD'
  );
}
