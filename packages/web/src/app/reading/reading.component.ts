import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ReaderSwitchComponent } from './reader-switch.component';

/**
 * The screen where you choose who reads the mail, at length.
 *
 * The control itself is on the orders screen too, folded up, because that is the
 * screen somebody actually lands on. This page is for the argument around it:
 * what each reader can do, what it costs, and why they are held to the same
 * contract. Both use the same component, so the form here and the strip there
 * cannot drift apart.
 */
@Component({
  selector: 'app-reading',
  standalone: true,
  imports: [RouterLink, ReaderSwitchComponent],
  template: `
    <p class="back"><a routerLink="/orders">← every order</a></p>

    <header class="head">
      <div>
        <h1>How this reads</h1>
        <p class="lede">
          Two readers, one contract. Whichever reads a message has to say which
          words it read each value from — that is what makes a value checkable,
          and it is the whole argument of this project. What changes between
          them is what they can read, what they cost, and whether they answer
          the same way twice.
        </p>
      </div>
    </header>

    <div class="card switch">
      <app-reader-switch />
    </div>

    <div class="readers">
      <section class="card reader">
        <h2>The rules</h2>

        <p>
          Named patterns, in <code>extract/rules.ts</code>. They read the layouts
          somebody wrote a rule for and decline the rest, out loud, instead of
          guessing at it.
        </p>

        <ul class="traits">
          <li>No key, no account, no network</li>
          <li>The same answer every time</li>
          <li>Every value names the function that read it</li>
          <li>Gives up on wording nobody anticipated</li>
        </ul>

        <p class="fine">
          They are the default, and the only reader the checks use: a check whose
          answer can change on its own is not a check.
        </p>
      </section>

      <section class="card reader">
        <h2>A language model</h2>

        <p>
          What the original of this system used, and the reason it worked: it
          reads the messages nobody wrote a rule for, which is most of the mail
          that actually arrives.
        </p>

        <p>
          It is held to the same contract. It is asked for the
          <strong>words</strong> it read each value from and never for character
          offsets — ask a model for an offset and it will give you a plausible
          integer — and every quote it returns is looked for in the message.
          Found, the value keeps the characters the message really has. Not
          found, the value is <strong>dropped</strong>, and the reading says
          which words were not there.
        </p>

        <p class="fine">
          Anthropic, Mistral or OpenAI: the same checking either way, which is
          rather the point. Nothing here is specific to one of them.
        </p>
      </section>
    </div>
  `,
  styleUrl: './reading.component.css',
})
export class ReadingComponent {}
