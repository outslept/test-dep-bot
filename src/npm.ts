import * as core from '@actions/core';
import type {PackageJson} from 'pkg-types';
import {
  getTrustLevel,
  getTrustLevelName,
  getTrustStatus,
  type TrustLevelName,
  type TrustStatus
} from 'packumeta';
import {mapConcurrent, matchesAnyPattern} from './common.js';

export interface PackageMetadata {
  name: string;
  version: string;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  license?: string | {type?: string};
  licenses?: Array<{type?: string}>;
  engines?: {
    node?: string;
    [key: string]: string | undefined;
  };
  deprecated?: string;
  scripts?: Record<string, string>;
  dist?: {
    unpackedSize?: number;
    fileCount?: number;
    tarball?: string;
    attestations?: {
      url: string;
      provenance?: unknown;
    };
  };
  _npmUser?: {
    name: string;
    email?: string;
    trustedPublisher?: unknown;
  };
  maintainers?: Array<{
    name: string;
    email?: string;
  }>;
  dependencies?: Record<string, string>;
}

export interface PackageIndex {
  versions: Record<string, PackageMetadata>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const FETCH_CONCURRENCY = 8;

export async function getProvenanceForPackageVersions(
  packageName: string,
  versions: Set<string>
): Promise<Map<string, TrustStatus>> {
  const result = new Map<string, TrustStatus>();
  for (const version of versions) {
    const metadata = await fetchPackageMetadata(packageName, version);
    if (metadata) {
      result.set(version, getTrustStatus(metadata));
    }
  }
  return result;
}

export interface MinTrustLevelResult {
  level: number;
  status: TrustLevelName;
}

export function getMinTrustLevel(
  statuses: Iterable<TrustStatus>
): MinTrustLevelResult {
  let result: MinTrustLevelResult | null = null;
  for (const status of statuses) {
    const level = getTrustLevel(status);
    if (result === null || level < result.level) {
      result = {level, status: getTrustLevelName(status)};
    }
  }
  if (!result) {
    return {
      level: 0,
      status: 'none'
    };
  }
  return result;
}

type MaybePromise<T> = T | Promise<T>;

export const metaCache = new Map<
  string,
  MaybePromise<PackageMetadata | null>
>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function parseRetryAfterMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 15_000);
    }
  }
  return 300 * Math.pow(2, attempt);
}

