import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import connectPgSimple from 'connect-pg-simple';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import session from 'express-session';
import helmet from 'helmet';
import pg from 'pg';
import {
  advanceOrder,
  buildOrder,
  normalizeEmail,
  safeUser,
  validEmail,
  validateCatalog
} from './src/domain.mjs';

const { Pool } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';
const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000
});
const PgSession = connectPgSimple(session);

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

function badRequest(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && Buffer.byteLength(password, 'utf8') <= 72;
}

async function ensureBootstrapAdmin() {
  const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Canteen Owner';
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [730214]);
    const existing = await client.query("SELECT id FROM app_users WHERE role = 'admin' LIMIT 1");
    if (existing.rowCount) {
      await client.query('COMMIT');
      return;
    }
    if (!validEmail(email)) throw new Error('Set a valid BOOTSTRAP_ADMIN_EMAIL before first startup');
    if (!validPassword(password)) {
      throw new Error('Set BOOTSTRAP_ADMIN_PASSWORD to at least 12 characters and no more than 72 UTF-8 bytes before first startup');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await client.query(
      "INSERT INTO app_users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin')",
      [name || 'Canteen Owner', email, passwordHash]
    );
    await client.query(
      'INSERT INTO audit_log (actor_user_id, action, subject) VALUES (NULL, $1, $2)',
      ['admin.bootstrap', email]
    );
    await client.query('COMMIT');
    console.log('Initial owner account created from private environment settings.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return fail(res, 401, 'Sign in is required');
  next();
}

function allow(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return fail(res, 403, 'You do not have permission to do that');
    next();
  };
}

async function loadUser(req, res, next) {
  if (!req.session.userId) return next();
  try {
    const result = await pool.query(
      'SELECT id, name, email, phone, role, is_active FROM app_users WHERE id = $1',
      [req.session.userId]
    );
    req.user = result.rows[0];
    if (!req.user?.is_active) {
      req.session.destroy(() => {});
      return fail(res, 401, 'This account is disabled');
    }
    next();
  } catch (error) {
    next(error);
  }
}

async function mutateState(action, actorId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT data, revision, catalog_initialized FROM canteen_state WHERE id = 1 FOR UPDATE');
    const row = current.rows[0];
    const result = await fn(row.data, row);
    await client.query(
      `UPDATE canteen_state
       SET data = $1::jsonb, revision = revision + 1,
           catalog_initialized = COALESCE($2, catalog_initialized), updated_at = NOW()
       WHERE id = 1`,
      [JSON.stringify(result.data), result.catalogInitialized ?? null]
    );
    await client.query(
      'INSERT INTO audit_log (actor_user_id, action, subject) VALUES ($1, $2, $3)',
      [actorId || null, action, result.subject || null]
    );
    await client.query('COMMIT');
    return result.value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function validateMenuPatch(body, current, cats) {
  const keys = ['name', 'cat', 'desc', 'price', 'emoji', 'veg', 'prep', 'pop', 'avail', 'img'];
  if (!body || typeof body !== 'object' || Array.isArray(body)) badRequest('Invalid menu item');
  for (const key of Object.keys(body)) if (!keys.includes(key)) badRequest(`Unsupported menu field: ${key}`);
  const next = { ...current, ...body };
  if (typeof next.name !== 'string' || !next.name.trim() || next.name.length > 120) badRequest('Name must be 1-120 characters');
  if (!cats.includes(next.cat)) badRequest('Choose a valid category');
  if (!Number.isFinite(Number(next.price)) || Number(next.price) <= 0 || Number(next.price) > 100000) badRequest('Enter a valid price');
  if (typeof next.avail !== 'boolean' || typeof next.veg !== 'boolean' || typeof next.pop !== 'boolean') badRequest('Invalid menu flags');
  if (!Number.isSafeInteger(Number(next.prep)) || next.prep < 1 || next.prep > 240) badRequest('Prep time must be 1-240 minutes');
  if (typeof next.desc !== 'string' || next.desc.length > 500) badRequest('Description must be at most 500 characters');
  if (typeof next.emoji !== 'string' || next.emoji.length > 16) badRequest('Emoji is too long');
  if (typeof next.img !== 'undefined' && next.img && !/^https:\/\//i.test(next.img)) badRequest('Use an HTTPS image URL');
  return { ...next, name: next.name.trim(), price: Number(next.price), prep: Number(next.prep) };
}

app.disable('x-powered-by');
app.set('trust proxy', isProduction ? 1 : false);
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) &&
      (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
    return fail(res, 400, 'A JSON object request body is required');
  }
  next();
});
app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  name: 'smart_canteen_session',
  secret: process.env.SESSION_SECRET || '',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 12
  }
}));
app.use(loadUser);

