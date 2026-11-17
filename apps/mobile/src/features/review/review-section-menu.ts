import type { ReviewSectionItem } from "./reviewModel";

export interface ReviewSectionMenu {
  readonly workingTree: ReviewSectionItem | null;
  readonly branchChanges: ReviewSectionItem | null;
  readonly gitButlerBranches: ReadonlyArray<ReviewSectionItem>;
  readonly latestTurn: ReviewSectionItem | null;
  readonly turns: ReadonlyArray<ReviewSectionItem>;
}

export function buildReviewSectionMenu(
  sections: ReadonlyArray<ReviewSectionItem>,
): ReviewSectionMenu {
  const turns = sections.filter((section) => section.kind === "turn");

  return {
    workingTree: sections.find((section) => section.kind === "working-tree") ?? null,
    branchChanges: sections.find((section) => section.kind === "branch-range") ?? null,
    gitButlerBranches: sections.filter((section) => section.kind === "gitbutler-branch"),
    latestTurn: turns[0] ?? null,
    turns,
  };
}
