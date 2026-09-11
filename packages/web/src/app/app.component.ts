import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { ApiService } from './shell/api.service';
import { LogoComponent } from './shell/logo.component';

/**
 * The shell.
 *
 * The folder being read is in the header rather than on a settings page,
 * because it is the answer to the only question somebody has when a number
 * looks wrong: which mailbox is this. Everything on every screen is derived
 * from that folder on the machine this is running on — there is no database
 * and nothing is stored, so the folder IS the system's memory.
 *
 * Beside it, for the same reason, is who read it. There are two readers here
 * and which one is running was for a while visible only in the README and in
 * the flag that chooses it — so somebody who opened this and looked at it could
 * not tell that a model was an option at all. The values name their reader, but
 * only after a model has actually read one, which makes the option invisible to
 * exactly the person who has not found it yet. It opens rather than links,
 * because the answer is a command to run and not a page to go to.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LogoComponent],
  template: `
    <header class="top">
      <div class="bar">
        <a class="brand" routerLink="/orders">
          <app-logo [size]="30" />
          <span class="wordmark">
            <strong>Orders from email</strong>
            <span>{{ folder() ?? 'reading…' }}</span>
          </span>
        </a>

        <nav>
          <a routerLink="/orders" routerLinkActive="here">Orders</a>
          <a routerLink="/for-a-person" routerLinkActive="here">
            For a person
            @if (waiting() > 0) {
              <em>{{ waiting() }}</em>
            }
          </a>
        </nav>

        <details class="reader">
          <!--
            The face of it says the thing, so that knowing costs no click. A
            chip reading only "read by the rules" is a fact about the page;
            what somebody needs to see is that there is another way to read it,
            and clicking is then for how rather than for whether.
          -->
          <summary [attr.aria-label]="'Read by ' + readerName() + '. How the other reader works.'">
            read by <strong>{{ readerName() }}</strong>
            @if (couldBeAModel()) {
              <span class="or">&mdash; a model can too</span>
            }
          </summary>

          <div class="panel">
            @if (couldBeAModel()) {
              <p>
                The rules are named patterns. They give up on messages phrased in
                ways nobody wrote a rule for, and say so rather than guessing.
              </p>
              <p>
                <strong>A language model can read these instead</strong>, which is
                what the original of this system did. Every value it produces is
                held to the same contract as a rule: it has to say which words it
                read the value from, those words are looked for in the message,
                and a value whose words are not there is dropped rather than
                shown.
              </p>
              <p><code>ANTHROPIC_API_KEY=… npm start -- --reader model</code></p>
              <p class="aside">
                Asked for, never detected: without that flag nothing here talks
                to anybody.
              </p>
            } @else {
              <p>
                Read by <strong>{{ readBy() }}</strong>. Every value was looked
                for in the message it claims to come from; anything that could
                not be found there was dropped, and says so under the doubts on
                that message.
              </p>
              <p><code>npm start</code> on its own goes back to the rules.</p>
            }
          </div>
        </details>
      </div>
    </header>

    <main>
      <router-outlet />
    </main>

    <footer>
      <span>
        A demonstration. It reconstructs a production system I designed and
        developed; the original cannot be published, so this one was written
        from scratch. Every message in the folder is invented, and so is every
        company in it.
      </span>
      <span>
        Developed by
        <a
          href="https://github.com/riccardosapuppo"
          target="_blank"
          rel="noopener noreferrer"
          >Riccardo Sapuppo</a
        >
      </span>
    </footer>
  `,
  styleUrl: './app.component.css',
})
export class AppComponent {
  private readonly api = inject(ApiService);

  readonly folder = signal<string | null>(null);
  readonly waiting = signal(0);
  readonly readerName = signal('the rules');
  readonly readBy = signal('the rules in extract/rules.ts');
  readonly couldBeAModel = signal(true);

  constructor() {
    this.api.health().subscribe({
      next: (health) => {
        // The tail of the path. The whole of it is somebody's directory
        // structure and is nobody's business on a screenshot.
        const parts = health.folder.split(/[\\/]/).filter(Boolean);
        this.folder.set(parts.slice(-2).join('/'));
        this.waiting.set(health.forAPerson);
        this.readerName.set(health.readerName === 'rules' ? 'the rules' : health.readerName);
        this.readBy.set(health.readBy);
        this.couldBeAModel.set(health.couldBeAModel);
      },
      error: () => this.folder.set('no server'),
    });
  }
}
