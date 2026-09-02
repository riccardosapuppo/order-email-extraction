import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { fieldsOf } from '../src/facts.js';
import type { Message } from '../src/message.js';
import { read } from '../src/extract/rules.js';

function email(over: Partial<Message> = {}): Message {
  return {
    id: 'test-1',
    from: { email: 'buyer@customer.example', name: 'A Buyer' },
    to: [{ email: 'orders@supplier.example' }],
    subject: 'Order',
    receivedAt: new Date(2026, 2, 12, 9, 30),
    body: '',
    attachments: [],
    ...over,
  };
}

describe('what an email turns out to be', () => {
  it('an order, when somebody asks for things', () => {
    const reading = read(
      email({
        subject: 'PO 4471 - consumables',
        body: 'Please send the following:\n\n12 x blue nitrile gloves, medium\n4 boxes of alcohol wipes\n\nThanks.',
      })
    );

    assert.equal(reading.fact.kind, 'order');
  });

  it('a confirmation, when the supplier answers', () => {
    const reading = read(
      email({
        subject: 'Re: PO 4471',
        body: 'Order confirmation: we can supply all items. Expected delivery 19/03/2026.',
      })
    );

    assert.equal(reading.fact.kind, 'confirmation');
  });

  it('a shipment, when something is on its way', () => {
    const reading = read(
      email({
        subject: 'Your order has been dispatched',
        body: 'PO 4471 has shipped with DHL. Tracking number JD0002234567.',
      })
    );

    assert.equal(reading.fact.kind, 'shipment');
  });

  it('an automatic reply, checked before anything else', () => {
    // "Your order has been received" contains the word order and is not one.
    // Read as an order it books the same goods twice, and nobody finds out
    // until they arrive.
    const reading = read(
      email({
        subject: 'Automatic reply: your order has been received',
        body: 'This is an automated message. Please do not reply.\n\n12 x gloves',
      })
    );

    assert.equal(reading.fact.kind, 'acknowledgement');
  });

  it('nothing at all, when nothing is recognised', () => {
    const reading = read(email({ subject: 'Lunch?', body: 'Are you free on Thursday?' }));

    assert.equal(reading.fact.kind, 'unknown');
    assert.ok(reading.confidence < 0.5);
  });

  it('a reply from a supplier is not a second order', () => {
    // The supplier quotes the request back, so their email contains "please
    // send" too. Without knowing who they are, that is a duplicate order for
    // goods already on their way.
    const reading = read(
      email({
        from: { email: 'sales@supplier.example' },
        subject: 'Re: PO 4471',
        body: 'Please send confirmation of the delivery address. We can supply all items.',
      }),
      { supplierDomains: ['supplier.example'] }
    );

    assert.equal(reading.fact.kind, 'confirmation');
  });
});

describe('what is read out of an order', () => {
  const reading = read(
    email({
      subject: 'PO 4471 - urgent',
      body: [
        'Please send the following to the usual address:',
        '',
        '12 x blue nitrile gloves, medium',
        '4 boxes of alcohol wipes',
        'paper towels, qty 20',
        '',
        'Needed by 19/03/2026.',
      ].join('\n'),
    })
  );

  it('the reference, from the subject line', () => {
    assert.equal(reading.fact.kind, 'order');
    const order = reading.fact as Extract<typeof reading.fact, { kind: 'order' }>;

    assert.equal(order.reference?.value, '4471');
    // From the subject, which is where people put it so the reply threads —
    // and it survives quoting intact, so it is the strongest signal there is.
    assert.equal(order.reference?.provenance.where, 'subject');
    assert.ok((order.reference?.confidence ?? 0) > 0.9);
  });

  it('the lines, both ways round', () => {
    const order = reading.fact as Extract<typeof reading.fact, { kind: 'order' }>;
    const names = order.items.map((item) => item.name.value);

    assert.equal(order.items.length, 3);
    assert.ok(names.some((name) => name.includes('gloves')));
    assert.ok(names.some((name) => name.includes('paper towels')));
  });

  it('the quantities, with the unit when it is written', () => {
    const order = reading.fact as Extract<typeof reading.fact, { kind: 'order' }>;
    const wipes = order.items.find((item) => item.name.value.includes('wipes'));
    const towels = order.items.find((item) => item.name.value.includes('towels'));

    assert.equal(wipes?.quantity.value, 4);
    assert.equal(wipes?.unit?.value, 'boxes');
    assert.equal(towels?.quantity.value, 20);
  });

  it('the urgency', () => {
    const order = reading.fact as Extract<typeof reading.fact, { kind: 'order' }>;
    assert.equal(order.priority?.value, 'high');
  });
});

