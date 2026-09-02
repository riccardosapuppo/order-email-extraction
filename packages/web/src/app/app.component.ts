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
      </div>
    </header>

    <main>
      <router-outlet />
    </main>

    <footer>
      <span>
        A demonstration. Every message in the folder is invented, and so is every
        company in it.
      </span>
      <span>Developed by Riccardo Sapuppo</span>
    </footer>
  `,
  styleUrl: './app.component.css',
})
export class AppComponent {
  private readonly api = inject(ApiService);

  readonly folder = signal<string | null>(null);
  readonly waiting = signal(0);

  constructor() {
    this.api.health().subscribe({
      next: (health) => {
        // The tail of the path. The whole of it is somebody's directory
        // structure and is nobody's business on a screenshot.
        const parts = health.folder.split(/[\\/]/).filter(Boolean);
        this.folder.set(parts.slice(-2).join('/'));
        this.waiting.set(health.forAPerson);
      },
      error: () => this.folder.set('no server'),
    });
  }
}
