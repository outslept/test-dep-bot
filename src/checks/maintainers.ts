import {fetchPackageMetadata, prefetchPackageMetadata} from '../npm.js';
import {escapeMarkdownCell, formatTableWithCollapse} from '../common.js';

export async function scanForMaintainers(
  messages: string[],
  currentDeps: Map<string, Set<string>>,
  baseDeps: Map<string, Set<string>>,
  blockedMaintainers: string[]
): Promise<void> {
  const blockedSet = new Set(
    blockedMaintainers.map((m) => m.trim().toLowerCase()).filter(Boolean)
  );

  if (blockedSet.size === 0) {
    return;
  }

  const changedPackages: Array<{name: string; version: string}> = [];
  for (const [name, currentVersions] of currentDeps) {
    const baseVersions = baseDeps.get(name);
    for (const version of currentVersions) {
      if (!baseVersions || !baseVersions.has(version)) {
        changedPackages.push({name, version});
      }
    }
  }

  if (changedPackages.length === 0) {
    return;
  }

  await prefetchPackageMetadata(changedPackages);

  const matchedRows: string[] = [];

  for (const {name, version} of changedPackages) {
    const meta = await fetchPackageMetadata(name, version);
    if (!meta) continue;

    const matchedUsers = new Map<string, string>();
    const publisher = meta._npmUser?.name?.trim();
    if (publisher && blockedSet.has(publisher.toLowerCase())) {
      matchedUsers.set(publisher.toLowerCase(), `${publisher} (publisher)`);
    }

    if (Array.isArray(meta.maintainers)) {
      for (const maintainer of meta.maintainers) {
        const mName = maintainer?.name?.trim();
        if (
          mName &&
          blockedSet.has(mName.toLowerCase()) &&
          !matchedUsers.has(mName.toLowerCase())
        ) {
          matchedUsers.set(mName.toLowerCase(), `${mName} (maintainer)`);
        }
      }
    }

    if (matchedUsers.size > 0) {
      matchedRows.push(
        `| ${escapeMarkdownCell(`${name}@${version}`)} | ${escapeMarkdownCell(Array.from(matchedUsers.values()).join(', '))} |`
      );
    }
  }

  if (matchedRows.length > 0) {
    const table = formatTableWithCollapse(
      `| 📦 Package | 👤 Matched User |\n| --- | --- |`,
      matchedRows
    );

    messages.push(
      `## ⚠️ Blocked Package Maintainers

> [!CAUTION]
> The following packages are published or maintained by users on the blocklist.

${table}`
    );
  }
}