describe('where every value came from', () => {
  it('each field points at the characters it was read from', () => {
    // Every shape of item line, because the offsets are worked out separately
    // for each of them. The first version of this test used one line with no
    // unit in it, and passed while `items[1].unit` pointed five characters
    // into the product name — found by asking the running server for a message
    // and reading what came back.
    const body = [
      'Please send:',
      '',
      '12 x blue nitrile gloves',
      '4 boxes of alcohol wipes',
      'paper towels, qty 20',
      'and 6 x masks as well',
      '',
      'Needed by 16/03/2026.',
    ].join('\n');
    const reading = read(email({ subject: 'PO 4471', body }));

    for (const { path, field } of fieldsOf(reading.fact)) {
      const source = field.provenance.where === 'subject' ? 'PO 4471' : body;
      const quoted = source.slice(field.provenance.from, field.provenance.to);

      // The span has to still contain what was read. This is the check that
      // makes provenance worth having: a field whose offsets point somewhere
      // else cannot be shown to anybody, and a field nobody can be shown is a
      // field nobody can check.
      assert.equal(quoted, field.provenance.text, `${path} points at the wrong characters`);
    }
  });

  it('and names the rule that read it', () => {
    const reading = read(email({ subject: 'PO 4471', body: 'Please send 3 x masks' }));

    for (const { path, field } of fieldsOf(reading.fact)) {
      assert.ok(field.provenance.rule.length > 0, `${path} has no rule`);
    }
  });
});

describe('the lines it refuses to read as items', () => {
  it('a reference is not a product', () => {
    // "PO 4471 - 12" reads as twelve of something called PO 4471.
    const reading = read(
      email({ subject: 'Order', body: 'Please send:\nPO 4471 - 12\n2 x masks' })
    );
    const order = reading.fact as Extract<typeof reading.fact, { kind: 'order' }>;

    // The only thing that matters is that it is not an item. Asserting a
    // doubt as well was asking for more than is useful: that line matches
    // none of the item patterns at all, so there is nothing to report, and
    // reporting every unrecognised line would bury the real doubts under
    // "Thanks." and "Best regards".
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0]?.name.value, 'masks');
  });

  it('a date is not a product either', () => {
    const reading = read(
      email({ subject: 'Order', body: 'Please send 5 x aprons\nby 19/03/2026' })
    );
    const order = reading.fact as Extract<typeof reading.fact, { kind: 'order' }>;

    assert.deepEqual(
      order.items.map((item) => item.name.value),
      ['aprons']
    );
  });
});

describe('the confidence, and what it is for', () => {
  it('an order with a reference and lines is trusted', () => {
    const reading = read(
      email({ subject: 'PO 4471', body: 'Please send 12 x gloves' })
    );
    assert.ok(reading.confidence >= 0.85);
  });

  it('an order whose lines could not be read is not', () => {
    // Not "moderately confident" because one field is missing: it is an order
    // somebody has to look at, and the number has to say so.
    const reading = read(
      email({ subject: 'PO 4471', body: 'Please send the usual monthly order. Thanks.' })
    );

    assert.ok(reading.confidence < 0.5);
    assert.ok(reading.doubts.some((doubt) => doubt.includes('order lines')));
  });

  it('and an order with no reference is matched by other means', () => {
    const reading = read(email({ subject: 'Supplies', body: 'Please send 12 x gloves' }));

    assert.ok(reading.confidence < 0.85);
    assert.ok(reading.doubts.some((doubt) => doubt.includes('reference')));
  });
});

describe('dates people write for people', () => {
  it('are read as day, month, year', () => {
    const reading = read(
      email({ subject: 'Re: PO 4471', body: 'Order confirmed. Expected delivery 19/03/2026.' })
    );
    const confirmation = reading.fact as Extract<typeof reading.fact, { kind: 'confirmation' }>;

    assert.equal(confirmation.eta?.value.getDate(), 19);
    assert.equal(confirmation.eta?.value.getMonth(), 2);
    assert.equal(confirmation.eta?.value.getFullYear(), 2026);
  });

  it('and a date that does not exist is refused rather than rolled over', () => {
    // 31 April becomes 1 May if you let the Date constructor have it, and an
    // ETA one day out is worse than no ETA at all — nobody checks a date that
    // looks reasonable.
    const reading = read(
      email({ subject: 'Re: PO 4471', body: 'Order confirmed. Expected 31/04/2026.' })
    );
    const confirmation = reading.fact as Extract<typeof reading.fact, { kind: 'confirmation' }>;

    assert.equal(confirmation.eta, undefined);
  });
});

describe('a supplier saying no', () => {
  it('out of stock is a refusal, not a confirmation', () => {
    const reading = read(
      email({ subject: 'Re: PO 4471', body: 'Unable to supply: the gloves are out of stock.' })
    );
    const confirmation = reading.fact as Extract<typeof reading.fact, { kind: 'confirmation' }>;

    assert.equal(confirmation.status.value, 'rejected');
  });

  it('and a partial answer is neither yes nor no', () => {
    const reading = read(
      email({
        subject: 'Re: PO 4471',
        body: 'Order confirmation: we can supply some items, the rest to follow.',
      })
    );
    const confirmation = reading.fact as Extract<typeof reading.fact, { kind: 'confirmation' }>;

    assert.equal(confirmation.status.value, 'partial');
  });
});

describe('a shipment', () => {
  it('carries the tracking number and the carrier apart', () => {
    const reading = read(
      email({
        subject: 'PO 4471 dispatched',
        body: 'Sent today with DHL. Tracking number: JD0002234567. Delivery note DN-9912.',
      })
    );
    const shipment = reading.fact as Extract<typeof reading.fact, { kind: 'shipment' }>;

    assert.equal(shipment.tracking?.value, 'JD0002234567');
    assert.equal(shipment.carrier?.value, 'DHL');
    // A delivery note is not a tracking number: one is the supplier's paper,
    // the other is the courier's. Putting one in the other's column is how a
    // customer is given a number that tracks nothing.
    assert.equal(shipment.note?.value, 'DN-9912');
  });
});
