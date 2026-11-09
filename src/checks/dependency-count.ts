import * as core from '@actions/core';
import type {ParsedLockFile} from 'lockparse';
import {escapeMarkdownCell, pluralize} from '../common.js';
import {
  computeSubtreeAttribution,
  type ComputeDependencyOptions
} from '../lockfile.js';

function countVersions(deps: Map<string, Set<string>>): number {
  let sum = 0;
  for (const versions of deps.values()) {
    sum += versions.size;
  }
  return sum;
}

export function scanForDependencyCount(
  messages: string[],
  threshold: number,
  currentDeps: Map<string, Set<string>>,
  baseDeps: Map<string, Set<string>>,
  currentLockFile?: ParsedLockFile,
  filterOptions?: ComputeDependencyOptions
): void {
  const currentDepCount = countVersions(currentDeps);
  const baseDepCount = countVersions(baseDeps);
  const depIncrease = currentDepCount - baseDepCount;

  core.info(`Base dependency count: ${baseDepCount}`);
  core.info(`Current dependency count: ${currentDepCount}`);
  core.info(`Dependency count increase: ${depIncrease}`);

  if (depIncrease > 0 && depIncrease >= threshold) {
    let attributionSection = '';

    if (currentLockFile) {
      const newPackageKeys = new Set<string>();
      for (const [name, versions] of currentDeps) {
        const baseVersions = baseDeps.get(name);
        for (const v of versions) {
          if (!baseVersions || !baseVersions.has(v)) {
            newPackageKeys.add(`${name}@${v}`);
          }
        }
      }

      const attributions = computeSubtreeAttribution(
        currentLockFile,
        newPackageKeys,
        filterOptions
      ).slice(0, 5);

      if (attributions.length > 0) {
        const rows = attributions
          .map(
            (a) =>
              `| ${escapeMarkdownCell(a.directPackage)} | +${pluralize(a.newTransitiveCount, 'transitive package')} |`
          )
          .join('\n');
        attributionSection = `\n\n| 🌱 Direct Dependency | 📦 Transitive Impact |\n| --- | --- |\n${rows}`;
      }
    }

    const depPhrase =
      depIncrease === 1
        ? '1 new dependency'
        : `${depIncrease} new dependencies`;

    messages.push(
      `## ⚠️ Dependency Count

This PR adds ${depPhrase} (${baseDepCount} → ${currentDepCount}), which exceeds the threshold of ${threshold}.${attributionSection}`
    );
  }
}
