import 'dotenv/config';
import bcrypt from 'bcryptjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { normalizeEmail, validEmail } from '../src/domain.mjs';

const { Pool } = pg;
const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Canteen Owner';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!validEmail(email)) throw new Error('Set a valid BOOTSTRAP_ADMIN_EMAIL');
if (!password || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
  throw new Error('Set a unique BOOTSTRAP_ADMIN_PASSWORD with at least 12 characters and no more than 72 UTF-8 bytes');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : undefined
});

try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  await pool.query(await fs.readFile(path.join(here, '..', 'db', 'schema.sql'), 'utf8'));
  const existing = await pool.query("SELECT id FROM app_users WHERE role = 'admin' LIMIT 1");
  if (existing.rowCount) throw new Error('An admin already exists; refusing to create another bootstrap admin');
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    'INSERT INTO app_users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
    [name, email, passwordHash, 'admin']
  );
  console.log(`Owner account created for ${email}`);
} finally {
  await pool.end();
}
