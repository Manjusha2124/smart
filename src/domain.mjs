export const ORDER_FLOW = Object.freeze({
  Placed: 'Accepted',
  Accepted: 'Preparing',
  Preparing: 'Ready',
  Ready: 'Completed'
});

export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function invalidInput(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function validateCatalog(menu, cats) {
  if (!Array.isArray(menu) || menu.length < 1 || menu.length > 2500) {
    throw invalidInput('Catalog must contain between 1 and 2500 food items');
  }
  if (!Array.isArray(cats) || cats.length < 1 || cats.length > 100) {
    throw invalidInput('Catalog must contain between 1 and 100 categories');
  }

  const categoryNames = new Set(cats);
  if (cats.some(c => typeof c !== 'string' || !c.trim() || c.length > 60)) {
    throw invalidInput('Category names must be 1-60 characters');
  }
  const ids = new Set();
  const names = new Set();
  for (const item of menu) {
    if (!item || !Number.isSafeInteger(Number(item.id)) || Number(item.id) < 1) {
      throw invalidInput('Each menu item needs a positive integer id');
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || name.length > 120 || names.has(name.toLowerCase())) {
      throw invalidInput('Menu item names must be unique and 1-120 characters');
    }
    if (ids.has(Number(item.id))) throw invalidInput('Menu item ids must be unique');
    if (!categoryNames.has(item.cat)) throw invalidInput(`Unknown menu category for ${name}`);
    if (!Number.isFinite(Number(item.price)) || Number(item.price) <= 0) {
      throw invalidInput(`Invalid price for ${name}`);
    }
    if (typeof item.avail !== 'boolean') throw invalidInput(`Invalid availability for ${name}`);
    ids.add(Number(item.id));
    names.add(name.toLowerCase());
  }
}

export function buildOrder(state, user, input, now = new Date()) {
  if (!input || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) {
    throw new Error('Choose at least one item');
  }
  if (input.pay !== 'Cash at Counter') {
    throw new Error('Only payment at the counter is enabled until a payment provider is configured');
  }
  const lines = input.items.map(entry => {
    if (!entry || typeof entry !== 'object') throw invalidInput('Invalid item in order');
    const { id, qty } = entry;
    const item = state.menu.find(entry => entry.id === Number(id));
    const amount = Number(qty);
    if (!item || !item.avail) throw invalidInput('An item is no longer available');
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 20) {
      throw invalidInput('Each item quantity must be between 1 and 20');
    }
    return { name: item.name, price: item.price, qty: amount };
  });

  const subtotal = lines.reduce((sum, item) => sum + item.price * item.qty, 0);
  const coupon = typeof input.coupon === 'string' ? input.coupon.trim().toUpperCase() : '';
  let discount = 0;
  if (coupon === 'STUDENT10') discount = Math.min(30, Math.round(subtotal * 0.1));
  if (coupon === 'SAVE15' && subtotal >= 120) discount = 15;
  if (coupon === 'WELCOME20' && !state.orders.some(order => order.user === user.email)) {
    discount = Math.min(60, Math.round(subtotal * 0.2));
  }
  if (coupon && !['STUDENT10', 'SAVE15', 'WELCOME20'].includes(coupon)) throw invalidInput('Invalid coupon code');
  if (coupon === 'SAVE15' && subtotal < 120) throw invalidInput('SAVE15 requires an order of ₹120 or more');
  if (coupon === 'WELCOME20' && state.orders.some(order => order.user === user.email)) {
    throw invalidInput('WELCOME20 is only valid for your first order');
  }
  if (coupon === 'WELCOME20' && !discount) throw invalidInput('WELCOME20 is not valid for this order');

  const seq = state.seq + 1;
  const time = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).format(now);
  const order = {
    id: `ORD${seq}`,
    token: `C${String(seq - 1000).padStart(2, '0')}`,
    user: user.email,
    items: lines,
    total: subtotal - discount,
    coupon: discount ? coupon : '',
    disc: discount,
    pay: 'Cash at Counter',
    payStatus: 'Pay at counter',
    status: 'Placed',
    note: typeof input.note === 'string' ? input.note.trim().slice(0, 80) : '',
    time
  };
  return { order, nextSequence: seq };
}

export function advanceOrder(order) {
  const next = ORDER_FLOW[order.status];
  if (!next) throw new Error('This order cannot be advanced');
  return { ...order, status: next, ...(next === 'Completed' && order.payStatus === 'Pay at counter' ? { payStatus: 'Paid (cash)' } : {}) };
}

export function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    isActive: user.is_active
  };
}
