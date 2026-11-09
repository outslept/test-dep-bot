import {all as allReplacements, resolveDocUrl} from 'module-replacements';
import {escapeMarkdownCell, matchesAnyPattern} from '../common.js';

export interface ScanReplacementsOptions {
  excludeDependencies?: string[];
  currentLockDeps?: Map<string, Set<string>>;
  baseLockDeps?: Map<string, Set<string>>;
  includeTransitive?: boolean;
}

const replacementByModuleName = new Map(
  Object.values(allReplacements.mappings)
    .filter((m) => m.type === 'module')
    .map((m) => [m.moduleName, m])
);

function formatReplacementRow(name: string): string | null {
  const mapping = replacementByModuleName.get(name);
  if (!mapping) {
    return null;
  }

  const replacementKey = mapping.replacements[0];
  const replacement = allReplacements.replacements[replacementKey];
  if (!replacement) {
    return null;
  }

  const safeName = escapeMarkdownCell(name);

  switch (replacement.type) {
    case 'removal':
      return `| ${safeName} | ${escapeMarkdownCell(replacement.description)} |`;
    case 'native': {
      const url = resolveDocUrl(mapping.url ?? replacement.url);
      const nativeReplacement = url
        ? `[${escapeMarkdownCell(replacement.id)}](${url})`
        : escapeMarkdownCell(replacement.id);
      return `| ${safeName} | Use ${nativeReplacement} |`;
    }
    case 'simple':
      return `| ${safeName} | ${escapeMarkdownCell(replacement.description)} |`;
    case 'documented': {
      const url = resolveDocUrl(mapping.url ?? replacement.url);
      const documentedReplacement = url
        ? `[${escapeMarkdownCell(replacement.replacementModule)}](${url})`
        : escapeMarkdownCell(replacement.replacementModule);
      return `| ${safeName} | Use ${documentedReplacement} |`;
    }
  }
}

export function scanForReplacements(
  messages: string[],
  baseDependencies: Map<string, string>,
  currentDependencies: Map<string, string>,
  options?: ScanReplacementsOptions
): void {
  const replacementMessages: string[] = [];
  const excludePatterns = options?.excludeDependencies ?? [];
  const seenPackages = new Set<string>();

  for (const [name] of currentDependencies) {
    if (baseDependencies.has(name)) continue;
    if (
      excludePatterns.length > 0 &&
      matchesAnyPattern(name, excludePatterns)
    ) {
      continue;
    }
    seenPackages.add(name);
    const row = formatReplacementRow(name);
    if (row) {
      replacementMessages.push(row);
    }
  }

  if (
    options?.includeTransitive &&
    options.currentLockDeps &&
    options.baseLockDeps
  ) {
    for (const [name] of options.currentLockDeps) {
      if (seenPackages.has(name) || options.baseLockDeps.has(name)) {
        continue;
      }
      if (
        excludePatterns.length > 0 &&
        matchesAnyPattern(name, excludePatterns)
      ) {
        continue;
      }
      seenPackages.add(name);
      const row = formatReplacementRow(name);
      if (row) {
        replacementMessages.push(row);
      }
    }
  }

  if (replacementMessages.length > 0) {
    messages.push(
      `## ⚠️ Recommended Package Replacements

The following new packages or versions have community recommended replacements:

| 📦 Package | 💡 Recommendation |
| --- | --- |
${replacementMessages.join('\n')}

> [!NOTE]
> These recommendations have been defined by the [e18e](https://e18e.dev) community.
> They may not always be a straightforward migration, so please review carefully
> and use the \`exclude-dependencies\` input if you want to ignore any of them in future.
`
    );
  }
}
