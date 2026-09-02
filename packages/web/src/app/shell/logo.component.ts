import { Component, input } from '@angular/core';

/**
 * The mark: a piece of text, selected.
 *
 * Everything this project does comes down to one gesture — pointing at the
 * exact characters a value was read from — so the mark is that gesture and
 * nothing else. A highlighted run with a handle at each end, the way a
 * selection looks in every text field anybody has ever used, set diagonally so
 * the shape is asymmetrical and survives being 16 pixels wide.
 *
 * Deliberately not an envelope. The subject here is not email; email is where
 * the evidence happens to live. And deliberately not a stack of lines with one
 * of them coloured: at favicon size that reads as a screenshot of a screen
 * rather than as a mark — a lesson learned the expensive way on another
 * project in this portfolio.
 *
 * Drawn rather than exported, and the same drawing is the favicon, so the two
 * cannot drift. `npm run check:mark` compares the geometry of both files.
 */
@Component({
  selector: 'app-logo',
  standalone: true,
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 32 32"
      role="img"
      [attr.aria-label]="label()"
      fill="none"
    >
      <rect width="32" height="32" rx="7" [attr.fill]="ground()" />
      <!-- The run of text that was read. -->
      <rect x="7" y="13.5" width="18" height="5" rx="2.5" [attr.fill]="mark()" />
      <!-- The handles, diagonal: where the selection starts and where it ends. -->
      <circle cx="7" cy="9.5" r="2.4" [attr.fill]="mark()" />
      <circle cx="25" cy="22.5" r="2.4" [attr.fill]="mark()" />
    </svg>
  `,
  styles: [':host { display: inline-flex; line-height: 0; }'],
})
export class LogoComponent {
  readonly size = input(28);
  readonly label = input('Orders from email');

  /** Overridable so the mark can sit on a light or a dark ground. */
  readonly ground = input('var(--logo-ground)');
  readonly mark = input('var(--logo-mark)');
}
