import { Routes } from '@angular/router';

/**
 * Four screens, and no guards.
 *
 * There is nothing to guard. This reads a folder on the machine it runs on and
 * has no accounts, no sessions and no write surface beyond "read the folder
 * again" — so a route guard here would be theatre. What keeps it private is
 * that the server binds to localhost and says so.
 */
export const ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'orders' },
  {
    path: 'orders',
    loadComponent: () => import('./orders/orders.component').then((m) => m.OrdersComponent),
  },
  {
    path: 'orders/:key',
    loadComponent: () => import('./orders/order.component').then((m) => m.OrderComponent),
  },
  {
    path: 'message',
    loadComponent: () => import('./message/message.component').then((m) => m.MessageComponent),
  },
  {
    path: 'for-a-person',
    loadComponent: () =>
      import('./orders/for-a-person.component').then((m) => m.ForAPersonComponent),
  },
  { path: '**', redirectTo: 'orders' },
];
