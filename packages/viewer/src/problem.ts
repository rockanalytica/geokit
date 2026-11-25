// An error a person may read: the framework-
// free packages cannot word anything in the reader's language, so what they
// throw is a code and what fills it, which the app words through its strings
// as `problem.<code>`. The English goes along as the message, for logs, tests
// and anything that reads an Error plainly.

/** What fills a Problem's words: a value, or another error it was caused by. */
export type ProblemParam = string | number | Error;

export class Problem extends Error {
  override readonly name = "Problem";

  constructor(
    /** Dotted, the module first: `zarr.no_root`. The app's words are `problem.<code>`. */
    readonly code: string,
    /** The English, as the message: what `problem.<code>` says in English, filled. */
    english: string,
    /** What fills `{name}` in the words, by name. */
    readonly params: Readonly<Record<string, ProblemParam>> = {},
  ) {
    super(english);
  }
}
