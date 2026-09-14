import { NgTemplateOutlet } from '@angular/common';
import { Component, EventEmitter, Input, Output, inject, signal } from '@angular/core';

import { ApiService, type ProviderChoice, type ReaderNow } from '../shell/api.service';

/**
 * Choosing who reads, in one place used twice.
 *
 * ── Why it is on the orders screen and not only on its own ───────────────────
 *
 * Because the first screen is the only one somebody is guaranteed to see. The
 * second reader lived behind a flag, then behind a sentence, then behind a chip
 * that explained it, and each time the answer to "where would anybody notice
 * this" was somewhere you had to go. A strip at the top of the list needs no
 * going anywhere: it says the rules are reading, and that a model can, and it
 * has the field.
 *
 * `compact` is the same control folded up. One component rather than two so a
 * fix to the refusal message, or a provider added, cannot reach one screen and
 * miss the other.
 *
 * ── Why more than one provider ───────────────────────────────────────────────
 *
 * The argument is about the contract -- a value has to point at the words it
 * came from -- and that is true of any model. Wiring the demonstration to one
 * vendor invites the reader to think the checking is somehow specific to it. It
 * is not: the same code checks all three. The list comes from the server so that
 * adding one is a single entry in `providers.ts`.
 */
@Component({
  selector: 'app-reader-switch',
  standalone: true,
  imports: [NgTemplateOutlet],
  template: `
    <!--
      One control, rendered in two densities.
      Through a template rather than written twice, so a fix to the refusal
      message or a provider added cannot reach one screen and miss the other.
    -->
    @if (compact) {
      <details class="strip">
        <summary>
          Reading with <strong>{{ readerShort() }}</strong>
          @if (!isModel()) {
            <span class="or">&mdash; read with a model instead</span>
          }
        </summary>
        <div class="inside"><ng-container [ngTemplateOutlet]="control" /></div>
      </details>
    } @else {
      <ng-container [ngTemplateOutlet]="control" />
    }

    <ng-template #control>
    @if (problem(); as message) {
      <p class="problem">{{ message }}</p>
    }

    <div class="choice">
      @if (!compact) {
        <span class="now">
          Reading with <strong>{{ readBy() }}</strong>
        </span>
      }

      @if (isModel()) {
        <button type="button" class="plain" (click)="useRules()" [disabled]="busy()">
          Go back to the rules
        </button>
      }
    </div>

    <form (submit)="useModel($event, key.value, model.value)">
      <fieldset>
        <legend>Read with a model instead</legend>

        <div class="who">
          @for (one of providers(); track one.id) {
            <label class="pick" [class.on]="chosen() === one.id">
              <input
                type="radio"
                name="provider"
                [value]="one.id"
                [checked]="chosen() === one.id"
                (change)="chosen.set(one.id)"
                [disabled]="busy()"
              />
              {{ one.label }}
            </label>
          }
        </div>

        <div class="fields">
          <label>
            <span>{{ keyNameOf(chosen()) }}</span>
            <input
              #key
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder="paste a key"
              [disabled]="busy()"
            />
          </label>

          <label>
            <span>Model <em>(optional)</em></span>
            <input
              #model
              type="text"
              autocomplete="off"
              spellcheck="false"
              [placeholder]="defaultModelOf(chosen())"
              [disabled]="busy()"
            />
          </label>

          <button type="submit" [disabled]="busy()">
            {{ busy() ? 'Reading the mailbox…' : 'Read with the model' }}
          </button>
        </div>

        <p class="fine">
          The key goes to the server on this machine and no further. It is not
          stored in this browser and not written to disk: it is held for the life
          of the process, and going back to the rules forgets it. Reading these
          eleven messages costs a few pennies.
        </p>
      </fieldset>
    </form>

    @if (last(); as now) {
      <dl class="outcome">
        <div><dt>Messages</dt><dd>{{ now.messages }}</dd></div>
        <div><dt>Orders</dt><dd>{{ now.orders }}</dd></div>
        <div><dt>Left for a person</dt><dd>{{ now.forAPerson }}</dd></div>
        <div><dt>Doubts recorded</dt><dd>{{ now.doubts }}</dd></div>
      </dl>
    }
    </ng-template>
  `,
  styleUrl: './reader-switch.component.css',
})
export class ReaderSwitchComponent {
  private readonly api = inject(ApiService);

  /** Folded up, for the strip at the top of a screen that is about something else. */
  @Input() compact = false;

  /** So the screen around it can reload what it is showing. */
  @Output() readonly changed = new EventEmitter<ReaderNow>();

  readonly providers = signal<ProviderChoice[]>([]);
  readonly chosen = signal('');
  readonly readBy = signal('the rules');

  /** The same thing short enough for a strip: a name, not a description. */
  readonly readerShort = signal('the rules');
  readonly isModel = signal(false);
  readonly busy = signal(false);
  readonly problem = signal<string | null>(null);
  readonly last = signal<ReaderNow | null>(null);

  constructor() {
    this.api.health().subscribe({
      next: (health) => {
        this.providers.set(health.providers);
        this.chosen.set(health.providers[0]?.id ?? '');
        this.readBy.set(health.readBy);
        this.readerShort.set(health.readerName === 'rules' ? 'the rules' : health.readerName);
        this.isModel.set(!health.couldBeAModel);
      },
      error: () => this.problem.set('The server did not answer. Is it running?'),
    });
  }

  keyNameOf(id: string): string {
    return this.providers().find((one) => one.id === id)?.keyName ?? 'API key';
  }

  defaultModelOf(id: string): string {
    return this.providers().find((one) => one.id === id)?.defaultModel ?? '';
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
      provider: this.chosen(),
      ...(key.trim() ? { key: key.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    });
  }

  private switchTo(asked: { reader: 'rules' | 'model'; provider?: string; key?: string; model?: string }): void {
    this.busy.set(true);
    this.problem.set(null);

    this.api.useReader(asked).subscribe({
      next: (now) => {
        this.isModel.set(!now.couldBeAModel);
        this.readBy.set(now.readBy);
        this.readerShort.set(now.readerName === 'rules' ? 'the rules' : now.readerName);
        this.last.set(now);
        this.busy.set(false);
        this.changed.emit(now);
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
