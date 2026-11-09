import * as core from '@actions/core';
import {type ParsedLockFile, traverse} from 'lockparse';
import {
  calculateTotalDependencySizeIncrease,
  fetchPackageMetadata,
  isSupportedArchitecture
} from '../npm.js';
import {
  escapeMarkdownCell,
  formatBytes,
  formatTableWithCollapse
} from '../common.js';

interface PackageGroup {
  added: Array<{version: string; size: number | null}>;
  removed: Array<{version: string; size: number | null}>;
}

interface DisplayEntry {
  label: string;
  size: number | null;
  sortSize: number;
}

function buildPackageGroups(
  packageSizes: Map<string, number | null>,
  removedKeys?: Set<string>
): Map<string, PackageGroup> {
  const packageGroups = new Map<string, PackageGroup>();

  for (const [pkgKey, size] of packageSizes.entries()) {
    const atIndex = pkgKey.lastIndexOf('@');
    const name = pkgKey.substring(0, atIndex);
    const version = pkgKey.substring(atIndex + 1);

    const group = packageGroups.get(name) ?? {added: [], removed: []};
    const isRemoved = removedKeys
      ? removedKeys.has(pkgKey)
      : size !== null && size < 0;

    if (isRemoved) {
      group.removed.push({version, size});
    } else {
      group.added.push({version, size});
    }

    packageGroups.set(name, group);
  }

  return packageGroups;
}

function createDisplayEntries(
  packageGroups: Map<string, PackageGroup>
): DisplayEntry[] {
  const displayEntries: DisplayEntry[] = [];

  for (const [name, group] of packageGroups.entries()) {
    if (
      group.added.length === 1 &&
      group.removed.length === 1 &&
      group.added[0].size !== null &&
      group.removed[0].size !== null
    ) {
      const netSize = group.added[0].size + group.removed[0].size;
      displayEntries.push({
        label: `${name}@${group.removed[0].version} → ${name}@${group.added[0].version}`,
        size: netSize,
        sortSize: netSize
      });
    } else {
      for (const added of group.added) {
        displayEntries.push({
          label: `${name}@${added.version}`,
          size: added.size,
          sortSize: added.size ?? 0
        });
      }
      for (const removed of group.removed) {
        displayEntries.push({
          label: `${name}@${removed.version}`,
          size: removed.size,
          sortSize: removed.size ?? 0
        });
      }
    }
  }

  displayEntries.sort((a, b) => Math.abs(b.sortSize) - Math.abs(a.sortSize));

  return displayEntries;
}

async function removeUnsupportedOptionalDependencies(
  lockFile: ParsedLockFile,
  versionInfo: Array<{name: string; version: string}>
): Promise<void> {
  if (versionInfo.length === 0) return;

  const targetKeys = new Set<string>();
  for (const v of versionInfo) {
    targetKeys.add(`${v.name}@${v.version}`);
  }

  const candidateOptionalVersions = new Map<string, Set<string>>();

  for (const pkg of lockFile.packages) {
    traverse(pkg, {
      optionalDependency: (node) => {
        if (!targetKeys.has(`${node.name}@${node.version}`)) {
          return;
        }
        const entry =
          candidateOptionalVersions.get(node.name) ?? new Set<string>();
        entry.add(node.version);
        candidateOptionalVersions.set(node.name, entry);
      }
    });
  }

  for (const [pkg, versions] of candidateOptionalVersions) {
    for (const version of versions) {
      const pkgMeta = await fetchPackageMetadata(pkg, version);
      if (
        pkgMeta &&
        !isSupportedArchitecture(pkgMeta, 'linux', 'x64', 'glibc')
      ) {
        const index = versionInfo.findIndex(
          (v) => v.name === pkg && v.version === version
        );
        if (index !== -1) {
          versionInfo.splice(index, 1);
        }
      }
    }
  }
}

