import {
  fetchPackageMetadata,
  normalizeLicense,
  prefetchPackageMetadata
} from '../npm.js';
import {escapeMarkdownCell, formatTableWithCollapse} from '../common.js';

export interface ScanLicenseOptions {
  detectChanges?: boolean;
  blockedLicenses?: string[];
}

function extractLicenseTokens(licenseExpr: string): string[] {
  return licenseExpr
    .replace(/[()]/g, ' ')
    .split(/\s+(?:AND|OR|WITH)\s+|,/i)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isBlockedLicense(
  license: string | null,
  blockedSet: Set<string>
): boolean {
  if (blockedSet.size === 0) return false;
  if (!license) {
    return blockedSet.has('unlicensed') || blockedSet.has('unknown');
  }
  const lower = license.toLowerCase();
  if (blockedSet.has(lower)) return true;

  for (const token of extractLicenseTokens(license)) {
    if (blockedSet.has(token)) return true;
  }
  return false;
}

export async function scanForLicenses(
  messages: string[],
  currentDeps: Map<string, Set<string>>,
  baseDeps: Map<string, Set<string>>,
  options?: ScanLicenseOptions
): Promise<void> {
  const detectChanges = options?.detectChanges ?? true;
  const blockedSet = new Set(
    (options?.blockedLicenses ?? [])
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean)
  );

  if (!detectChanges && blockedSet.size === 0) {
    return;
  }

  const toPrefetch: Array<{name: string; version: string}> = [];
  for (const [name, currentVersions] of currentDeps) {
    const baseVersions = baseDeps.get(name);
    if (!baseVersions) {
      if (blockedSet.size > 0) {
        for (const v of currentVersions) toPrefetch.push({name, version: v});
      }
      continue;
    }

    if (!currentVersions.isSubsetOf(baseVersions)) {
      for (const v of baseVersions) toPrefetch.push({name, version: v});
      for (const v of currentVersions) toPrefetch.push({name, version: v});
    }
  }

  if (toPrefetch.length === 0) {
    return;
  }

  await prefetchPackageMetadata(toPrefetch);

  const changeRows: string[] = [];
  const blockedRows: string[] = [];

  for (const [name, currentVersions] of currentDeps) {
    const baseVersions = baseDeps.get(name);

    if (blockedSet.size > 0) {
      for (const version of currentVersions) {
        if (!baseVersions || !baseVersions.has(version)) {
          const meta = await fetchPackageMetadata(name, version);
          if (!meta) continue;
          const license = normalizeLicense(meta);
          if (isBlockedLicense(license, blockedSet)) {
            blockedRows.push(
              `| ${escapeMarkdownCell(`${name}@${version}`)} | ${escapeMarkdownCell(license ?? 'UNLICENSED')} |`
            );
          }
        }
      }
    }

    if (
      detectChanges &&
      baseVersions &&
      baseVersions.size > 0 &&
      !currentVersions.isSubsetOf(baseVersions)
    ) {
      const baseLicenses = new Set<string>();
      const currentLicenses = new Set<string>();

      for (const v of baseVersions) {
        const meta = await fetchPackageMetadata(name, v);
        if (meta) {
          baseLicenses.add(normalizeLicense(meta) ?? 'Unknown');
        }
      }

      for (const v of currentVersions) {
        const meta = await fetchPackageMetadata(name, v);
        if (meta) {
          currentLicenses.add(normalizeLicense(meta) ?? 'Unknown');
        }
      }

      if (baseLicenses.size === 0 || currentLicenses.size === 0) {
        continue;
      }

      let hasNewLicense = false;
      for (const lic of currentLicenses) {
        if (!baseLicenses.has(lic)) {
          hasNewLicense = true;
          break;
        }
      }

      if (hasNewLicense) {
        const beforeStr = Array.from(baseLicenses).join(', ');
        const afterStr = Array.from(currentLicenses).join(', ');
        changeRows.push(
          `| ${escapeMarkdownCell(name)} | ${escapeMarkdownCell(beforeStr)} | ${escapeMarkdownCell(afterStr)} |`
        );
      }
    }
  }

  if (changeRows.length > 0) {
    const table = formatTableWithCollapse(
      `| 📦 Package | 📜 Before | 📜 After |\n| --- | --- | --- |`,
      changeRows
    );
    messages.push(`## ⚠️ Package License Changes\n\n${table}`);
  }

  if (blockedRows.length > 0) {
    const table = formatTableWithCollapse(
      `| 📦 Package | 🚫 License |\n| --- | --- |`,
      blockedRows
    );
    messages.push(
      `## ⚠️ Disallowed Package Licenses\n\n> [!CAUTION]\n> The following new or updated packages use a blocked license.\n\n${table}`
    );
  }
}
