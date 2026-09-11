import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ApiService, type ReaderNow } from '../shell/api.service';

/**
 * The screen where you choose who reads the mail.
 *
 * ── Why this is a screen and not a flag ──────────────────────────────────────
 *
 * There are two readers here, and for a while which one ran was decided by a
 * command-line flag and described in the README. That is the same as not having
 * the second one, for anybody who opens this to see what it does: they would
 * have to already know it existed, stop the thing, and start it again with
 * different arguments. A capability you can only reach by restarting is a
 * capability nobody sees.
 *
 * So it is here, in the interface, with the field the model needs. Switching
 * re-reads the whole mailbox and the numbers underneath say what that produced,
 * which is the only honest way to compare two readers: the same eleven
 * messages, read twice.
 *
 * ── The key ──────────────────────────────────────────────────────────────────
 *
 * It goes to a server on this machine and no further. It is not stored here --
 * no localStorage, no cookie, no query string -- and it is not stored there
 * either: it lives in a closure for the life of the process, is never written
 * to disk, never logged, and never sent back. Reloading this page forgets it;
 * switching back to the rules forgets it on the server too.
 *
 * That is a reasonable arrangement for something that binds to localhost and is
 * started by the person using it. It would not be one for anything deployed,
 * and the page says so rather than leaving somebody to assume.
 */
@Component({
  selector: 'app-reading',
  standalone: true,
  imports: [RouterLink],
  template: `
    <p class="back"><a routerLink="/orders">← every order</a></p>

    <header class="head">
      <div>
        <h1>How this reads</h1>
        <p class="lede">
          Two readers, one contract. Whichever reads a message has to say which
          words it read each value from — that is what makes a value checkable,
          and it is the whole argument of this project. What changes between
          them is what they can read, what they cost, and whether they answer
          the same way twice.
        </p>
      </div>
    </header>

    @if (problem(); as message) {
      <div class="card problem"><p>{{ message }}</p></div>
    }

    <div class="readers">
      <section class="card reader" [class.on]="!isModel()">
        <header>
          <h2>The rules</h2>
          @if (!isModel()) {
            <span class="badge on">reading now</span>
          }
        </header>

        <p>
          Named patterns, in <code>extract/rules.ts</code>. They read the layouts
          somebody wrote a rule for and decline the rest, out loud, instead of
          guessing at it.
        </p>

        <ul class="traits">
          <li>No key, no account, no network</li>
          <li>The same answer every time</li>
          <li>Every value names the function that read it</li>
          <li>Gives up on wording nobody anticipated</li>
        </ul>

        <button type="button" (click)="useRules()" [disabled]="busy() || !isModel()">
          {{ !isModel() ? 'Already reading' : 'Read with the rules' }}
        </button>
      </section>

      <section class="card reader" [class.on]="isModel()">
        <header>
          <h2>A language model</h2>
          @if (isModel()) {
            <span class="badge on">reading now</span>
          }
        </header>

        <p>
          What the original of this system used, and the reason it worked: it
          reads the messages nobody wrote a rule for, which is most of the mail
          that actually arrives.
        </p>

        <p>
          It is held to the same contract. It is asked for the
          <strong>words</strong> it read each value from and never for character
          offsets — ask a model for an offset and it will give you a plausible
          integer — and every quote it returns is looked for in the message.
          Found, the value keeps the message's own characters. Not found, the
          value is <strong>dropped</strong>, and the reading says which words
          were not there.
        </p>

        <form (submit)="useModel($event, key.value, model.value)">
          <label>
            <span>Anthropic API key</span>
            <input
              #key
              type="password"
              name="key"
              autocomplete="off"
              spellcheck="false"
              placeholder="sk-ant-…"
              [disabled]="busy()"
            />
          </label>

          <label>
            <span>Model <em>(optional)</em></span>
            <input
              #model
              type="text"
              name="model"
              autocomplete="off"
              spellcheck="false"
              placeholder="claude-sonnet-5"
              [disabled]="busy()"
            />
          </label>

          <button type="submit" [disabled]="busy()">
            {{ busy() ? 'Reading the mailbox…' : 'Read with the model' }}
          </button>
        </form>

        <p class="fine">
          The key goes to the server on this machine and no further. It is not
          stored in this browser and not written to disk: it is held for the life
          of the process, and switching back to the rules forgets it. Reading
          these eleven messages costs a few pennies.
        </p>
      </section>
    </div>

    @if (last(); as now) {
      <div class="card outcome">
        <h2>Read again by {{ now.readBy }}</h2>
        <dl>
          <div><dt>Messages</dt><dd>{{ now.messages }}</dd></div>
          <div><dt>Orders</dt><dd>{{ now.orders }}</dd></div>
          <div><dt>Left for a person</dt><dd>{{ now.forAPerson }}</dd></div>
          <div><dt>Doubts recorded</dt><dd>{{ now.doubts }}</dd></div>
        </dl>
        <p>
          The same eleven messages, read again. Open
          <a routerLink="/orders">the orders</a> and every value now names this
          reader where it named the other one; anything it could not point at is
          under the doubts on the message it came from.
        </p>
      </div>
    }
  `,
  styleUrl: './reading.component.css',
})
export class ReadingComponent {
  private readonly api = inject(ApiService);

  readonly isModel = signal(false);
  readonly busy = signal(false);
  readonly problem = signal<string | null>(null);
  readonly last = signal<ReaderNow | null>(null);

  constructor() {
    this.api.health().subscribe({
      next: (health) => this.isModel.set(!health.couldBeAModel),
      error: () => this.problem.set('The server did not answer. Is it running?'),
    });
  }

  useRules(): void {
    this.switchTo({ reader: 'rules' });
  }

  useModel(event: Event, key: string, model: string): void {
    // The DOM event, not ngSubmit: this component does not import FormsModule,
    // and (ngSubmit) without it binds an event that is never fired -- a button
    // that looks like it works and does nothing.
    event.preventDefault();

    this.switchTo({
      reader: 'model',
      ...(key.trim() ? { key: key.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    });
  }

  private switchTo(asked: { reader: 'rules' | 'model'; key?: string; model?: string }): void {
    this.busy.set(true);
    this.problem.set(null);

    this.api.useReader(asked).subscribe({
      next: (now) => {
        this.isModel.set(!now.couldBeAModel);
        this.last.set(now);
        this.busy.set(false);
      },
      error: (failure: { error?: { error?: string; detail?: string } }) => {
        this.busy.set(false);
        this.problem.set(
          failure.error?.detail ?? failure.error?.error ?? 'That did not work, and the server did not say why.'
        );
      },
    });
  }
}