export async function scanForDependencySize(
  messages: string[],
  threshold: number,
  currentDeps: Map<string, Set<string>>,
  baseDeps: Map<string, Set<string>>,
  currentLockFile: ParsedLockFile,
  baseLockFile: ParsedLockFile,
  diagnostics?: string[]
): Promise<number | null> {
  const newVersions: Array<{name: string; version: string}> = [];
  const removedVersions: Array<{name: string; version: string}> = [];

  for (const [packageName, currentVersionSet] of currentDeps) {
    const baseVersionSet = baseDeps.get(packageName);

    for (const version of currentVersionSet) {
      if (!baseVersionSet || !baseVersionSet.has(version)) {
        newVersions.push({
          name: packageName,
          version
        });
      }
    }
  }

  for (const [packageName, baseVersionSet] of baseDeps) {
    const currentVersionSet = currentDeps.get(packageName);

    for (const version of baseVersionSet) {
      if (!currentVersionSet || !currentVersionSet.has(version)) {
        removedVersions.push({
          name: packageName,
          version
        });
      }
    }
  }

  if (newVersions.length > 0) {
    await removeUnsupportedOptionalDependencies(currentLockFile, newVersions);
  }

  if (removedVersions.length > 0) {
    await removeUnsupportedOptionalDependencies(baseLockFile, removedVersions);
  }

  core.info(`Found ${newVersions.length} new package versions`);
  core.info(`Found ${removedVersions.length} removed package versions.`);

  if (newVersions.length === 0 && removedVersions.length === 0) {
    return 0;
  }

  try {
    const sizeData = await calculateTotalDependencySizeIncrease(
      newVersions,
      removedVersions
    );

    core.info(
      `Total dependency size increase: ${
        sizeData ? formatBytes(sizeData.totalSize) : 'unknown'
      }`
    );

    if (sizeData && sizeData.unknownPackages.length > 0 && diagnostics) {
      diagnostics.push(
        `Unpacked size metadata was unavailable for ${sizeData.unknownPackages.length} package(s): ${sizeData.unknownPackages.slice(0, 5).join(', ')}`
      );
    }

    const exceedsThreshold =
      threshold === 0
        ? sizeData !== null && sizeData.totalSize > 0
        : sizeData !== null && sizeData.totalSize >= threshold;

    const shouldShow =
      threshold === -1 ||
      exceedsThreshold ||
      (sizeData !== null &&
        sizeData.unknownPackages.length > 0 &&
        threshold === 0);

    if (shouldShow && sizeData !== null) {
      const removedKeys = new Set(
        removedVersions.map((v) => `${v.name}@${v.version}`)
      );
      const packageGroups = buildPackageGroups(
        sizeData.packageSizes,
        removedKeys
      );
      const displayEntries = createDisplayEntries(packageGroups);

      const rows = displayEntries.map(
        ({label, size}) =>
          `| ${escapeMarkdownCell(label)} | ${size === null ? '_Unknown_' : formatBytes(size)} |`
      );

      const table = formatTableWithCollapse(
        `| 📦 Package | 📏 Size |\n| --- | --- |`,
        rows
      );

      let alert = '';
      if (threshold !== -1 && exceedsThreshold) {
        alert = `> [!WARNING]\n> This PR adds ${formatBytes(sizeData.totalSize)} of new dependencies, which exceeds the threshold of ${formatBytes(threshold)}.\n\n`;
      } else if (sizeData.totalSize < 0) {
        alert = `> [!NOTE]\n> :tada: This PR removes ${formatBytes(Math.abs(sizeData.totalSize))} of dependencies.\n\n`;
      }

      messages.push(
        `## 📊 Dependency Size Changes

${alert}${table}

**Total size change:** ${formatBytes(sizeData.totalSize)}`
      );
    }

    return sizeData ? sizeData.totalSize : null;
  } catch (err) {
    core.info(`Failed to calculate total dependency size increase: ${err}`);
    return null;
  }
}
