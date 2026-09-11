/**
 * The one thing a reader is.
 *
 * There are two of them and they are not alternatives to each other so much as
 * two answers to the same question, with different costs:
 *
 *  - **the rules** (`extract/rules.ts`) read the layouts somebody wrote rules
 *    for. Free, offline, the same answer every time, and every step of the
 *    reasoning is a function you can open. They are what runs in the checks,
 *    because a check whose answer can change on its own is not a check.
 *
 *  - **a model** (`read/answer.ts`) reads layouts nobody wrote a rule for,
 *    which is most of them — the original of this project used one for exactly
 *    that reason. It costs a key, a round trip and a few pennies a mailbox, and
 *    it will not give the same answer twice running.
 *
 * What makes them interchangeable is the contract, and the contract is the
 * point of the whole project: whatever reads a value has to say which words it
 * read it out of. A rule knows because the regular expression told it. A model
 * is asked, and then checked. Neither is allowed to hand over a number with
 * nothing behind it — which is what the system this reconstructs did, and why
 * a wrong quantity could not be traced to anything.
 *
 * Async because one of the two has to cross a network. The rules are wrapped in
 * a promise they do not need, which costs nothing and means the mailbox does
 * not have two code paths that drift.
 */

import type { Reading } from '../facts.js';
import type { Message } from '../message.js';
import { read, type ReadOptions } from '../extract/rules.js';

export interface Reader {
  /**
   * What goes in `provenance.rule` for everything this produces, and what the
   * interface shows. A function name for the rules; a model id for a model.
   * Not a category: "the model" is not something anybody can go and look at.
   */
  readonly name: string;

  /** For the README and the startup line, in words. */
  readonly describes: string;

  read(message: Message): Promise<Reading>;
}

/** The rules, as a reader. The default, and the one the checks use. */
export function theRules(options: ReadOptions = {}): Reader {
  return {
    name: 'rules',
    describes: 'the rules in extract/rules.ts',
    read: async (message) => read(message, options),
  };
}
