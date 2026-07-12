export interface PreviewFreezeComparison {
  label: string;
  equal?: boolean;
  missing?: string[];
  nonEmpty?: boolean;
  leftSha256?: string;
  rightSha256?: string;
}

export function validateFreezeComparisons(comparisons: PreviewFreezeComparison[]): void;
