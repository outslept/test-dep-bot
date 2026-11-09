import {escapeMarkdownCell, formatBytes, formatBytesSigned} from '../common.js';
import {comparePackSizes, type PackInfo} from '../packs.js';

export async function scanForBundleSize(
  messages: string[],
  basePacks: PackInfo[],
  sourcePacks: PackInfo[],
  threshold: number
): Promise<void> {
  if (basePacks.length === 0 && sourcePacks.length === 0) {
    return;
  }
  const comparison = comparePackSizes(basePacks, sourcePacks, threshold);

  const packWarnings = comparison.packChanges.filter(
    (change) => change.exceedsThreshold
  );

  if (threshold === -1 && packWarnings.length === 0) {
    messages.push(`## 📦 Package Bundle Size\n\nNo bundle size changes.`);
    return;
  }

  if (packWarnings.length > 0) {
    const hasDecreases = packWarnings.some((c) => c.sizeChange < 0);
    const hasIncreases = packWarnings.some((c) => c.sizeChange > 0);
    const heading =
      hasDecreases && hasIncreases
        ? '## 📦 Package Bundle Size Changes'
        : hasDecreases
          ? '## 🎉 Package Size Decrease'
          : '## ⚠️ Package Size Increase';
    const packRows = packWarnings
      .map((change) => {
        const baseSize =
          change.baseSize !== null ? formatBytes(change.baseSize) : 'New';
        const sourceSize =
          change.sourceSize !== null
            ? formatBytes(change.sourceSize)
            : 'Removed';
        const sizeChange = formatBytesSigned(change.sizeChange);
        return `| ${escapeMarkdownCell(change.name)} | ${baseSize} | ${sourceSize} | ${sizeChange} |`;
      })
      .join('\n');

    const thresholdText =
      threshold === -1
        ? ''
        : `\nThese packages exceed the size change threshold of ${formatBytes(threshold)}:\n`;

    messages.push(
      `${heading}
${thresholdText}
| 📦 Package | 📏 Base Size | 📏 Source Size | 📈 Size Change |
| --- | --- | --- | --- |
${packRows}`
    );
  }
}
