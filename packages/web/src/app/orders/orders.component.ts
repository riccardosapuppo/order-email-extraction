import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ApiService, OrderSummary } from '../shell/api.service';
import { STAGE_WORDS, asPercent, bandOf, saidPlainly } from '../shell/confidence';
import { day as asDay, shortWhen } from '../shell/dates';

/**
 * Every order the mailbox revealed.
 *
 * The original this comes from was a table of orders with a status column, and
 * the shape is kept because it is the right one: somebody looking after
 * purchasing wants one row per order and wants to sort it by what is late.
 *
 * Two columns are new, and they are the reason this project exists.
 *
 * **Read from** is the last column and not the first, but it is the one that
 * makes the rest checkable: every order here was assembled out of emails, and
 * the number is a way into them. A system that shows a quantity without a way
 * back to the sentence it came from is asking to be trusted.
 *
 * **Two questions about certainty, not one.** *Right order?* is how sure the
 * system is that these emails belong together. *Right values?* is the weakest
 * field it read out of them. They were one column for a while and it hid the
 * thing it was there to show — an order with no reference of its own read as
 * 100% certain, because nothing had been joined onto it wrongly, having never
 * been joined at all. Each is the WEAKEST link and not the average, which
 * would let one certain value cover three guesses.
 *
 * Orders needing a person come first, whatever their date. A list sorted by
 * time buries the one thing this screen is for.
 */
@Component({
  selector: 'app-orders',
  standalone: true,
  imports: [RouterLink],
  template: `
    <header class="head">
      <div>
        <h1>Orders</h1>
        <p class="lede">
          Rebuilt from {{ counted() }} in a folder of email. Nothing here was typed
          by anybody: every value was read out of a message, and every one of them
          can be pointed back at the words it came from.
        </p>
      </div>

      <button type="button" class="quiet" (click)="reload()" [disabled]="loading()">
        {{ loading() ? 'Reading…' : 'Read the folder again' }}
      </button>
    </header>

    @if (problem(); as message) {
      <div class="card problem"><p>{{ message }}</p></div>
    }

    @if (needAPerson().length > 0) {
      <p class="banner">
        <strong>{{ needAPerson().length }}</strong>
        {{ needAPerson().length === 1 ? 'order is' : 'orders are' }} worth a look —
        either the emails were put together on grounds that can be wrong, or a value
        was. They are first, and marked.
      </p>
    }

    @if (loading()) {
      <p class="muted">Reading the folder…</p>
    } @else if (orders().length === 0) {
      <div class="card"><p class="muted">No orders in that folder.</p></div>
    } @else {
      <div class="card table">
        <table>
          <thead>
            <tr>
              <th>Reference</th>
              <th>Supplier</th>
              <th>Items</th>
              <th>Stage</th>
              <th>Expected</th>
              <th>Carrier</th>
              <th>Tracking</th>
              <th>Read from</th>
              <th>Right order?</th>
              <th>Right values?</th>
            </tr>
          </thead>
          <tbody>
            @for (order of sorted(); track order.key) {
              <tr [class.doubtful]="needsSomebody(order)">
                <td>
                  <a [routerLink]="['/orders', order.key]" [attr.data-order]="order.key">
                    {{ order.reference ?? 'no reference' }}
                  </a>
                  @if (!order.reference) {
                    <small class="warn">no reference was ever seen</small>
                  } @else if (order.supplierReference) {
                    <small>they call it {{ order.supplierReference }}</small>
                  }
                </td>

                <td class="who">
                  @for (domain of order.correspondents; track domain) {
                    <span>{{ domain }}</span>
                  }
                </td>

                <td class="items">
                  @if (order.items.length === 0) {
                    <span class="muted">none read</span>
                  } @else {
                    @for (item of order.items; track item.name + item.quantity) {
                      <span class="item">
                        <strong>{{ item.quantity }}</strong>
                        {{ item.unit ? item.unit + ' of' : '×' }} {{ item.name }}
                      </span>
                    }
                  }
                </td>

                <td><span class="stage" [attr.data-stage]="order.stage">{{ stage(order) }}</span></td>
                <td>{{ order.eta ? day(order.eta) : '—' }}</td>
                <td>{{ order.carrier ?? '—' }}</td>
                <td class="tracking">{{ order.tracking ?? '—' }}</td>

                <td class="num">
                  <a [routerLink]="['/orders', order.key]">
                    {{ order.messages }} {{ order.messages === 1 ? 'email' : 'emails' }}
                  </a>
                  <small>{{ shortWhen(order.lastSeen) }}</small>
                </td>

                <td>
                  <span class="sure" [attr.data-band]="bandOf(order.joined)">
                    {{ percent(order.joined) }}
                  </span>
                  <small>{{ whyJoined(order) }}</small>
                </td>

                <td>
                  <span class="sure" [attr.data-band]="bandOf(order.read)">
                    {{ percent(order.read) }}
                  </span>
                  <small>{{ words(order.read) }}</small>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <p class="after muted">
        Read at {{ readAt() ? shortWhen(readAt()!) : '—' }}.
        <a routerLink="/for-a-person">
          {{ unlinked() }} {{ unlinked() === 1 ? 'message was' : 'messages were' }} left for
          a person</a>
        rather than attached to a guess. Declining is the behaviour here, not a gap in it.
      </p>
    }
  `,
  styleUrl: './orders.component.css',
})
export class OrdersComponent {
  private readonly api = inject(ApiService);

