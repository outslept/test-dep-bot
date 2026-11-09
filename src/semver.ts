export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_REGEX =
  /^v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(version: string): SemVer | null {
  const cleaned = version.trim();
  const match = SEMVER_REGEX.exec(cleaned);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: match[2] !== undefined ? Number(match[2]) : 0,
    patch: match[3] !== undefined ? Number(match[3]) : 0,
    prerelease: match[4] ? match[4].split('.') : []
  };
}

export function formatSemver(v: SemVer): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length > 0 ? `${base}-${v.prerelease.join('.')}` : base;
}

export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const idA = a.prerelease[i];
    const idB = b.prerelease[i];
    if (idA === undefined) return -1;
    if (idB === undefined) return 1;
    if (idA === idB) continue;

    const numA = /^\d+$/.test(idA) ? Number(idA) : NaN;
    const numB = /^\d+$/.test(idB) ? Number(idB) : NaN;

    if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
      return numA - numB;
    }
    if (!Number.isNaN(numA)) return -1;
    if (!Number.isNaN(numB)) return 1;
    return idA < idB ? -1 : 1;
  }

  return 0;
}

interface Comparator {
  op: '=' | '>' | '>=' | '<' | '<=';
  version: SemVer;
}

function isWildcard(part: string | undefined): boolean {
  return (
    part === undefined ||
    part === '' ||
    part === '*' ||
    part === 'x' ||
    part === 'X'
  );
}

function parsePartial(raw: string): {
  major?: number;
  minor?: number;
  patch?: number;
  prerelease: string[];
} | null {
  const cleaned = raw.trim().replace(/^[=v]+/, '');
  if (isWildcard(cleaned)) {
    return {prerelease: []};
  }

  const [versionPart, prePart] = cleaned.split('-', 2);
  const parts = versionPart.split('.');
  if (parts.length > 3) return null;

  const [majStr, minStr, patStr] = parts;
  if (isWildcard(majStr)) {
    return {prerelease: []};
  }
  if (!/^\d+$/.test(majStr)) return null;
  const major = Number(majStr);

  if (isWildcard(minStr)) {
    return {major, prerelease: []};
  }
  if (!/^\d+$/.test(minStr)) return null;
  const minor = Number(minStr);

  if (isWildcard(patStr)) {
    return {major, minor, prerelease: []};
  }
  if (!/^\d+$/.test(patStr)) return null;
  const patch = Number(patStr);

  return {
    major,
    minor,
    patch,
    prerelease: prePart ? prePart.split('.') : []
  };
}

function expandTokenToComparators(token: string): Comparator[] | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'x' || trimmed === 'X') {
    return [
      {op: '>=', version: {major: 0, minor: 0, patch: 0, prerelease: []}}
    ];
  }

  if (trimmed.startsWith('^')) {
    const p = parsePartial(trimmed.slice(1));
    if (!p || p.major === undefined) return null;
    const min: SemVer = {
      major: p.major,
      minor: p.minor ?? 0,
      patch: p.patch ?? 0,
      prerelease: p.prerelease
    };
    let max: SemVer;
    if (p.major > 0 || p.minor === undefined) {
      max = {major: p.major + 1, minor: 0, patch: 0, prerelease: []};
    } else if (p.minor > 0 || p.patch === undefined) {
      max = {major: 0, minor: p.minor + 1, patch: 0, prerelease: []};
    } else {
      max = {major: 0, minor: 0, patch: p.patch + 1, prerelease: []};
    }
    return [
      {op: '>=', version: min},
      {op: '<', version: max}
    ];
  }

  if (trimmed.startsWith('~')) {
    const p = parsePartial(trimmed.slice(1));
    if (!p || p.major === undefined) return null;
    const min: SemVer = {
      major: p.major,
      minor: p.minor ?? 0,
      patch: p.patch ?? 0,
      prerelease: p.prerelease
    };
    const max: SemVer =
      p.minor === undefined
        ? {major: p.major + 1, minor: 0, patch: 0, prerelease: []}
        : {major: p.major, minor: p.minor + 1, patch: 0, prerelease: []};
    return [
      {op: '>=', version: min},
      {op: '<', version: max}
    ];
  }

  const opMatch = /^(>=|<=|>|<|=)\s*(.+)$/.exec(trimmed);
  if (opMatch) {
    const op = opMatch[1] as Comparator['op'];
    const p = parsePartial(opMatch[2]);
    if (!p) return null;
    if (p.major === undefined) {
      return [
        {op: '>=', version: {major: 0, minor: 0, patch: 0, prerelease: []}}
      ];
    }

    if (p.minor === undefined) {
      if (op === '>' || op === '<=') {
        return [
          {
            op: '<',
            version: {major: p.major + 1, minor: 0, patch: 0, prerelease: []}
          }
        ];
      }
      if (op === '>=') {
        return [
          {
            op: '>=',
            version: {major: p.major, minor: 0, patch: 0, prerelease: []}
          }
        ];
      }
      if (op === '<') {
        return [
          {
            op: '<',
            version: {major: p.major, minor: 0, patch: 0, prerelease: []}
          }
        ];
      }
    }

    if (p.patch === undefined && p.minor !== undefined) {
      if (op === '>' || op === '<=') {
        return [
          {
            op: '<',
            version: {
              major: p.major,
              minor: p.minor + 1,
              patch: 0,
              prerelease: []
            }
          }
        ];
      }
    }

    return [
      {
        op,
        version: {
          major: p.major,
          minor: p.minor ?? 0,
          patch: p.patch ?? 0,
          prerelease: p.prerelease
        }
      }
    ];
  }

  const p = parsePartial(trimmed);
  if (!p) return null;
  if (p.major === undefined) {
    return [
      {op: '>=', version: {major: 0, minor: 0, patch: 0, prerelease: []}}
    ];
  }
  if (p.minor === undefined) {
    return [
      {op: '>=', version: {major: p.major, minor: 0, patch: 0, prerelease: []}},
      {
        op: '<',
        version: {major: p.major + 1, minor: 0, patch: 0, prerelease: []}
      }
    ];
  }
  if (p.patch === undefined) {
    return [
      {
        op: '>=',
        version: {major: p.major, minor: p.minor, patch: 0, prerelease: []}
      },
      {
        op: '<',
        version: {
          major: p.major,
          minor: p.minor + 1,
          patch: 0,
          prerelease: []
        }
      }
    ];
  }

  return [
    {
      op: '=',
      version: {
        major: p.major,
        minor: p.minor,
        patch: p.patch,
        prerelease: p.prerelease
      }
    }
  ];
}

