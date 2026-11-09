export const COMMENT_TAG = '<!-- dependency-diff-action -->';
export const ARTIFACT_FILENAME = 'e18e-diff-result.json';

export const ALL_CHECKS = [
  'count',
  'size',
  'duplicates',
  'provenance',
  'replacements',
  'pack-size',
  'license',
  'engines',
  'registry',
  'maintainers'
] as const;

export type CheckName = (typeof ALL_CHECKS)[number];

export const VALID_MODES = [
  'comment',
  'artifact',
  'comment-from-artifact',
  'report'
] as const;

export type ActionMode = (typeof VALID_MODES)[number];

export const DEFAULT_ALLOWED_REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.yarnpkg.com'
];

export const MAX_TABLE_ROWS = 15;
