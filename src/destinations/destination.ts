import type {
  CiSummaryView,
  MessageRef,
  PullRequestView,
  StackView,
  ThreadItemView,
} from "../domain/view.ts"

/**
 * A rendered message. `key` identifies the visible content: the engine skips
 * the destination call when it matches what was last delivered.
 */
export interface Rendered {
  readonly key: string
}

export interface PostTarget {
  readonly channel: string
  /** Post as a reply in this thread. */
  readonly threadTs?: string
}

/**
 * The seam between the engine and a chat product. The engine decides what to
 * deliver and when; a destination only renders and performs the calls.
 */
export interface Destination<R extends Rendered = Rendered> {
  readonly id: string
  /** Minimum spacing between writes to the same channel. */
  readonly spacingMs: number
  renderStack(view: StackView): Promise<R>
  renderThreadItem(view: ThreadItemView): Promise<R>
  renderCiSummary(view: CiSummaryView): Promise<R>
  renderMoved(
    pr: Pick<PullRequestView, "number" | "url">,
    root: Pick<PullRequestView, "number" | "url">,
  ): Promise<R>
  post(target: PostTarget, rendered: R): Promise<MessageRef>
  update(ref: MessageRef, rendered: R): Promise<void>
  /** Deletes a message; resolves "missing" if it was already gone. */
  remove(ref: MessageRef): Promise<"deleted" | "missing">
}

export class DeliveryError extends Error {
  override readonly name = "DeliveryError"
  readonly code: string
  readonly retryable: boolean
  readonly retryAfterMs: number | null
  /** The message or thread being edited no longer exists. */
  readonly notFound: boolean

  constructor(options: {
    readonly code: string
    readonly message: string
    readonly retryable: boolean
    readonly retryAfterMs?: number | null
    readonly notFound?: boolean
  }) {
    super(options.message)
    this.code = options.code
    this.retryable = options.retryable
    this.retryAfterMs = options.retryAfterMs ?? null
    this.notFound = options.notFound ?? false
  }
}
