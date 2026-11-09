import * as core from '@actions/core';
import {fetchPackageMetadata, prefetchPackageMetadata} from '../npm.js';
import {
  escapeMarkdownCell,
  formatTableWithCollapse,
  sanitizeText
} from '../common.js';
import {formatSemver, minSemverVersion, satisfiesSemver} from '../semver.js';

export async function scanForEngines(
  messages: string[],
  currentDeps: Map<string, Set<string>>,
  baseDeps: Map<string, Set<string>>,
  projectNodeRange: string | undefined
): Promise<void> {
  if (!projectNodeRange || !projectNodeRange.trim()) {
    return;
  }

  const minProjectNode = minSemverVersion(projectNodeRange);
  if (!minProjectNode) {
    core.info(
      `Could not determine minimum Node.js version from range "${projectNodeRange}". Skipping engines check.`
    );
    return;
  }

  const changedPackages: Array<{name: string; version: string}> = [];

  for (const [packageName, currentVersions] of currentDeps) {
    const baseVersions = baseDeps.get(packageName);
    for (const version of currentVersions) {
      if (!baseVersions || !baseVersions.has(version)) {
        changedPackages.push({name: packageName, version});
      }
    }
  }

  if (changedPackages.length === 0) {
    return;
  }

  await prefetchPackageMetadata(changedPackages);

  const incompatibleRows: string[] = [];

  for (const {name, version} of changedPackages) {
    const metadata = await fetchPackageMetadata(name, version);
    const depNodeRange = metadata?.engines?.node?.trim();
    if (!depNodeRange) {
      continue;
    }

    if (!satisfiesSemver(minProjectNode, depNodeRange)) {
      incompatibleRows.push(
        `| ${escapeMarkdownCell(`${name}@${version}`)} | \`${escapeMarkdownCell(depNodeRange)}\` |`
      );
    }
  }

  if (incompatibleRows.length > 0) {
    const table = formatTableWithCollapse(
      `| 📦 Package | ⚙️ Required Node.js |\n| --- | --- |`,
      incompatibleRows
    );

    messages.push(
      `## ⚠️ Incompatible Node.js Engines

This project supports Node.js \`${sanitizeText(projectNodeRange.trim())}\` (minimum \`${formatSemver(minProjectNode)}\`), which does not satisfy the engine requirements of the following new or updated dependencies:

${table}`
    );
  }
}
