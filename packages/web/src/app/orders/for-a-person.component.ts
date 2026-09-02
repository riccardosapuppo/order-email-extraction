import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ApiService, Unlinked, whoIs } from '../shell/api.service';
import { KIND_WORDS } from '../shell/confidence';
import { shortWhen } from '../shell/dates';

/**
 * The messages the system would not attach to anything, and what it made of them.
 *
 * This screen is the argument. A model asked which order an email belongs to
 * will name one — plausibly, and sometimes wrongly, and always without saying
 * it was unsure. These rules can decline, and declining is the behaviour rather
 * than a gap in it, so the refusals are given a screen of their own instead of
 * being logged somewhere nobody looks.
 *
 * The most useful row here is the shipment for an order nobody placed. It is
 * exactly the message a system that guesses would file against the nearest
 * order and quietly corrupt.
 */
@Component({
  selector: 'app-for-a-person',
  standalone: true,
  imports: [RouterLink],
  template: `
    <p class="back"><a routerLink="/orders">← every order</a></p>

    <header class="head">
      <div>
        <h1>For a person</h1>
        <p class="lede">
          What the rules read but would not attach to an order. Nothing here was
          thrown away and nothing was guessed at: each one says what it was
          understood to be and why it stopped there.
        </p>
      </div>
    </header>

    @if (loading()) {
      <p class="muted">Reading…</p>
    } @else if (messages().length === 0) {
      <div class="card"><p class="muted">Every message in the folder found an order.</p></div>
    } @else {
      <div class="card table">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>From</th>
              <th>Subject</th>
              <th>Read as</th>
              <th>Left alone because</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (message of messages(); track message.file) {
              <tr>
                <td>{{ shortWhen(message.receivedAt) }}</td>
                <td class="who">{{ who(message.from) }}</td>
                <td>{{ message.subject || '(no subject)' }}</td>
                <td>{{ kind(message.kind) }}</td>
                <td class="why">{{ message.why }}</td>
                <td class="num">
                  <a routerLink="/message" [queryParams]="{ of: message.file }">show me</a>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
  styleUrl: './order.component.css',
})
export class ForAPersonComponent {
  private readonly api = inject(ApiService);

  readonly messages = signal<Unlinked[]>([]);
  readonly loading = signal(true);

  readonly shortWhen = shortWhen;
  readonly who = whoIs;

  constructor() {
    this.api.forAPerson().subscribe({
      next: (answer) => {
        this.messages.set(answer.messages);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  kind(what: string): string {
    return KIND_WORDS[what] ?? what;
  }
}