app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.get('origin')) {
    try {
      if (new URL(req.get('origin')).host !== req.get('host')) return fail(res, 403, 'Cross-site request rejected');
    } catch {
      return fail(res, 403, 'Invalid request origin');
    }
  }
  next();
});

app.get('/api/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (error) {
    next(error);
  }
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = normalizeEmail(req.body.email);
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const password = req.body?.password;
    if (!name || name.length > 120 || !validEmail(email)) return fail(res, 400, 'Enter a valid name and email');
    if (!/^\d{10}$/.test(phone)) return fail(res, 400, 'Phone must be 10 digits');
    if (!validPassword(password)) return fail(res, 400, 'Password must be 12 or more characters and no more than 72 UTF-8 bytes');
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO app_users (name, email, phone, password_hash, role) VALUES ($1, $2, $3, $4, 'student') RETURNING id, name, email, phone, role, is_active",
      [name, email, phone, hash]
    );
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.userId = result.rows[0].id;
    res.status(201).json({ user: safeUser(result.rows[0]) });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'That email is already registered');
    next(error);
  }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const result = await pool.query(
      'SELECT id, name, email, phone, role, is_active, password_hash FROM app_users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];
    const matched = user ? await bcrypt.compare(password, user.password_hash) : await bcrypt.compare(password, '$2a$12$C6UzMDM.H6dfI/f/IKcEe.4U9yI3GZxQn3p8qD3ZJ8b9FzYv7M3Ka');
    if (!user || !user.is_active || !matched) return fail(res, 401, 'Invalid email or password');
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.userId = user.id;
    res.json({ user: safeUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('smart_canteen_session', { httpOnly: true, secure: isProduction, sameSite: 'lax' });
    res.status(204).end();
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: safeUser(req.user) }));

