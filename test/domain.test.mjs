import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceOrder, buildOrder, normalizeEmail, validateCatalog } from '../src/domain.mjs';

const state = {
  seq: 1024,
  orders: [],
  menu: [
    { id: 1, name: 'Masala Dosa', cat: 'Breakfast', price: 50, avail: true },
    { id: 2, name: 'Tea', cat: 'Beverages', price: 10, avail: false }
  ],
  cats: ['Breakfast', 'Beverages']
};

test('normalizes account emails', () => {
  assert.equal(normalizeEmail('  Owner@Example.com '), 'owner@example.com');
});

test('server-calculates order price and caps the coupon discount', () => {
  const { order, nextSequence } = buildOrder(state, { email: 'student@example.com' }, {
    items: [{ id: 1, qty: 3 }],
    pay: 'Cash at Counter',
    coupon: 'STUDENT10',
    note: '  extra chutney  '
  }, new Date('2026-10-12T10:00:00Z'));

  assert.equal(order.total, 135);
  assert.equal(order.disc, 15);
  assert.equal(order.items[0].price, 50);
  assert.equal(order.note, 'extra chutney');
  assert.equal(nextSequence, 1025);
});

test('welcome discount is limited to the first order and capped at 60', () => {
  const { order } = buildOrder(state, { email: 'new@example.com' }, {
    items: [{ id: 1, qty: 20 }],
    pay: 'Cash at Counter',
    coupon: 'WELCOME20'
  });
  assert.equal(order.disc, 60);
  assert.throws(() => buildOrder({
    ...state,
    orders: [{ user: 'new@example.com' }]
  }, { email: 'new@example.com' }, {
    items: [{ id: 1, qty: 1 }],
    pay: 'Cash at Counter',
    coupon: 'WELCOME20'
  }), /first order/);
});

test('rejects unavailable items and client-selected online payments', () => {
  assert.throws(() => buildOrder(state, { email: 's@example.com' }, {
    items: [{ id: 2, qty: 1 }],
    pay: 'Cash at Counter'
  }), /no longer available/);
  assert.throws(() => buildOrder(state, { email: 's@example.com' }, {
    items: [{ id: 1, qty: 1 }],
    pay: 'Card'
  }), /Only payment at the counter/);
});

test('only allows sequential order-state transitions', () => {
  assert.equal(advanceOrder({ status: 'Placed' }).status, 'Accepted');
  assert.throws(() => advanceOrder({ status: 'Completed' }), /cannot be advanced/);
});

test('validates imported catalog ids and categories', () => {
  assert.doesNotThrow(() => validateCatalog(state.menu.slice(0, 1), state.cats));
  assert.throws(() => validateCatalog([{ ...state.menu[0], cat: 'Unknown' }], state.cats), /Unknown menu category/);
});
