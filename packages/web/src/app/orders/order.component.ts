import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { ApiService, LinkedMessage, OrderSummary, whoIs } from '../shell/api.service';
import { KIND_WORDS, STAGE_WORDS, asPercent, bandOf, saidPlainly } from '../shell/confidence';
import { asShown, day as asDay, shortWhen } from '../shell/dates';

/**
 * One order: what was ordered, what came back, and which emails said so.
 *
 * The first two sections are the original's, in its order, because it is the
 * order the questions are asked in: what did we ask for, and what did they
 * answer.
 *
 * The third is not in the original at all, and neither is the table under them.
 * **Where to look first** names the least certain value in the whole order and
 * links straight to the words it was read from — the one thing somebody wants
 * from this screen is where to start checking. It replaced a card headed
 * "Doubts" that listed the grounds each email was joined on: "the same
 * reference, 4471" is a reason to be confident, printed under a heading saying
 * the opposite, and it repeated a column of the table below.
 *
 * The table lists every message **with the grounds it was attached on**,
 * because "the same reference, 4471" and "the only open order with this
 * supplier in the last 90 days" are very different reasons to believe a
 * shipment belongs here. A system that joins records without saying why has
 * made a decision nobody can check — and the second of those two joins is the
 * one that turned a customer's second order into extra lines on their first,
 * before the rule was tightened.
 */
@Component({
  selector: 'app-order',
  standalone: true,
  imports: [RouterLink],
  template: `
    @if (loading()) {
      <p class="muted">Reading the order…</p>
    }
    <!-- Two primary blocks rather than one chain: the alias binds only on the
         first block, and a failed read leaves the order null, so these two can
         never both be showing. -->
    @if (problem(); as trouble) {
      <div class="card problem"><p>{{ trouble }}</p></div>
    }

    @if (order(); as one) {
      <p class="back"><a routerLink="/orders">← every order</a></p>

      <header class="head">
        <div>
          <h1>{{ one.reference ?? 'An order with no reference' }}</h1>
          <p class="lede">
            <span class="stage" [attr.data-stage]="one.stage">{{ stage(one) }}</span>
            with {{ one.correspondents.join(', ') }}, assembled from
            {{ one.messages }} {{ one.messages === 1 ? 'email' : 'emails' }} between
            {{ shortWhen(one.firstSeen) }} and {{ shortWhen(one.lastSeen) }}.
          </p>
        </div>

        <p class="sure big" [attr.data-band]="bandOf(one.read)">
          {{ words(one.read) }}
          <small>
            {{ percent(one.read) }} on its weakest value ·
            {{ percent(one.joined) }} that these emails belong together
          </small>
        </p>
      </header>

      @if (!one.reference) {
        <p class="banner">
          No purchase-order reference was ever seen for this one. It was held together
          by the thread and the people on it, which is weaker — and it is why this
          order is marked rather than quietly listed with the rest.
        </p>
      }

      <div class="three">
        <!-- 1 -->
        <section class="card">
          <h2>Items</h2>
          @if (one.items.length === 0) {
            <p class="muted">No lines were read from any message about this order.</p>
          } @else {
            <table class="lines">
              <tbody>
                @for (item of one.items; track item.name + item.quantity) {
                  <tr [class.doubtful]="bandOf(item.confidence) === 'doubtful'">
                    <td class="qty">{{ item.quantity }}</td>
                    <td class="unit">{{ item.unit ?? '' }}</td>
                    <td>{{ item.name }}</td>
                    <td class="num">
                      <span class="sure" [attr.data-band]="bandOf(item.confidence)">
                        {{ percent(item.confidence) }}
                      </span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>

        <!-- 2 -->
        <section class="card">
          <h2>Their answer</h2>
          <dl>
            <dt>Their reference</dt>
            <dd>{{ one.supplierReference ?? 'never given' }}</dd>
            <dt>Expected</dt>
            <dd>{{ one.eta ? day(one.eta) : 'no date promised' }}</dd>
            <dt>Carrier</dt>
            <dd>{{ one.carrier ?? '—' }}</dd>
            <dt>Tracking</dt>
            <dd class="tracking">{{ one.tracking ?? '—' }}</dd>
          </dl>
        </section>

        <!-- 3 -->
        <section class="card">
          <h2>Where to look first</h2>
          @if (one.weakest; as weak) {
            <p class="weakest">
              <span class="what">{{ readable(weak.path) }}</span>
              <strong>{{ shown(weak.value) }}</strong>
            </p>
            <p class="muted small">
              The least certain value in this order, read by
              <code>{{ weak.rule }}</code> at
              <span class="sure" [attr.data-band]="bandOf(weak.confidence)">
                {{ percent(weak.confidence) }}</span>.
            </p>
            <p>
              <a
                routerLink="/message"
                [queryParams]="{ of: weak.file }"
                [attr.data-weakest]="weak.path"
                >Show me the words it came from →</a
              >
            </p>
          } @else {
            <p class="muted">Nothing was read out of these messages at all.</p>
          }
        </section>
      </div>

      <h2 class="wide">The emails it was read from, and why each one was attached</h2>

      <div class="card table">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>From</th>
              <th>Subject</th>
              <th>Read as</th>
              <th>Attached because</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (message of messages(); track message.file) {
              <tr [class.doubtful]="bandOf(message.confidence) === 'doubtful'">
                <td>{{ shortWhen(message.receivedAt) }}</td>
                <td class="who">{{ who(message.from) }}</td>
                <td>{{ message.subject || '(no subject)' }}</td>
                <td>{{ kind(message.kind) }}</td>
                <td class="why">{{ message.why }}</td>
                <td class="num">
                  <a routerLink="/message" [queryParams]="{ of: message.file }" [attr.data-open]="message.file">
                    show me where
                  </a>
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
export class OrderComponent {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  readonly order = signal<OrderSummary | null>(null);
  readonly messages = signal<LinkedMessage[]>([]);
  readonly loading = signal(true);
  readonly problem = signal<string | null>(null);

  readonly bandOf = bandOf;
  readonly shortWhen = shortWhen;
  readonly who = whoIs;
  readonly shown = asShown;

  /**
   * `items[0].quantity` said in words. The path stays exactly what it is in the
   * data, because it is how a field is addressed; this is only how it is read.
   */
  readable(path: string): string {
    const item = path.match(/^items\[(\d+)\]\.(.+)$/);
    if (item) return `${item[2]} of item ${Number(item[1]) + 1}`;
    return path.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  }

  constructor() {
    this.route.paramMap.subscribe((params) => {
      const key = params.get('key');
      if (key) this.load(key);
    });
  }

  private load(key: string): void {
    this.loading.set(true);
    this.problem.set(null);

    this.api.order(key).subscribe({
      next: (answer) => {
        this.order.set(answer.order);
        this.messages.set(answer.messages);
        this.loading.set(false);
      },
      error: (error) => {
        this.loading.set(false);
        this.problem.set(
          error.status === 404 ? 'There is no such order in that folder.' : 'That could not be read.'
        );
      },
    });
  }

  stage(order: OrderSummary): string {
    return STAGE_WORDS[order.stage] ?? order.stage;
  }

  kind(what: string): string {
    return KIND_WORDS[what] ?? what;
  }

  words(confidence: number): string {
    return saidPlainly(confidence);
  }

  percent(confidence: number): string {
    return asPercent(confidence);
  }

  readonly day = asDay;
}