app.get('/api/state', requireAuth, async (req, res, next) => {
  try {
    const [stateResult, usersResult] = await Promise.all([
      pool.query('SELECT data, revision, catalog_initialized FROM canteen_state WHERE id = 1'),
      req.user.role === 'student'
        ? Promise.resolve({ rows: [req.user] })
        : pool.query('SELECT id, name, email, phone, role, is_active FROM app_users ORDER BY created_at')
    ]);
    const state = stateResult.rows[0];
    const data = state.data;
    const users = usersResult.rows.map(safeUser);
    const userEmail = req.user.email;
    res.json({
      revision: Number(state.revision),
      catalogInitialized: state.catalog_initialized,
      user: safeUser(req.user),
      state: {
        seq: data.seq,
        users,
        cats: data.cats,
        menu: data.menu,
        orders: req.user.role === 'student' ? data.orders.filter(order => order.user === userEmail) : data.orders,
        carts: req.user.role === 'student' ? { [userEmail]: data.carts?.[userEmail] || [] } : {},
        favs: req.user.role === 'student' ? { [userEmail]: data.favs?.[userEmail] || [] } : {},
        notifs: data.notifs.filter(item => item.to === userEmail || (req.user.role === 'staff' && item.to === 'staff')),
        noauto: !!data.noauto
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/notifications/read', requireAuth, async (req, res, next) => {
  try {
    await mutateState('notifications.read', req.user.id, data => {
      let changed = 0;
      data.notifs.forEach(item => {
        if ((item.to === req.user.email || (req.user.role === 'staff' && item.to === 'staff')) && !item.read) {
          item.read = true;
          changed++;
        }
      });
      return { data, subject: String(changed) };
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/initialize-catalog', requireAuth, allow('admin'), async (req, res, next) => {
  try {
    const { menu, cats } = req.body;
    validateCatalog(menu, cats);
    await mutateState('catalog.initialize', req.user.id, (data, row) => {
      if (row.catalog_initialized) throw Object.assign(new Error('Catalog was already initialized'), { status: 409 });
      data.menu = menu;
      data.cats = cats;
      data.seq = Number(data.seq) || 1024;
      return { data, subject: `${menu.length} menu items`, value: null, catalogInitialized: true };
    });
    res.status(201).json({ ok: true });
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    if (error.code === '23505') return fail(res, 409, 'Catalog contains duplicate data');
    next(error);
  }
});

app.post('/api/orders', requireAuth, allow('student'), async (req, res, next) => {
  try {
    const order = await mutateState('order.create', req.user.id, data => {
      data.orders ||= [];
      data.notifs ||= [];
      data.carts ||= {};
      const created = buildOrder(data, req.user, req.body);
      data.seq = created.nextSequence;
      data.orders.push(created.order);
      data.carts[req.user.email] = [];
      const id = Date.now() + crypto.randomInt(1, 1_000_000) / 1_000_000;
      data.notifs.push({
        id,
        to: req.user.email,
        text: `Order ${created.order.token} placed ✅ — we'll notify you when it's ready`,
        order: created.order.id,
        loud: false,
        read: false,
        time: new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(new Date())
      });
      data.notifs.push({
        id: id + 1,
        to: 'staff',
        text: `🆕 New order ${created.order.token} · ₹${created.order.total}${created.order.note ? ` · 📝 ${created.order.note}` : ''}`,
        order: created.order.id,
        loud: true,
        read: false,
        time: new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(new Date())
      });
      data.notifs = data.notifs.slice(-500);
      return { data, subject: created.order.id, value: created.order };
    });
    res.status(201).json({ order });
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    next(error);
  }
});

app.patch('/api/orders/:id/status', requireAuth, allow('staff'), async (req, res, next) => {
  try {
    const order = await mutateState('order.advance', req.user.id, data => {
      const index = data.orders.findIndex(item => item.id === req.params.id);
      if (index < 0) throw Object.assign(new Error('Order not found'), { status: 404 });
      data.orders[index] = advanceOrder(data.orders[index]);
      const updated = data.orders[index];
      const notice = {
        Accepted: `Order ${updated.token} accepted ✅`,
        Preparing: `👨‍🍳 Order ${updated.token} is being prepared`,
        Ready: `🎉 Order ${updated.token} is READY! Please collect it from the counter.`,
        Completed: `✅ Order ${updated.token} is complete. Enjoy your meal!`
      }[updated.status];
      data.notifs.push({
        id: Date.now() + crypto.randomInt(1, 1_000_000) / 1_000_000,
        to: updated.user,
        text: notice,
        order: updated.id,
        loud: ['Ready', 'Completed'].includes(updated.status),
        read: false,
        time: new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(new Date())
      });
      data.notifs = data.notifs.slice(-500);
      return { data, subject: updated.id, value: updated };
    });
    res.json({ order });
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    if (error.message === 'This order cannot be advanced') return fail(res, 409, error.message);
    next(error);
  }
});

app.patch('/api/orders/:id/rating', requireAuth, allow('student'), async (req, res, next) => {
  try {
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(res, 400, 'Rating must be between 1 and 5');
    const order = await mutateState('order.rate', req.user.id, data => {
      const item = data.orders.find(entry => entry.id === req.params.id && entry.user === req.user.email);
      if (!item || item.status !== 'Completed') throw Object.assign(new Error('Completed order not found'), { status: 404 });
      item.rating = rating;
      return { data, subject: item.id, value: item };
    });
    res.json({ order });
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    next(error);
  }
});

app.patch('/api/menu/:id', requireAuth, allow('staff', 'admin'), async (req, res, next) => {
  try {
    if (req.user.role === 'staff' && (Object.keys(req.body || {}).length !== 1 || typeof req.body.avail !== 'boolean')) {
      return fail(res, 403, 'Staff can only change item availability');
    }
    const item = await mutateState('menu.update', req.user.id, data => {
      const index = data.menu.findIndex(entry => entry.id === Number(req.params.id));
      if (index < 0) throw Object.assign(new Error('Menu item not found'), { status: 404 });
      const current = data.menu[index];
      data.menu[index] = validateMenuPatch(req.body, current, data.cats);
      if (data.menu.some((entry, i) => i !== index && entry.name.toLowerCase() === data.menu[index].name.toLowerCase())) {
        throw Object.assign(new Error('That item name is already in use'), { status: 409 });
      }
      return { data, subject: String(current.id), value: data.menu[index] };
    });
    res.json({ item });
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    next(error);
  }
});

app.post('/api/menu', requireAuth, allow('admin'), async (req, res, next) => {
  try {
    const item = await mutateState('menu.create', req.user.id, data => {
      const nextId = Math.max(0, ...data.menu.map(entry => Number(entry.id) || 0)) + 1;
      const candidate = validateMenuPatch({ ...req.body, avail: true, pop: !!req.body.pop, veg: !!req.body.veg, prep: Number(req.body.prep) || 5 }, {
        id: nextId, name: '', cat: '', desc: '', price: 0, emoji: '🍽️', avail: true, veg: true, prep: 5, pop: false
      }, data.cats);
      if (data.menu.some(entry => entry.name.toLowerCase() === candidate.name.toLowerCase())) throw Object.assign(new Error('That item already exists'), { status: 409 });
      data.menu.push(candidate);
      return { data, subject: String(nextId), value: candidate };
    });
    res.status(201).json({ item });
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    next(error);
  }
});

app.delete('/api/menu/:id', requireAuth, allow('admin'), async (req, res, next) => {
  try {
    await mutateState('menu.delete', req.user.id, data => {
      const index = data.menu.findIndex(entry => entry.id === Number(req.params.id));
      if (index < 0) throw Object.assign(new Error('Menu item not found'), { status: 404 });
      data.menu.splice(index, 1);
      return { data, subject: req.params.id };
    });
    res.status(204).end();
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    next(error);
  }
});

app.post('/api/categories', requireAuth, allow('admin'), async (req, res, next) => {
  try {
    const category = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!category || category.length > 60) return fail(res, 400, 'Category must be 1-60 characters');
    await mutateState('category.create', req.user.id, data => {
      if (data.cats.some(c => c.toLowerCase() === category.toLowerCase())) throw Object.assign(new Error('Category already exists'), { status: 409 });
      data.cats.push(category);
      return { data, subject: category };
    });
    res.status(201).json({ category });
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    next(error);
  }
});

app.delete('/api/categories/:name', requireAuth, allow('admin'), async (req, res, next) => {
  try {
    const name = req.params.name;
    await mutateState('category.delete', req.user.id, data => {
      if (data.menu.some(item => item.cat === name)) throw Object.assign(new Error('Category still has food items'), { status: 409 });
      if (!data.cats.includes(name)) throw Object.assign(new Error('Category not found'), { status: 404 });
      data.cats = data.cats.filter(item => item !== name);
      return { data, subject: name };
    });
    res.status(204).end();
  } catch (error) {
    if (error.status) return fail(res, error.status, error.message);
    next(error);
  }
});

app.post('/api/admin/staff', requireAuth, allow('admin'), async (req, res, next) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!name || name.length > 120 || !validEmail(email)) return fail(res, 400, 'Enter a valid staff name and email');
    if (!validPassword(password)) return fail(res, 400, 'Temporary password must be 12 or more characters and no more than 72 UTF-8 bytes');
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO app_users (name, email, password_hash, role) VALUES ($1, $2, $3, 'staff') RETURNING id, name, email, phone, role, is_active",
      [name, email, hash]
    );
    await pool.query('INSERT INTO audit_log (actor_user_id, action, subject) VALUES ($1, $2, $3)', [req.user.id, 'staff.create', email]);
    res.status(201).json({ user: safeUser(result.rows[0]) });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'That email is already registered');
    next(error);
  }
});

app.patch('/api/admin/staff/:id', requireAuth, allow('admin'), async (req, res, next) => {
  try {
    if (typeof req.body.isActive !== 'boolean') return fail(res, 400, 'isActive must be true or false');
    const result = await pool.query(
      "UPDATE app_users SET is_active = $1 WHERE id = $2 AND role = 'staff' RETURNING id, name, email, phone, role, is_active",
      [req.body.isActive, req.params.id]
    );
    if (!result.rowCount) return fail(res, 404, 'Staff account not found');
    await pool.query('INSERT INTO audit_log (actor_user_id, action, subject) VALUES ($1, $2, $3)', [req.user.id, 'staff.status', result.rows[0].email]);
    res.json({ user: safeUser(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

app.get('/', (_req, res, next) => {
  res.sendFile(path.join(here, 'index.html'), error => {
    if (error) next(error);
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return fail(res, 404, 'API route not found');
  res.status(404).type('text').send('Not found');
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  if (error.code === '23505') return fail(res, 409, 'A record with that value already exists');
  fail(res, 500, 'Unexpected server error');
});

export async function start() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters');
  }
  await pool.query(await fs.readFile(path.join(here, 'db', 'schema.sql'), 'utf8'));
  await ensureBootstrapAdmin();
  const port = Number(process.env.PORT) || 3000;
  return app.listen(port, () => console.log(`Smart Canteen listening on port ${port}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch(error => {
    console.error('Backend startup failed:', error.message);
    process.exitCode = 1;
  });
}
