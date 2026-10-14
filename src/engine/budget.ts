/** Thrown when an invocation has used its outbound request allowance. */
export class BudgetExhausted extends Error {
  override readonly name = "BudgetExhausted"
}

/**
 * Counts outbound requests per invocation. Workers Free allows 50 subrequests
 * per invocation, so each alarm does a bounded slice of work and re-arms.
 */
export class Budget {
  #remaining = Number.POSITIVE_INFINITY

  reset(limit: number): void {
    this.#remaining = limit
  }

  unlimited(): void {
    this.#remaining = Number.POSITIVE_INFINITY
  }

  get remaining(): number {
    return this.#remaining
  }

  consume(): void {
    if (this.#remaining <= 0)
      throw new BudgetExhausted("Subrequest budget exhausted")
    this.#remaining -= 1
  }

  /** Wraps `fetch` so every call spends one unit. */
  wrap(
    fetcher: (input: string, init?: RequestInit) => Promise<Response>,
  ): (input: string, init?: RequestInit) => Promise<Response> {
    return (input, init) => {
      this.consume()
      return fetcher(input, init)
    }
  }
}
