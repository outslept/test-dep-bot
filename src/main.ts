import * as process from 'process';
import * as fs from 'node:fs/promises';
import * as core from '@actions/core';
import * as github from '@actions/github';
import type {PackageJson} from 'pkg-types';
import {dirname, join} from 'node:path';
import {parse as parseLockfile, type ParsedLockFile} from 'lockparse';
import {
  detectLockfile,
  computeDependencyVersions,
  type ComputeDependencyOptions
} from './lockfile.js';
import {
  getFileFromRef,
  getBaseRef,
  getCurrentRef,
  tryGetJSONFromRef
} from './git.js';
import {getDependenciesFromPackageJson, type DependencyType} from './npm.js';
import {getPacksFromPattern} from './packs.js';
import {scanForReplacements} from './checks/replacements.js';
import {scanForDuplicates, getLsCommand} from './checks/duplicates.js';
import {scanForDependencyCount} from './checks/dependency-count.js';
import {scanForDependencySize} from './checks/dependency-size.js';
import {scanForProvenance} from './checks/provenance.js';
import {scanForBundleSize} from './checks/bundle-size.js';
import {scanForLicenses} from './checks/license.js';
import {scanForEngines} from './checks/engines.js';
import {scanForRegistryChanges} from './checks/registry.js';
import {scanForMaintainers} from './checks/maintainers.js';
import {formatBytes, parseCommaList} from './common.js';
import {
  ALL_CHECKS,
  ARTIFACT_FILENAME,
  COMMENT_TAG,
  DEFAULT_ALLOWED_REGISTRIES,
  VALID_MODES,
  type ActionMode,
  type CheckName
} from './constants.js';
import {findExistingComment, upsertComment} from './github.js';

export interface ArtifactResult {
  pr_number: number;
  body: string;
  hasWarnings?: boolean;
  outcome?: 'clean' | 'warnings' | 'partial' | 'skipped';
  triggeredChecks?: CheckName[];
  summary?: {
    dependencyCountChange: number;
    dependencySizeChange: number | null;
  };
  warnings?: string[];
  next?: Array<{command: string; when: string}>;
}

function parseIntStrict(name: string, rawValue: string): number {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed)) {
    throw new Error(
      `Invalid input "${name}": expected an integer, received "${rawValue}".`
    );
  }
  return parsed;
}

function parseCheckNames(input: string, allowSpecial = false): Set<CheckName> {
  const items = parseCommaList(input).map((s) =>
    s.toLowerCase() === 'bundle-size' ? 'pack-size' : s.toLowerCase()
  );

  if (allowSpecial) {
    if (items.length === 0 || (items.length === 1 && items[0] === 'none')) {
      return new Set();
    }
    if (
      items.includes('all') ||
      items.includes('any') ||
      items.includes('true')
    ) {
      return new Set(ALL_CHECKS);
    }
  }

  const validSet = new Set<string>(ALL_CHECKS);
  const result = new Set<CheckName>();
  for (const item of items) {
    if (!validSet.has(item)) {
      throw new Error(
        `Unknown check "${item}". Valid checks are: ${ALL_CHECKS.join(', ')}.`
      );
    }
    result.add(item as CheckName);
  }
  return result;
}

async function writeFileAtomic(
  filePath: string,
  content: string
): Promise<void> {
  const dir = dirname(filePath);
  await fs.mkdir(dir, {recursive: true});
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath);
}

async function writeStepSummaryIfEnabled(markdown: string): Promise<void> {
  const stepSummaryInput = core.getInput('step-summary');
  const enabled = stepSummaryInput === '' || stepSummaryInput === 'true';
  if (!enabled || !process.env.GITHUB_STEP_SUMMARY) {
    return;
  }
  try {
    await core.summary.addRaw(markdown).write();
  } catch (err) {
    core.info(`Could not write GitHub Step Summary: ${err}`);
  }
}