async function fetchPackageMetadataImmediate(
  packageName: string,
  version: string
): Promise<PackageMetadata | null> {
  const encodedVersion = encodeURIComponent(version);
  const url = `https://registry.npmjs.org/${packageName}/${encodedVersion}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (response.ok) {
        return (await response.json()) as PackageMetadata;
      }

      if (attempt < MAX_RETRIES && isRetryableStatus(response.status)) {
        const delayMs = parseRetryAfterMs(
          response.headers.get('retry-after'),
          attempt
        );
        await sleep(delayMs);
        continue;
      }

      return null;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(300 * Math.pow(2, attempt));
        continue;
      }
      core.info(
        `Failed to fetch metadata for ${packageName}@${version}: ${err}`
      );
      return null;
    }
  }

  return null;
}

export async function fetchPackageMetadata(
  packageName: string,
  version: string
): Promise<PackageMetadata | null> {
  const cacheKey = `${packageName}@${version}`;
  if (metaCache.has(cacheKey)) {
    return metaCache.get(cacheKey) ?? null;
  }
  const metaPromise = fetchPackageMetadataImmediate(packageName, version);
  metaCache.set(cacheKey, metaPromise);
  const result = await metaPromise;
  metaCache.set(cacheKey, result);
  return result;
}

export async function prefetchPackageMetadata(
  packages: Iterable<{name: string; version: string}>
): Promise<void> {
  await mapConcurrent(packages, FETCH_CONCURRENCY, ({name, version}) =>
    fetchPackageMetadata(name, version)
  );
}

export async function calculateTotalDependencySizeIncrease(
  newVersions: Array<{name: string; version: string}>,
  removedVersions: Array<{name: string; version: string}>
): Promise<{
  totalSize: number;
  packageSizes: Map<string, number | null>;
  unknownPackages: string[];
} | null> {
  let totalSize = 0;
  const processedPackages = new Set<string>();
  const packageSizes = new Map<string, number | null>();
  const unknownPackages: string[] = [];

  await prefetchPackageMetadata([...newVersions, ...removedVersions]);

  const entries: Array<{name: string; version: string; sign: 1 | -1}> = [
    ...newVersions.map((d) => ({
      name: d.name,
      version: d.version,
      sign: 1 as const
    })),
    ...removedVersions.map((d) => ({
      name: d.name,
      version: d.version,
      sign: -1 as const
    }))
  ];

  for (const dep of entries) {
    const packageKey = `${dep.name}@${dep.version}`;

    if (processedPackages.has(packageKey)) {
      continue;
    }
    processedPackages.add(packageKey);

    const metadata = await fetchPackageMetadata(dep.name, dep.version);

    if (!metadata || metadata.dist?.unpackedSize === undefined) {
      packageSizes.set(packageKey, null);
      unknownPackages.push(packageKey);
      core.info(`No unpacked size info for ${packageKey}, skipping`);
    } else {
      const signedSize = dep.sign * metadata.dist.unpackedSize;
      totalSize += signedSize;
      packageSizes.set(packageKey, signedSize);
      core.info(
        `${dep.sign > 0 ? 'Added' : 'Subtracted'} ${metadata.dist.unpackedSize} bytes for ${packageKey}`
      );
    }
  }

  return {totalSize, packageSizes, unknownPackages};
}

export function normalizeLicense(meta: PackageMetadata): string | null {
  if (typeof meta.license === 'string' && meta.license.trim().length > 0) {
    return meta.license.trim();
  }
  if (
    meta.license &&
    typeof meta.license === 'object' &&
    typeof meta.license.type === 'string' &&
    meta.license.type.trim().length > 0
  ) {
    return meta.license.type.trim();
  }
  if (Array.isArray(meta.licenses) && meta.licenses.length > 0) {
    const types = meta.licenses
      .map((l) => l?.type?.trim())
      .filter((t): t is string => Boolean(t));
    if (types.length > 0) {
      return types.join(' OR ');
    }
  }
  return null;
}

export type DependencyType = 'prod' | 'dev' | 'optional' | 'peer';

const dependencyTypeMap = {
  prod: 'dependencies',
  dev: 'devDependencies',
  optional: 'optionalDependencies',
  peer: 'peerDependencies'
} satisfies Record<DependencyType, keyof PackageJson>;

export function getDependenciesFromPackageJson(
  pkg: PackageJson,
  types: DependencyType[],
  excludePatterns: string[] = []
): Map<string, string> {
  const result = new Map<string, string>();

  for (const type of types) {
    const value = pkg[dependencyTypeMap[type]];
    if (value === undefined) {
      continue;
    }

    for (const [name, version] of Object.entries(value)) {
      if (typeof version !== 'string') {
        continue;
      }
      if (
        excludePatterns.length > 0 &&
        matchesAnyPattern(name, excludePatterns)
      ) {
        continue;
      }
      result.set(name, version);
    }
  }

  return result;
}

export function isSupportedArchitecture(
  pkg: PackageJson | PackageMetadata,
  os: string,
  cpu: string,
  libc?: string
): boolean {
  const osMatches =
    pkg.os === undefined || pkg.os.length === 0 || pkg.os.includes(os);
  const cpuMatches =
    pkg.cpu === undefined || pkg.cpu.length === 0 || pkg.cpu.includes(cpu);
  const libcMatches =
    pkg.libc === undefined || pkg.libc.length === 0 || pkg.libc.includes(libc);
  return osMatches && cpuMatches && libcMatches;
}
