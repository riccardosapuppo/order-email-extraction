import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { segments, type Segment } from '@order-email/core';

import { ApiService, MessageDetail, whoIs } from '../shell/api.service';
import { KIND_WORDS, asPercent, bandOf, saidPlainly } from '../shell/confidence';
import { asShown, longWhen } from '../shell/dates';

/**
 * The email, with every value marked in the words it was read from.
 *
 * This is the screen the project exists for. Everything else here is an orders
 * table, and every system of this kind has one; what none of them has is a way
 * back from a number in a cell to the sentence somebody typed. A quantity that
 * cannot be traced is a quantity you have to take on trust, and the reason to
 * distrust it is exactly the reason it was extracted automatically.
 *
 * The marks are drawn from OFFSETS, not by searching the body for the value
 * again. Searching finds the second "4471" as happily as the first, and a
 * highlight over the wrong occurrence is worse than none: it is a wrong claim
 * that looks like evidence.
 *
 * Picking a field draws its mark hard and everything else back. Picking a mark
 * does the same from the other side, because somebody reading the email is as
 * likely to start from a phrase that looks wrong as from a value in the list.
 *
 * The doubts are shown at the top rather than at the bottom. They are the part
 * a person is here to act on.
 */
@Component({
  selector: 'app-message',
  standalone: true,
  imports: [RouterLink],
  template: `
    @if (loading()) {
      <p class="muted">Reading the message…</p>
    }

    <!-- Two primary blocks rather than one chain: the alias binds on the first block only
         and a template that names the thing it is about reads better than
         one calling detail() a dozen times. They cannot both be showing —
         a failed read leaves the message null. -->
    @if (problem(); as trouble) {
      <div class="card problem"><p>{{ trouble }}</p></div>
    }

    @if (detail(); as email) {
      <p class="back"><a routerLink="/orders">← every order</a></p>

      <header class="head">
        <h1>{{ email.subject || '(no subject)' }}</h1>
        <p class="lede">
          {{ kind(email.kind) }}, from <strong>{{ who(email.from) }}</strong>,
          {{ when(email.receivedAt) }}.
          <span class="sure" [attr.data-band]="bandOf(email.confidence)">
            {{ words(email.confidence) }}
          </span>
        </p>
      </header>

      @if (email.doubts.length > 0) {
        <div class="card doubts">
          <p class="title">What this reading is not sure about</p>
          <ul>
            @for (doubt of email.doubts; track doubt) {
              <li>{{ doubt }}</li>
            }
          </ul>
        </div>
      }

      <div class="split">
        <!-- The message itself. Rendered as segments so a mark can sit over
             exactly the characters a rule consumed. -->
        <div class="card letter">
          <dl class="envelope">
            <dt>From</dt>
            <dd>{{ who(email.from) }}</dd>
            <dt>To</dt>
            <dd>{{ email.to.length ? email.to.map(who).join(', ') : '—' }}</dd>
            <dt>Subject</dt>
            <dd class="marked">
              @for (piece of subjectPieces(); track $index) {
                @if (piece.ids.length === 0) {
                  <span>{{ piece.text }}</span>
                } @else {
                  <mark
                    [class.picked]="isPicked(piece)"
                    [attr.data-marks]="piece.ids.join(' ')"
                    (click)="pick(piece.ids[0]!)"
                    tabindex="0"
                    (keydown.enter)="pick(piece.ids[0]!)"
                  >{{ piece.text }}</mark>
                }
              }
            </dd>
          </dl>

          <pre class="body marked">@for (piece of bodyPieces(); track $index) {@if (piece.ids.length === 0) {<span>{{ piece.text }}</span>} @else {<mark
              [class.picked]="isPicked(piece)"
              [attr.data-marks]="piece.ids.join(' ')"
              (click)="pick(piece.ids[0]!)"
              tabindex="0"
              (keydown.enter)="pick(piece.ids[0]!)"
            >{{ piece.text }}</mark>}}</pre>

          @if (email.attachments.length > 0) {
            <p class="clips">
              @for (clip of email.attachments; track clip.filename) {
                <span>{{ clip.filename }} · {{ size(clip.bytes) }}</span>
              }
            </p>
          }
        </div>

        <!-- What was taken out of it. -->
        <div class="card found">
          <p class="title">{{ email.fields.length }} values read from this message</p>

          @if (email.fields.length === 0) {
            <p class="muted">
              Nothing was read. That is an answer: this message was understood well
              enough to say it carries no order, no confirmation and no shipment.
            </p>
          }

          <ul class="fields">
            @for (field of email.fields; track field.path) {
              <li
                [class.picked]="picked() === field.path"
                [attr.data-field]="field.path"
                (click)="pick(field.path)"
                tabindex="0"
                (keydown.enter)="pick(field.path)"
              >
                <p class="what">{{ readable(field.path) }}</p>
                <p class="value">{{ shown(field.value) }}</p>
                <p class="how">
                  from the {{ field.where }}, characters {{ field.from }}–{{ field.to }},
                  by <code>{{ field.rule }}</code>
                </p>
                <p class="how">
                  <span class="sure" [attr.data-band]="bandOf(field.confidence)">
                    {{ percent(field.confidence) }}
                  </span>
                  <span class="quote">“{{ field.text }}”</span>
                </p>
              </li>
            }
          </ul>

          @if (email.because.length > 0) {
            <p class="title">Why it was read as {{ kind(email.kind).toLowerCase() }}</p>
            <ul class="because">
              @for (reason of email.because; track reason) {
                <li>{{ reason }}</li>
              }
            </ul>
          }
        </div>
      </div>
    }
  `,
  styleUrl: './message.component.css',
})
export class MessageComponent {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  readonly detail = signal<MessageDetail | null>(null);
  readonly loading = signal(true);
  readonly problem = signal<string | null>(null);
  readonly picked = signal<string | null>(null);