async function postCommentFromArtifact(): Promise<void> {
  const token = core.getInput('github-token', {required: true});
  const artifactPath = core.getInput('artifact-path');

  if (!artifactPath) {
    throw new Error(
      'No artifact-path was provided. This is required for comment-from-artifact mode.'
    );
  }

  core.info(`Reading artifact from ${artifactPath}`);

  const raw = await fs.readFile(artifactPath, 'utf-8');
  const result = JSON.parse(raw) as ArtifactResult;

  if (
    typeof result.pr_number !== 'number' ||
    !Number.isInteger(result.pr_number) ||
    result.pr_number < 1 ||
    typeof result.body !== 'string'
  ) {
    throw new Error(
      `Invalid artifact file at "${artifactPath}": expected numeric "pr_number" and string "body".`
    );
  }

  const expectedPrInput = core.getInput('pr-number');
  if (expectedPrInput) {
    const expectedPr = parseInt(expectedPrInput, 10);
    if (!Number.isNaN(expectedPr) && expectedPr !== result.pr_number) {
      throw new Error(
        `Artifact PR number (${result.pr_number}) does not match input pr-number (${expectedPr}).`
      );
    }
  }

  const body = result.body.includes(COMMENT_TAG)
    ? result.body
    : `${COMMENT_TAG}\n${result.body}`;

  const hasWarnings =
    result.hasWarnings ?? !body.includes('No dependency warnings found.');

  core.info(`Posting comment to PR #${result.pr_number}`);

  const octokit = github.getOctokit(token);
  await upsertComment(octokit, result.pr_number, body, !hasWarnings);
}

