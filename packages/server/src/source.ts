/**
 * Where the mail comes from.
 *
 * Two sources, one shape. A folder of `.eml` files is what somebody's mail
 * client exports and is what the demonstration reads by default; an IMAP
 * mailbox is what the original actually did, and is the half a project like
 * this usually leaves out.
 *
 * Both produce the same thing — messages, named — and everything downstream is
 * written against that and knows about neither. Which is the point of them
 * being here rather than woven through the reading: adding a third (a Gmail
 * API, a Maildir, an mbox) is a file, not an edit.
 */

import path from 'node:path';

import { fetchAll, mailboxFrom } from './imap/client.js';
import type { Raw } from './mailbox.js';

export interface Source {
  /** For the health endpoint and the log: where this is reading, in words. */
  readonly describes: string;
  load(): Promise<{ raws: Raw[]; from: string }>;
}

export function folderSource(folder: string): Source {
  const full = path.resolve(folder);

  return {
    describes: full,
    async load() {
      // Imported here rather than at the top so this module can be reasoned
      // about without the filesystem, and so an IMAP-only deployment never
      // touches it.
      const { readdirSync, readFileSync } = await import('node:fs');

      const files = readdirSync(full)
        .filter((name) => name.toLowerCase().endsWith('.eml'))
        .sort();

      return {
        from: full,
        raws: files.map((name) => {
          try {
            return { name, raw: readFileSync(path.join(full, name), 'utf8') };
          } catch (error) {
            return { name, raw: error as Error };
          }
        }),
      };
    },
  };
}

/**
 * `imap://user:pass@host:143/INBOX`, or `imaps://…` for TLS.
 *
 * The name a message is given is its UID, padded, so the order on screen is
 * the order in the mailbox — and so that two syncs of an unchanged mailbox
 * produce the same names, which a name derived from the subject would not.
 */
export function imapSource(url: string): Source {
  const mailbox = mailboxFrom(url);
  const where = `imap${mailbox.secure ? 's' : ''}://${mailbox.host}:${mailbox.port}/${mailbox.folder}`;

  return {
    describes: where,
    async load() {
      const fetched = await fetchAll(mailbox);

      return {
        from: where,
        raws: fetched.map((one) => ({
          name: `${String(one.uid).padStart(4, '0')}.eml`,
          raw: one.raw,
        })),
      };
    },
  };
}

/**
 * Whichever the arguments asked for.
 *
 * `--imap` wins if both are given, and that is not arbitrary: somebody who has
 * gone to the trouble of naming a mailbox meant it, and silently reading a
 * folder instead would be the worst possible answer — a system that appears to
 * have synced, from the wrong place.
 */
export function sourceFrom({ imap, folder }: { imap?: string | undefined; folder: string }): Source {
  return imap ? imapSource(imap) : folderSource(folder);
}
