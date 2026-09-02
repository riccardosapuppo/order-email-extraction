import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, withInMemoryScrolling } from '@angular/router';

import { AppComponent } from './app/app.component';
import { ROUTES } from './app/routes';

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(),
    provideRouter(
      ROUTES,
      // Going from an order to the email it was read from and back again is the
      // whole loop this interface is for, and landing halfway down the previous
      // page each time makes it feel broken.
      withInMemoryScrolling({ scrollPositionRestoration: 'top', anchorScrolling: 'enabled' })
    ),
  ],
}).catch((error) => console.error(error));
