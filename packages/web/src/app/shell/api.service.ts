import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * Every call the interface makes, in one place, with the shapes written down.
 *
 * They are written down rather than imported from `@order-email/core` on
 * purpose. What crosses HTTP is not the same as what the reader holds: dates
 * arrive as strings, a `Field<T>` has been flattened into a value beside its
 * provenance, and a `Map` does not survive JSON at all. Importing the internal
 * types here would describe something the browser never receives, and the
 * compiler would agree with the lie.
 */

/** Where the order has got to. The server derives it; nothing stores it. */
export type Stage = 'ordered' | 'confirmed' | 'partly_confirmed' | 'refused' | 'shipped';

export interface OrderItem {
  name: string;
  quantity: number;
  unit: string | null;
  confidence: number;
}

/** The one value most worth checking, and where to check it. */
export interface Weakest {
  path: string;
  value: string | number | boolean | null;
  confidence: number;
  file: string;
  rule: string;
}

export interface OrderSummary {
  key: string;
  reference: string | null;
  stage: Stage;
  correspondents: string[];
  firstSeen: string;
  lastSeen: string;
  messages: number;
  items: OrderItem[];
  eta: string | null;
  supplierReference: string | null;
  carrier: string | null;
  tracking: string | null;
  /**
   * Two numbers, because there are two questions and this project is against
   * collapsing them. `joined` is "is this the right order"; `read` is "are
   * these the right values". They are repaired differently, so a person needs
   * to know which one is low.
   */
  joined: number;
  read: number;

  weakest: Weakest | null;
}

/** A person on a message. The display name is not an identity, so it is shown
 *  beside the address and never instead of it. */
export interface Address {
  email: string;
  name?: string;
}

/** A message attached to an order, and the grounds it was attached on. */
export interface LinkedMessage {
  file: string;
  kind: string;
  why: string;
  confidence: number;
  from: Address | null;
  subject: string;
  receivedAt: string | null;
  doubts: string[];
}

/**
 * One value, and the exact characters it was read from.
 *
 * `from` and `to` are offsets into the subject or the body — not the text to
 * search for. Searching would find the second "4471" as happily as the first,
 * and the whole claim this project makes is that it can point at the one it
 * actually read.
 */
export interface FoundField {
  path: string;
  value: string | number | boolean | null;
  confidence: number;
  where: 'subject' | 'body';
  from: number;
  to: number;
  text: string;
  rule: string;
}

export interface MessageDetail {
  file: string;
  from: Address | null;
  to: Address[];
  subject: string;
  receivedAt: string | null;
  body: string;
  attachments: Array<{ filename: string; contentType: string; bytes: number }>;
  kind: string;
  confidence: number;
  because: string[];
  doubts: string[];
  fields: FoundField[];
}

export interface Unlinked {
  file: string;
  subject: string;
  from: Address | null;
  receivedAt: string | null;
  kind: string;
  why: string;
}

export interface Health {
  status: string;
  folder: string;
  readAt: string;
  messages: number;
  orders: number;
  forAPerson: number;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  health(): Observable<Health> {
    return this.http.get<Health>('/api/health');
  }

  orders(): Observable<{ readAt: string; orders: OrderSummary[] }> {
    return this.http.get<{ readAt: string; orders: OrderSummary[] }>('/api/orders');
  }

  order(key: string): Observable<{ order: OrderSummary; messages: LinkedMessage[] }> {
    return this.http.get<{ order: OrderSummary; messages: LinkedMessage[] }>(
      `/api/orders/${encodeURIComponent(key)}`
    );
  }

  message(file: string): Observable<MessageDetail> {
    return this.http.get<MessageDetail>(`/api/messages/${encodeURIComponent(file)}`);
  }

  forAPerson(): Observable<{ messages: Unlinked[] }> {
    return this.http.get<{ messages: Unlinked[] }>('/api/for-a-person');
  }

  reload(): Observable<{ readAt: string; messages: number; orders: number }> {
    return this.http.post<{ readAt: string; messages: number; orders: number }>('/api/reload', {});
  }
}

/**
 * A person, said the way an email client says it.
 *
 * The name goes first and the address stays visible, because a display name is
 * whatever the sender typed. "Accounts Payable" in the From line of a message
 * from a domain nobody recognises is exactly the case a person is reading this
 * screen to catch, and hiding the address behind the name would hide it.
 */
export function whoIs(address: Address | null): string {
  if (!address) return 'nobody';
  return address.name ? `${address.name} <${address.email}>` : address.email;
}
