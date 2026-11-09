import {DEFAULT_ALLOWED_REGISTRIES} from '../constants.js';
import {escapeMarkdownCell, formatTableWithCollapse} from '../common.js';

function normalizeOrigin(urlStr: string): string | null {
  try {
    const url = new URL(urlStr.trim());
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.origin.toLowerCase();
    }
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function addOrigin(
  map: Map<string, Set<string>>,
  pkgName: string,
  origin: string | null
): void {
  if (!pkgName || !origin) return;
  let set = map.get(pkgName);
  if (!set) {
    set = new Set();
    map.set(pkgName, set);
  }
  set.add(origin);
}

function extractPkgNameFromNodeModulesPath(pathKey: string): string | null {
  const idx = pathKey.lastIndexOf('node_modules/');
  if (idx === -1) return null;
  const name = pathKey.slice(idx + 'node_modules/'.length).trim();
  return name || null;
}

function extractPkgNameFromTarballUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    const dashIdx = url.pathname.indexOf('/-/');
    if (dashIdx <= 1) return null;
    const rawPath = decodeURIComponent(url.pathname.slice(1, dashIdx));
    const segments = rawPath.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const lastTwo = segments.slice(-2);
      if (lastTwo[0].startsWith('@')) {
        return `${lastTwo[0]}/${lastTwo[1]}`;
      }
    }
    return segments[segments.length - 1] ?? null;
  } catch {
    return null;
  }
}

export function extractLockfileRegistries(
  lockfileContent: string,
  lockfileFilename: string
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  if (lockfileFilename.endsWith('package-lock.json')) {
    try {
      const parsed = JSON.parse(lockfileContent) as {
        packages?: Record<string, {name?: string; resolved?: string}>;
        dependencies?: Record<
          string,
          {resolved?: string; dependencies?: unknown}
        >;
      };

      if (parsed.packages && typeof parsed.packages === 'object') {
        for (const [pkgPath, entry] of Object.entries(parsed.packages)) {
          if (!entry?.resolved) continue;
          const pkgName =
            entry.name ?? extractPkgNameFromNodeModulesPath(pkgPath);
          if (pkgName) {
            addOrigin(result, pkgName, normalizeOrigin(entry.resolved));
          }
        }
      }

      const visitV1Deps = (
        deps:
          | Record<string, {resolved?: string; dependencies?: unknown}>
          | undefined
      ): void => {
        if (!deps || typeof deps !== 'object') return;
        for (const [name, info] of Object.entries(deps)) {
          if (info?.resolved) {
            addOrigin(result, name, normalizeOrigin(info.resolved));
          }
          if (info?.dependencies && typeof info.dependencies === 'object') {
            visitV1Deps(
              info.dependencies as Record<
                string,
                {resolved?: string; dependencies?: unknown}
              >
            );
          }
        }
      };

      visitV1Deps(parsed.dependencies);
      return result;
    } catch {
      // Fall through to generic URL extraction if JSON is malformed
    }
  }

  const urlRegex = /https?:\/\/[^\s"'<>]+/g;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(lockfileContent)) !== null) {
    const rawUrl = match[0].replace(/[,;]+$/, '');
    const pkgName = extractPkgNameFromTarballUrl(rawUrl);
    if (pkgName) {
      addOrigin(result, pkgName, normalizeOrigin(rawUrl));
    }
  }

  return result;
}

export function scanForRegistryChanges(
  messages: string[],
  baseLockContent: string,
  currentLockContent: string,
  lockfileFilename: string,
  currentDeps: Map<string, Set<string>>,
  baseDeps: Map<string, Set<string>>,
  allowedRegistries: string[] = DEFAULT_ALLOWED_REGISTRIES
): void {
  const allowedOrigins = new Set(
    allowedRegistries
      .map(
        (r) => normalizeOrigin(r) ?? r.trim().toLowerCase().replace(/\/+$/, '')
      )
      .filter(Boolean)
  );

  const baseRegistries = extractLockfileRegistries(
    baseLockContent,
    lockfileFilename
  );
  const currentRegistries = extractLockfileRegistries(
    currentLockContent,
    lockfileFilename
  );

  const rows: string[] = [];

  for (const [pkgName] of currentDeps) {
    const currOrigins = currentRegistries.get(pkgName);
    if (!currOrigins || currOrigins.size === 0) {
      continue;
    }

    const baseOrigins = baseRegistries.get(pkgName);
    const existedInBase = baseDeps.has(pkgName);

    if (existedInBase && baseOrigins && baseOrigins.size > 0) {
      let hasChangedOrigin = false;
      for (const origin of currOrigins) {
        if (!baseOrigins.has(origin)) {
          hasChangedOrigin = true;
          break;
        }
      }
      if (hasChangedOrigin) {
        rows.push(
          `| ${escapeMarkdownCell(pkgName)} | ${escapeMarkdownCell(Array.from(baseOrigins).join(', '))} | ${escapeMarkdownCell(Array.from(currOrigins).join(', '))} |`
        );
        continue;
      }
    }

    if (!existedInBase && allowedOrigins.size > 0) {
      const disallowed = Array.from(currOrigins).filter(
        (origin) => !allowedOrigins.has(origin)
      );
      if (disallowed.length > 0) {
        rows.push(
          `| ${escapeMarkdownCell(pkgName)} | _New_ | ${escapeMarkdownCell(disallowed.join(', '))} |`
        );
      }
    }
  }

  if (rows.length > 0) {
    const table = formatTableWithCollapse(
      `| 📦 Package | 🌐 Previous Registry | 🌐 Current Registry |\n| --- | --- | --- |`,
      rows
    );

    messages.push(
      `## ⚠️ Package Registry Changes

> [!CAUTION]
> The following packages changed their resolved registry origin or use a non-standard registry.

${table}`
    );
  }
}