  readonly orders = signal<OrderSummary[]>([]);
  readonly readAt = signal<string | null>(null);
  readonly unlinked = signal(0);
  readonly counted = signal('a mailbox');
  readonly loading = signal(true);
  readonly problem = signal<string | null>(null);

  readonly bandOf = bandOf;
  readonly shortWhen = shortWhen;

  /** Either question being weak is a reason to look; they are not the same reason. */
  readonly needAPerson = computed(() =>
    this.orders().filter(
      (order) => bandOf(order.joined) === 'doubtful' || bandOf(order.read) === 'doubtful'
    )
  );

  /**
   * Doubtful first, then most recently touched.
   *
   * Sorting by date alone is what every one of these tables does, and it puts
   * the order that needs somebody wherever its last email happened to land.
   */
  readonly sorted = computed(() =>
    [...this.orders()].sort((a, b) => {
      const doubt = Number(this.needsSomebody(a));
      const other = Number(this.needsSomebody(b));
      if (doubt !== other) return other - doubt;
      return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    })
  );

  constructor() {
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.problem.set(null);

    this.api.orders().subscribe({
      next: (answer) => {
        this.orders.set(answer.orders);
        this.readAt.set(answer.readAt);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.problem.set('The mailbox could not be read. Is the server running?');
      },
    });

    this.api.health().subscribe({
      next: (health) => {
        this.unlinked.set(health.forAPerson);
        this.counted.set(`${health.messages} messages`);
      },
      error: () => {
        /* The orders are the screen; the count in the sentence is not worth an error. */
      },
    });
  }

  reload(): void {
    this.loading.set(true);
    this.api.reload().subscribe({
      next: () => this.load(),
      error: () => {
        this.loading.set(false);
        this.problem.set('The folder could not be read again.');
      },
    });
  }

  stage(order: OrderSummary): string {
    return STAGE_WORDS[order.stage] ?? order.stage;
  }

  needsSomebody(order: OrderSummary): boolean {
    return bandOf(order.joined) === 'doubtful' || bandOf(order.read) === 'doubtful';
  }

  /**
   * In three words: what held these emails together.
   *
   * An order built from a single email had nothing joined onto it at all, and
   * saying "by sender and thread" of that one was simply untrue — the join
   * question does not arise. Which is also why its score is 100: not because
   * the joining was excellent, but because there was none to get wrong.
   */
  whyJoined(order: OrderSummary): string {
    if (order.messages === 1) return 'nothing joined to it';
    return order.reference ? 'by its reference' : 'by sender and thread';
  }

  words(confidence: number): string {
    return saidPlainly(confidence);
  }

  percent(confidence: number): string {
    return asPercent(confidence);
  }

  readonly day = asDay;
}