async function analyzeAndComment(): Promise<void> {
  const baseWorkspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const rawMode = (core.getInput('mode') || 'comment').trim();
  if (!VALID_MODES.includes(rawMode as ActionMode)) {
    throw new Error(
      `Invalid mode "${rawMode}". Expected one of: ${VALID_MODES.join(', ')}.`
    );
  }
  const mode = rawMode as ActionMode;

  const workDir = core.getInput('working-directory') || '.';
  const workspacePath = join(baseWorkspace, workDir);
  core.info(`Workspace path is ${workspacePath}`);

  const dependencyThreshold = parseIntStrict(
    'dependency-threshold',
    core.getInput('dependency-threshold') || '10'
  );
  const sizeThreshold = parseIntStrict(
    'size-threshold',
    core.getInput('size-threshold') || '100000'
  );
  const duplicateThreshold = parseIntStrict(
    'duplicate-threshold',
    core.getInput('duplicate-threshold') || '1'
  );
  const packSizeThreshold = parseIntStrict(
    'pack-size-threshold',
    core.getInput('pack-size-threshold') || '50000'
  );

  const basePackagesPattern = core.getInput('base-packages')?.trim() ?? '';
  const sourcePackagesPattern = core.getInput('source-packages')?.trim() ?? '';
  if (Boolean(basePackagesPattern) !== Boolean(sourcePackagesPattern)) {
    throw new Error(
      'Both "base-packages" and "source-packages" must be provided together when comparing pack sizes.'
    );
  }

  const checksInput = core.getInput('checks');
  const activeChecks = checksInput
    ? parseCheckNames(checksInput)
    : new Set<CheckName>(ALL_CHECKS);

  const failOnChecks = parseCheckNames(
    core.getInput('fail-on') || 'none',
    true
  );

  const getBool = (name: string, defaultValue: boolean): boolean => {
    const val = core.getInput(name);
    if (val === '') return defaultValue;
    return core.getBooleanInput(name);
  };

  const detectReplacements = getBool('detect-replacements', true);
  const transitiveReplacements = getBool('transitive-replacements', false);
  const excludeDev = getBool('exclude-dev', false);
  const excludeDependencies = parseCommaList(
    core.getInput('exclude-dependencies')
  );
  const detectLicenseChanges = getBool('detect-license-changes', true);
  const blockedLicenses = parseCommaList(core.getInput('blocked-licenses'));
  const detectIncompatibleEngines = getBool(
    'detect-incompatible-engines',
    true
  );
  const nodeVersionInput = core.getInput('node-version')?.trim() || undefined;
  const detectRegistryChanges = getBool('detect-registry-changes', true);
  const allowedRegistriesInput = parseCommaList(
    core.getInput('allowed-registries')
  );
  const allowedRegistries =
    allowedRegistriesInput.length > 0
      ? allowedRegistriesInput
      : DEFAULT_ALLOWED_REGISTRIES;
  const blockedMaintainers = parseCommaList(
    core.getInput('blocked-maintainers')
  );

  const requiresPr = mode === 'comment' || mode === 'artifact';
  const token =
    mode === 'comment'
      ? core.getInput('github-token', {required: true})
      : core.getInput('github-token');
  const prNumberRaw = core.getInput('pr-number', {required: requiresPr});
  const prNumber = prNumberRaw ? parseInt(prNumberRaw, 10) : NaN;

  if (requiresPr && (Number.isNaN(prNumber) || prNumber < 1)) {
    core.info('No valid pull request number was found. Skipping.');
    core.setOutput('outcome', 'skipped');
    return;
  }

  const baseRef = getBaseRef(workspacePath);
  const currentRef = getCurrentRef();
  const lockfileFilename = detectLockfile(workspacePath);
  core.info(`Detected lockfile ${lockfileFilename}`);

  if (!lockfileFilename) {
    core.info('No lockfile detected in the workspace. Exiting.');
    core.setOutput('outcome', 'skipped');
    return;
  }

  const lockfilePath = join(workDir, lockfileFilename);
  const packageFilePath = join(workDir, 'package.json');
  core.info(`Using lockfile: ${lockfilePath}`);
  core.info(`Comparing package lockfiles between ${baseRef} and ${currentRef}`);

  const basePackageLock = getFileFromRef(baseRef, lockfilePath, baseWorkspace);
  if (!basePackageLock) {
    core.info('No package lockfile found in base ref');
    core.setOutput('outcome', 'skipped');
    return;
  }

  const currentPackageLock = getFileFromRef(
    currentRef,
    lockfilePath,
    baseWorkspace
  );
  if (!currentPackageLock) {
    core.info('No package lockfile found in current ref');
    core.setOutput('outcome', 'skipped');
    return;
  }

  const basePackageJson = tryGetJSONFromRef<PackageJson>(
    baseRef,
    packageFilePath,
    baseWorkspace
  );
  const currentPackageJson = tryGetJSONFromRef<PackageJson>(
    currentRef,
    packageFilePath,
    baseWorkspace
  );

  if (
    detectReplacements &&
    activeChecks.has('replacements') &&
    (!basePackageJson || !currentPackageJson)
  ) {
    throw new Error(
      'detect-replacements requires both base and current package.json to be present'
    );
  }

  let parsedCurrentLock: ParsedLockFile;
  let parsedBaseLock: ParsedLockFile;

  try {
    parsedCurrentLock = await parseLockfile(
      currentPackageLock,
      lockfileFilename,
      currentPackageJson ?? undefined
    );
    core.info(
      `Parsed current lockfile with ${parsedCurrentLock.packages.length} packages`
    );
  } catch (err) {
    throw new Error(`Failed to parse current lockfile: ${err}`, {
      cause: err
    });
  }
  try {
    parsedBaseLock = await parseLockfile(
      basePackageLock,
      lockfileFilename,
      basePackageJson ?? undefined
    );
    core.info(
      `Parsed base lockfile with ${parsedBaseLock.packages.length} packages`
    );
  } catch (err) {
    throw new Error(`Failed to parse base lockfile: ${err}`, {
      cause: err
    });
  }

  const filterOptions: ComputeDependencyOptions = {
    excludeDev,
    excludeDependencies
  };

  const currentDeps = computeDependencyVersions(
    parsedCurrentLock,
    filterOptions
  );
  const baseDeps = computeDependencyVersions(parsedBaseLock, filterOptions);

  let currentDepCount = 0;
  for (const v of currentDeps.values()) currentDepCount += v.size;
  let baseDepCount = 0;
  for (const v of baseDeps.values()) baseDepCount += v.size;
  const depCountChange = currentDepCount - baseDepCount;

  core.info(`Dependency threshold set to ${dependencyThreshold}`);
  core.info(`Size threshold set to ${formatBytes(sizeThreshold)}`);
  core.info(`Duplicate threshold set to ${duplicateThreshold}`);
  core.info(`Pack size threshold set to ${formatBytes(packSizeThreshold)}`);

  const messages: string[] = [];
  const diagnostics: string[] = [];
  const triggeredChecks: CheckName[] = [];
  const nextCommands: Array<{command: string; when: string}> = [];

  const runCheck = async (
    name: CheckName,
    fn: () => Promise<void> | void
  ): Promise<void> => {
    if (!activeChecks.has(name)) return;
    const before = messages.length;
    await fn();
    if (messages.length > before) {
      triggeredChecks.push(name);
    }
  };

  await runCheck('count', () => {
    scanForDependencyCount(
      messages,
      dependencyThreshold,
      currentDeps,
      baseDeps,
      parsedCurrentLock,
      filterOptions
    );
  });

  if (duplicateThreshold > 0) {
    await runCheck('duplicates', () => {
      const before = messages.length;
      scanForDuplicates(
        messages,
        duplicateThreshold,
        currentDeps,
        baseDeps,
        lockfilePath,
        parsedCurrentLock,
        workDir
      );
      if (messages.length > before) {
        const cmd = getLsCommand(lockfilePath, 'example-package', workDir);
        if (cmd) {
          nextCommands.push({
            command: cmd,
            when: 'Inspect what depends on a duplicate package'
          });
        }
      }
    });
  }

  let depSizeChange: number | null = 0;
  await runCheck('size', async () => {
    depSizeChange = await scanForDependencySize(
      messages,
      sizeThreshold,
      currentDeps,
      baseDeps,
      parsedCurrentLock,
      parsedBaseLock,
      diagnostics
    );
  });

  await runCheck('provenance', async () => {
    await scanForProvenance(messages, currentDeps, baseDeps);
  });

  if (detectLicenseChanges || blockedLicenses.length > 0) {
    await runCheck('license', async () => {
      await scanForLicenses(messages, currentDeps, baseDeps, {
        detectChanges: detectLicenseChanges,
        blockedLicenses
      });
    });
  }

  if (detectIncompatibleEngines) {
    const projectNodeRange =
      nodeVersionInput ?? currentPackageJson?.engines?.node;
    await runCheck('engines', async () => {
      await scanForEngines(messages, currentDeps, baseDeps, projectNodeRange);
    });
  }

  if (detectRegistryChanges) {
    await runCheck('registry', () => {
      scanForRegistryChanges(
        messages,
        basePackageLock,
        currentPackageLock,
        lockfileFilename,
        currentDeps,
        baseDeps,
        allowedRegistries
      );
    });
  }

  if (blockedMaintainers.length > 0) {
    await runCheck('maintainers', async () => {
      await scanForMaintainers(
        messages,
        currentDeps,
        baseDeps,
        blockedMaintainers
      );
    });
  }

  if (basePackagesPattern && sourcePackagesPattern) {
    await runCheck('pack-size', async () => {
      try {
        core.info(
          `Comparing pack sizes between patterns: ${basePackagesPattern} and ${sourcePackagesPattern}`
        );

        const basePacks = await getPacksFromPattern(basePackagesPattern);
        const sourcePacks = await getPacksFromPattern(sourcePackagesPattern);

        core.info(
          `Found ${basePacks.length} base packs and ${sourcePacks.length} source packs`
        );

        await scanForBundleSize(
          messages,
          basePacks,
          sourcePacks,
          packSizeThreshold
        );
      } catch (err) {
        core.info(`Failed to compare pack sizes: ${err}`);
        diagnostics.push(`Failed to compare pack sizes: ${err}`);
      }
    });
  }

  if (detectReplacements && basePackageJson && currentPackageJson) {
    await runCheck('replacements', () => {
      const depTypes: DependencyType[] = excludeDev
        ? ['optional', 'peer', 'prod']
        : ['optional', 'peer', 'dev', 'prod'];

      const baseDependencies = getDependenciesFromPackageJson(
        basePackageJson,
        depTypes,
        excludeDependencies
      );
      const currentDependencies = getDependenciesFromPackageJson(
        currentPackageJson,
        depTypes,
        excludeDependencies
      );

      scanForReplacements(messages, baseDependencies, currentDependencies, {
        excludeDependencies,
        currentLockDeps: currentDeps,
        baseLockDeps: baseDeps,
        includeTransitive: transitiveReplacements
      });
    });
  }

  const hasWarnings = messages.length > 0;
  const outcome: ArtifactResult['outcome'] = hasWarnings
    ? 'warnings'
    : diagnostics.length > 0
      ? 'partial'
      : 'clean';

  const commentBody =
    messages.length === 0
      ? `${COMMENT_TAG}\n## e18e dependency analysis\n\nNo dependency warnings found.\n`
      : `${COMMENT_TAG}\n${messages.join('\n\n')}`;

  const reportPayload: ArtifactResult = {
    pr_number: Number.isNaN(prNumber) ? 0 : prNumber,
    body: commentBody,
    hasWarnings,
    outcome,
    triggeredChecks,
    summary: {
      dependencyCountChange: depCountChange,
      dependencySizeChange: depSizeChange
    },
    warnings: diagnostics,
    next: nextCommands
  };

  core.setOutput('outcome', outcome);
  core.setOutput('triggered-checks', triggeredChecks.join(','));
  core.setOutput('warnings-count', String(triggeredChecks.length));
  core.setOutput('dependency-count-change', String(depCountChange));
  core.setOutput('dependency-size-change', String(depSizeChange ?? 0));
  core.setOutput('comment-body', commentBody);
  core.setOutput('json', JSON.stringify(reportPayload));

  await writeStepSummaryIfEnabled(commentBody);

  const customArtifactPath = core.getInput('artifact-path')?.trim();

  if (mode === 'artifact' || (mode === 'report' && customArtifactPath)) {
    const outputPath =
      customArtifactPath || join(baseWorkspace, '.e18e-tmp', ARTIFACT_FILENAME);

    await writeFileAtomic(outputPath, JSON.stringify(reportPayload));

    core.setOutput('artifact-path', outputPath);
    core.info(`Wrote artifact to ${outputPath}`);
  } else if (mode === 'comment') {
    const octokit = github.getOctokit(token);

    if (messages.length === 0) {
      const existingCommentId = await findExistingComment(octokit, prNumber);
      if (existingCommentId) {
        await upsertComment(octokit, prNumber, commentBody);
      } else {
        core.info('No dependency warnings found. Skipping comment creation.');
      }
    } else {
      await upsertComment(octokit, prNumber, commentBody);
    }
  }

  const failedChecks = triggeredChecks.filter((c) => failOnChecks.has(c));
  if (failedChecks.length > 0) {
    throw new Error(
      `Dependency diff checks exceeded failure threshold: ${failedChecks.join(', ')}`
    );
  }
}

async function run(): Promise<void> {
  try {
    const mode = (core.getInput('mode') || 'comment').trim();

    if (mode === 'comment-from-artifact') {
      await postCommentFromArtifact();
      return;
    }

    await analyzeAndComment();
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

if (import.meta.main) {
  run();
}
