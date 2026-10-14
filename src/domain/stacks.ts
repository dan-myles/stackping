export const MAX_PULL_REQUESTS_PER_STACK = 25

export interface BranchInfo {
  readonly headRepositoryId: number
  readonly headRef: string
  readonly baseRepositoryId: number
  readonly baseRef: string
  readonly defaultBranch: string | null
}

/** Long-lived branches: the repository default branch plus configured extras. */
export function trunkBranches(
  defaultBranch: string | null,
  extra: ReadonlyArray<string>,
): ReadonlySet<string> {
  return new Set([...(defaultBranch ? [defaultBranch] : []), ...extra])
}

/**
 * A PR whose head is a trunk branch (e.g. `develop` → `main`) is a promotion,
 * not a stack member. Every feature PR targets a trunk, so linking stacks
 * through it would make every open PR a child of the promotion.
 */
export function isTrunkPromotion(
  pr: BranchInfo,
  extraTrunks: ReadonlyArray<string>,
): boolean {
  return (
    pr.headRepositoryId === pr.baseRepositoryId &&
    trunkBranches(pr.defaultBranch, extraTrunks).has(pr.headRef)
  )
}

/** Whether `child` is stacked on `parent` by branch relationship. */
export function isStackedOn(child: BranchInfo, parent: BranchInfo): boolean {
  return (
    child.baseRepositoryId === parent.headRepositoryId &&
    child.baseRef === parent.headRef
  )
}
