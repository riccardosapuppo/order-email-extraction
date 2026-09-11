/**
 * Which browser these checks drive, and why it is not always the same one.
 *
 * On a desk the answer is Edge, already installed. `playwright-core` drives a
 * browser that is there rather than fetching one, and that is deliberate: the
 * README promises Node and nothing else, and `npm install` pulling down 300 MB
 * of browser would make that promise false for everybody who only wants to run
 * the thing. These are checks, not a dependency.
 *
 * In continuous integration there is no Edge and nothing to protect: the runner
 * installs a browser, runs them, and is thrown away. The one it installs is the
 * Chromium Playwright brings with it.
 *
 * So the channel is a setting with a sensible default rather than a constant.
 *
 * Empty and unset are deliberately different. Unset means "the local default";
 * empty means "whatever Playwright brought", which is not a channel at all and
 * has to reach `launch` as undefined rather than as an empty string — passing
 * '' asks for a channel named nothing and fails with a message about a missing
 * browser, which reads like the machine has none.
 */
export function channel() {
  const asked = process.env.PLAYWRIGHT_CHANNEL;
  if (asked === undefined) return 'msedge';
  return asked.trim() === '' ? undefined : asked.trim();
}

/** The launch options these checks share. */
export function howToLaunch(extra = {}) {
  const chosen = channel();
  return chosen ? { channel: chosen, ...extra } : { ...extra };
}