function parseRangeConjunction(branch: string): Comparator[] | null {
  const normalized = branch
    .trim()
    .replace(/([><=~^])\s+/g, '$1')
    .replace(
      /(\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?)\s+-\s+(\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?)/g,
      '>=$1 <=$2'
    );

  if (!normalized) {
    return [
      {op: '>=', version: {major: 0, minor: 0, patch: 0, prerelease: []}}
    ];
  }

  const tokens = normalized.split(/\s+/);
  const comparators: Comparator[] = [];

  for (const token of tokens) {
    const expanded = expandTokenToComparators(token);
    if (!expanded) return null;
    comparators.push(...expanded);
  }

  return comparators;
}

export function parseSemverRange(range: string): Comparator[][] | null {
  const cleaned = range.trim();
  if (!cleaned) return null;

  const branches = cleaned.split('||');
  const result: Comparator[][] = [];

  for (const branch of branches) {
    const parsed = parseRangeConjunction(branch);
    if (!parsed) return null;
    result.push(parsed);
  }

  return result.length > 0 ? result : null;
}

function satisfiesComparator(v: SemVer, comp: Comparator): boolean {
  const cmp = compareSemver(v, comp.version);
  switch (comp.op) {
    case '=':
      return cmp === 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
  }
}

export function satisfiesSemver(
  version: SemVer | string,
  range: string
): boolean {
  const v = typeof version === 'string' ? parseSemver(version) : version;
  if (!v) return false;
  const parsedRange = parseSemverRange(range);
  if (!parsedRange) return false;

  for (const conjunction of parsedRange) {
    let allMatch = true;
    for (const comp of conjunction) {
      if (!satisfiesComparator(v, comp)) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return true;
  }

  return false;
}

/**
 * Computes the lowest SemVer version that satisfies a given semver range.
 */
export function minSemverVersion(range: string): SemVer | null {
  const parsedRange = parseSemverRange(range);
  if (!parsedRange) return null;

  let lowest: SemVer | null = null;

  for (const conjunction of parsedRange) {
    let branchMin: SemVer = {major: 0, minor: 0, patch: 0, prerelease: []};

    for (const comp of conjunction) {
      if (comp.op === '=') {
        if (compareSemver(comp.version, branchMin) > 0) {
          branchMin = {...comp.version};
        }
      } else if (comp.op === '>=') {
        if (compareSemver(comp.version, branchMin) > 0) {
          branchMin = {...comp.version};
        }
      } else if (comp.op === '>') {
        const bumped: SemVer = {
          major: comp.version.major,
          minor: comp.version.minor,
          patch: comp.version.patch + 1,
          prerelease: []
        };
        if (compareSemver(bumped, branchMin) > 0) {
          branchMin = bumped;
        }
      }
    }

    let validBranch = true;
    for (const comp of conjunction) {
      if (!satisfiesComparator(branchMin, comp)) {
        validBranch = false;
        break;
      }
    }

    if (validBranch) {
      if (lowest === null || compareSemver(branchMin, lowest) < 0) {
        lowest = branchMin;
      }
    }
  }

  return lowest;
}