  readonly bandOf = bandOf;

  readonly subjectPieces = computed(() => this.cut('subject'));
  readonly bodyPieces = computed(() => this.cut('body'));

  /**
   * The message is named in a query parameter, not in the path.
   *
   * `/messages/01-order.eml` was the obvious route and it is broken: a path
   * ending in an extension looks like a request for a file, so a development
   * server answers "Cannot GET" and a static host answers 404. Following a link
   * inside the application worked, which is what made it invisible — the router
   * never asks the server. Refreshing the page, or opening the link somebody
   * sent you, did not.
   *
   * The same rule that says a request naming a file must 404 rather than return
   * the application says the application must not put a file name where a file
   * name would go. `?of=` also survives any name a mailbox export produces,
   * including one with a slash in it.
   */
  constructor() {
    this.route.queryParamMap.subscribe((params) => {
      const file = params.get('of');
      if (file) this.load(file);
      else {
        this.loading.set(false);
        this.problem.set('No message was named.');
      }
    });
  }

  private cut(where: 'subject' | 'body'): Segment[] {
    const email = this.detail();
    if (!email) return [];

    return segments(
      where === 'subject' ? email.subject : email.body,
      email.fields
        .filter((field) => field.where === where)
        .map((field) => ({ from: field.from, to: field.to, id: field.path }))
    );
  }

  private load(file: string): void {
    this.loading.set(true);
    this.problem.set(null);
    this.picked.set(null);

    this.api.message(file).subscribe({
      next: (email) => {
        this.detail.set(email);
        this.loading.set(false);
      },
      error: (error) => {
        this.loading.set(false);
        this.problem.set(
          error.status === 404 ? 'There is no such message in the folder.' : 'That could not be read.'
        );
      },
    });
  }

  pick(path: string): void {
    this.picked.update((current) => (current === path ? null : path));
  }

  isPicked(piece: Segment): boolean {
    const at = this.picked();
    return at !== null && piece.ids.includes(at);
  }

  /**
   * `items[0].quantity` said in words.
   *
   * The path is how the field is addressed and it has to stay exactly that in
   * the data — it is what ties a mark to a row. It is not what somebody reads.
   */
  readable(path: string): string {
    const item = path.match(/^items\[(\d+)\]\.(.+)$/);
    if (item) return `${item[2]} of item ${Number(item[1]) + 1}`;
    return path.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  }

  kind(what: string): string {
    return KIND_WORDS[what] ?? what;
  }

  readonly who = whoIs;
  readonly shown = asShown;

  words(confidence: number): string {
    return saidPlainly(confidence);
  }

  percent(confidence: number): string {
    return asPercent(confidence);
  }

  when(iso: string | null): string {
    return longWhen(iso);
  }

  size(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
  }
}
