const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const { AppDatabase } = require('./database');
const { ImageStorage } = require('./storage');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const HOST = process.env.HOST || (isProduction ? '0.0.0.0' : '127.0.0.1');
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'public', 'uploads'));
const databaseUrl = process.env.DATABASE_URL;
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const storageBucket = process.env.SUPABASE_STORAGE_BUCKET || 'recipe-images';
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT deve ser um nÃºmero entre 1 e 65535.');
if (!isProduction && !LOOPBACK_HOSTS.has(HOST) &&
    (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 ||
     !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12)) {
  throw new Error('Para expor o modo de desenvolvimento na rede, configure HOST, SESSION_SECRET (32+ caracteres) e ADMIN_PASSWORD (12+ caracteres).');
}
const IMAGE_TYPES = {
  'image/jpeg': { extension: '.jpg', signature: (header) => header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff },
  'image/png': { extension: '.png', signature: (header) => header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { extension: '.webp', signature: (header) => header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP' },
  'image/gif': { extension: '.gif', signature: (header) => ['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6)) }
};

const imageStorage = new ImageStorage({
  uploadDir,
  supabaseUrl,
  serviceRoleKey: supabaseServiceRoleKey,
  bucket: storageBucket,
  imageTypes: IMAGE_TYPES
});
const cloudStorageEnabled = imageStorage.enabled;
if (isProduction && supabaseUrl && new URL(supabaseUrl).protocol !== 'https:') {
  throw new Error('SUPABASE_URL deve usar HTTPS em produção.');
}

if (!databaseUrl) fs.mkdirSync(dataDir, { recursive: true });
if (!cloudStorageEnabled) fs.mkdirSync(uploadDir, { recursive: true });

if (isProduction && (!process.env.SESSION_SECRET || !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD ||
    !databaseUrl || !supabaseUrl || !supabaseServiceRoleKey)) {
  throw new Error('Em produção, configure SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL, SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.');
}
if (isProduction && (process.env.SESSION_SECRET.length < 32 || process.env.ADMIN_PASSWORD.length < 12)) {
  throw new Error('Em produção, SESSION_SECRET deve ter pelo menos 32 caracteres e ADMIN_PASSWORD pelo menos 12.');
}
if (process.env.ADMIN_PASSWORD && Buffer.byteLength(process.env.ADMIN_PASSWORD, 'utf8') > 72) {
  throw new Error('ADMIN_PASSWORD deve ter no mÃ¡ximo 72 bytes para ser compatÃ­vel com bcrypt.');
}

const db = new AppDatabase({ databaseUrl, dataDir });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_TYPES[file.mimetype]) {
      cb(null, true);
      return;
    }
    cb(new Error('Formato de imagem não suportado. Envie JPG, PNG, WEBP ou GIF.'));
  }
});

function verifyUploadedImage(req, _res, next) {
  if (!req.file) return next();

  const imageType = IMAGE_TYPES[req.file.mimetype];
  const header = Buffer.alloc(12);
  req.file.buffer.copy(header, 0, 0, header.length);

  if (!imageType || !imageType.signature(header)) {
    return next(new Error('O arquivo enviado não parece ser uma imagem válida.'));
  }

  next();
}

class DatabaseSessionStore extends session.Store {
  constructor(database) {
    super();
    this.getSession = database.prepare('SELECT sess, expires FROM web_sessions WHERE sid = ?');
    this.saveSession = database.prepare('INSERT INTO web_sessions (sid, sess, expires, user_id) VALUES (?, ?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires, user_id = excluded.user_id');
    this.deleteSession = database.prepare('DELETE FROM web_sessions WHERE sid = ?');
    this.updateExpiry = database.prepare('UPDATE web_sessions SET sess = ?, expires = ?, user_id = ? WHERE sid = ?');
    this.deleteExpired = database.prepare('DELETE FROM web_sessions WHERE expires <= ?');
    this.deleteUserSessions = database.prepare('DELETE FROM web_sessions WHERE user_id = ?');
  }

  async get(sid, callback) {
    let value = null;
    try {
      const row = await this.getSession.get(sid);
      if (row && Number(row.expires) <= Date.now()) {
        await this.deleteSession.run(sid);
      } else if (row) {
        value = JSON.parse(row.sess);
      }
    } catch (error) {
      return callback(error);
    }
    return callback(null, value);
  }

  async set(sid, value, callback) {
    try {
      const expires = value.cookie && value.cookie.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + 8 * 60 * 60 * 1000;
      await this.saveSession.run(sid, JSON.stringify(value), expires, value.user ? value.user.id : null);
      if (callback) callback(null);
    } catch (storeError) {
      if (callback) callback(storeError);
    }
  }

  async touch(sid, value, callback) {
    try {
      const expires = value.cookie && value.cookie.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + 8 * 60 * 60 * 1000;
      await this.updateExpiry.run(JSON.stringify(value), expires, value.user ? value.user.id : null, sid);
      if (callback) callback(null);
    } catch (storeError) {
      if (callback) callback(storeError);
    }
  }

  async destroy(sid, callback) {
    try {
      await this.deleteSession.run(sid);
      if (callback) callback(null);
    } catch (storeError) {
      if (callback) callback(storeError);
    }
  }
}

const CATEGORIES = ['bolos', 'sobremesas', 'carnes', 'massas', 'bebidas', 'lanches', 'saladas', 'regionais'];
const BRAZIL_STATES = [
  ['AC', 'Acre'], ['AL', 'Alagoas'], ['AP', 'Amapá'], ['AM', 'Amazonas'], ['BA', 'Bahia'],
  ['CE', 'Ceará'], ['DF', 'Distrito Federal'], ['ES', 'Espírito Santo'], ['GO', 'Goiás'],
  ['MA', 'Maranhão'], ['MT', 'Mato Grosso'], ['MS', 'Mato Grosso do Sul'], ['MG', 'Minas Gerais'],
  ['PA', 'Pará'], ['PB', 'Paraíba'], ['PR', 'Paraná'], ['PE', 'Pernambuco'], ['PI', 'Piauí'],
  ['RJ', 'Rio de Janeiro'], ['RN', 'Rio Grande do Norte'], ['RS', 'Rio Grande do Sul'],
  ['RO', 'Rondônia'], ['RR', 'Roraima'], ['SC', 'Santa Catarina'], ['SP', 'São Paulo'],
  ['SE', 'Sergipe'], ['TO', 'Tocantins']
];
const BRAZIL_STATE_CODES = new Set(BRAZIL_STATES.map(([code]) => code));

function getPhotoLicenseUrl(license = '') {
  const normalized = license.trim();
  const ccBySa = normalized.match(/^CC BY-SA\s+([\d.]+)$/i);
  if (ccBySa) return `https://creativecommons.org/licenses/by-sa/${ccBySa[1]}/`;
  const ccBy = normalized.match(/^CC BY\s+([\d.]+)$/i);
  if (ccBy) return `https://creativecommons.org/licenses/by/${ccBy[1]}/`;
  if (/^CC0/i.test(normalized)) return 'https://creativecommons.org/publicdomain/zero/1.0/';
  return '';
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function formatDate(value) {
  if (!value) return 'Sem data';
  return new Date(value).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function setFlash(req, message, type = 'info') {
  req.session.flash = { message, type };
}

function parseLines(value) {
  return (typeof value === 'string' ? value : '')
    .split(/\n|\r\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEmailForDuplicateCheck(email) {
  const normalized = email.trim().toLowerCase();
  const separator = normalized.lastIndexOf('@');
  if (separator < 0) return normalized;

  let localPart = normalized.slice(0, separator);
  let domain = normalized.slice(separator + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    localPart = localPart.split('+', 1)[0].replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${localPart}@${domain}`;
}

function getPrepTimeMinutes(value) {
  const match = String(value || '').match(/^\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}

function createRateLimiter({ windowMs, max, message }) {
  const buckets = new Map();
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.min(windowMs, 60 * 1000));
  cleanupTimer.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', '0');
      res.setHeader('RateLimit-Reset', String(retryAfter));
      return res.status(429).type('text/plain').send(message);
    }
    bucket.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(max - bucket.count));
    next();
  };
}

const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: 'Muitas tentativas de login. Aguarde 15 minutos e tente novamente.' });
const registrationLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, message: 'Muitas tentativas de cadastro. Aguarde uma hora e tente novamente.' });
const uploadLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, message: 'Limite de uploads atingido. Tente novamente daqui a uma hora.' });
const writeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 120, message: 'Muitas ações em pouco tempo. Aguarde 15 minutos.' });

function isSafeImageUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

function parseRecipeForm(body) {
  body = body && typeof body === 'object' ? body : {};
  const asText = (value) => typeof value === 'string' ? value : '';
  const title = asText(body.title).trim();
  const description = asText(body.description).trim();
  const category = asText(body.category).trim();
  const state = typeof body.state === 'string' ? body.state.trim().toUpperCase() : '';
  const prepMinutes = Number(body.prep_time);
  const servings = asText(body.servings).trim();
  const difficulty = asText(body.difficulty).trim();
  const ingredients = parseLines(body.ingredients);
  const steps = parseLines(body.steps);
  const photoUrl = asText(body.photo_url).trim();

  if (title.length < 2 || title.length > 120 ||
      description.length < 10 || description.length > 3000 ||
      !CATEGORIES.includes(category) ||
      (state && !BRAZIL_STATE_CODES.has(state)) ||
      !Number.isInteger(prepMinutes) || prepMinutes < 1 || prepMinutes > 1440 ||
      !servings || servings.length > 80 ||
      !['fácil', 'média', 'difícil'].includes(difficulty) ||
      !ingredients.length || ingredients.length > 60 ||
      ingredients.some((item) => item.length > 200) ||
      !steps.length || steps.length > 60 ||
      steps.some((item) => item.length > 1200) ||
      photoUrl.length > 2000 || !isSafeImageUrl(photoUrl)) {
    return { error: 'Confira os dados: categoria, dificuldade, tempo, foto e campos de texto precisam ser válidos.' };
  }

  return {
    value: {
      title,
      description,
      category,
      state,
      prepTime: `${prepMinutes} minutos`,
      servings,
      difficulty,
      ingredients: JSON.stringify(ingredients),
      steps: JSON.stringify(steps),
      photoUrl
    }
  };
}

async function getRecipeSummary(params = {}) {
  const { search = '', category = '', state = '', difficulty = '', maxPrepTime = 0, sort = 'newest', limit = 12, offset = 0 } = params;
  const clauses = ['1 = 1'];
  const values = [];

  if (search) {
    const term = `%${search.toLowerCase()}%`;
    clauses.push('(' +
      'LOWER(r.title) LIKE ? OR ' +
      'LOWER(r.description) LIKE ? OR ' +
      'LOWER(r.ingredients_json) LIKE ? OR ' +
      'LOWER(r.category) LIKE ?' +
      ')');
    values.push(term, term, term, term);
  }

  if (category) {
    clauses.push('r.category = ?');
    values.push(category);
  }

  if (state) {
    clauses.push('r.state = ?');
    values.push(state);
  }

  if (difficulty) {
    clauses.push('r.difficulty = ?');
    values.push(difficulty);
  }

  if (maxPrepTime) {
    clauses.push(db.isPostgres
      ? "CAST(SPLIT_PART(r.prep_time, ' ', 1) AS INTEGER) <= ?"
      : 'CAST(r.prep_time AS INTEGER) <= ?');
    values.push(maxPrepTime);
  }

  let orderBy = 'r.created_at DESC';
  if (sort === 'popular') orderBy = 'likes_count DESC, average_rating DESC';
  if (sort === 'rating') orderBy = 'average_rating DESC, likes_count DESC';
  if (sort === 'oldest') orderBy = 'r.created_at ASC';

  const sql = `
    SELECT
      r.*,
      u.name AS author_name,
      u.avatar_url AS author_avatar,
      (SELECT COUNT(*) FROM likes WHERE recipe_id = r.id) AS likes_count,
      (SELECT COUNT(*) FROM comments WHERE recipe_id = r.id) AS comments_count,
      COALESCE((SELECT AVG(score) FROM ratings WHERE recipe_id = r.id), 0) AS average_rating,
      (SELECT COUNT(*) FROM favorites WHERE recipe_id = r.id) AS favorites_count
    FROM recipes r
    JOIN users u ON u.id = r.user_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  return await db.prepare(sql).all(...values, limit, offset);
}

async function getRecipeDetail(id) {
  return await db.prepare(`
    SELECT
      r.*,
      u.name AS author_name,
      u.email AS author_email,
      u.bio AS author_bio,
      u.avatar_url AS author_avatar,
      (SELECT COUNT(*) FROM likes WHERE recipe_id = r.id) AS likes_count,
      (SELECT COUNT(*) FROM comments WHERE recipe_id = r.id) AS comments_count,
      COALESCE((SELECT AVG(score) FROM ratings WHERE recipe_id = r.id), 0) AS average_rating,
      (SELECT COUNT(*) FROM ratings WHERE recipe_id = r.id) AS ratings_count,
      (SELECT COUNT(*) FROM favorites WHERE recipe_id = r.id) AS favorites_count
    FROM recipes r
    JOIN users u ON u.id = r.user_id
    WHERE r.id = ?
  `).get(id);
}

const storeUploadedImage = (file) => imageStorage.store(file);
const removeUploadedFile = (photoUrl) => imageStorage.remove(photoUrl);

async function removeRecipe(recipeId) {
  const recipe = await db.prepare('SELECT id, photo_url FROM recipes WHERE id = ?').get(recipeId);
  if (!recipe) return false;

  await db.transaction(async () => {
    await db.prepare("DELETE FROM reports WHERE type = 'comment' AND item_id IN (SELECT id FROM comments WHERE recipe_id = ?)").run(recipeId);
    await db.prepare("DELETE FROM reports WHERE type = 'recipe' AND item_id = ?").run(recipeId);
    await db.prepare('DELETE FROM likes WHERE recipe_id = ?').run(recipeId);
    await db.prepare('DELETE FROM favorites WHERE recipe_id = ?').run(recipeId);
    await db.prepare('DELETE FROM ratings WHERE recipe_id = ?').run(recipeId);
    await db.prepare('DELETE FROM comments WHERE recipe_id = ?').run(recipeId);
    await db.prepare('DELETE FROM recipes WHERE id = ?').run(recipeId);
  })();

  await removeUploadedFile(recipe.photo_url);
  return true;
}

async function getUserSummary(userId) {
  return await db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM recipes WHERE user_id = u.id) AS recipes_count,
      (SELECT COUNT(*) FROM likes l JOIN recipes r ON r.id = l.recipe_id WHERE r.user_id = u.id) AS total_likes_received,
      (SELECT COUNT(*) FROM favorites f JOIN recipes r ON r.id = f.recipe_id WHERE r.user_id = u.id) AS total_favorites_received
    FROM users u
    WHERE u.id = ?
  `).get(userId);
}

async function initializeDatabase() {
  const primaryKey = db.isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const timestampDefault = db.isPostgres ? 'CURRENT_TIMESTAMP::TEXT' : 'CURRENT_TIMESTAMP';
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id ${primaryKey},
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      bio TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      is_admin INTEGER DEFAULT 0,
      is_suspended INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT ${timestampDefault}
    );

    CREATE TABLE IF NOT EXISTS recipes (
      id ${primaryKey},
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL,
      photo_url TEXT DEFAULT '',
      photo_credit TEXT NOT NULL DEFAULT '',
      photo_source_url TEXT NOT NULL DEFAULT '',
      photo_license TEXT NOT NULL DEFAULT '',
      photo_illustrative INTEGER NOT NULL DEFAULT 0,
      ingredients_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      prep_time TEXT NOT NULL,
      servings TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      created_at TEXT DEFAULT ${timestampDefault},
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS likes (
      id ${primaryKey},
      recipe_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT ${timestampDefault},
      UNIQUE(recipe_id, user_id),
      FOREIGN KEY (recipe_id) REFERENCES recipes(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id ${primaryKey},
      recipe_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT ${timestampDefault},
      UNIQUE(recipe_id, user_id),
      FOREIGN KEY (recipe_id) REFERENCES recipes(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ratings (
      id ${primaryKey},
      recipe_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      score INTEGER NOT NULL CHECK(score >=1 AND score <= 5),
      created_at TEXT DEFAULT ${timestampDefault},
      UNIQUE(recipe_id, user_id),
      FOREIGN KEY (recipe_id) REFERENCES recipes(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id ${primaryKey},
      recipe_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      parent_id INTEGER DEFAULT NULL,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT ${timestampDefault},
      FOREIGN KEY (recipe_id) REFERENCES recipes(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id ${primaryKey},
      type TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT ${timestampDefault}
    );

    CREATE TABLE IF NOT EXISTS web_sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires ${db.isPostgres ? 'BIGINT' : 'INTEGER'} NOT NULL,
      user_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS seed_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT ${timestampDefault}
    );
    CREATE INDEX IF NOT EXISTS web_sessions_expires_idx ON web_sessions(expires);
    CREATE INDEX IF NOT EXISTS comments_recipe_parent_created_idx ON comments(recipe_id, parent_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS comments_parent_created_idx ON comments(parent_id, created_at DESC, id DESC);
  `);

  if (db.isPostgres) {
    await db.exec(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE web_sessions ADD COLUMN IF NOT EXISTS user_id INTEGER;
      ALTER TABLE web_sessions ALTER COLUMN expires TYPE BIGINT;
      ALTER TABLE recipes ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT '';
      ALTER TABLE recipes ADD COLUMN IF NOT EXISTS photo_credit TEXT NOT NULL DEFAULT '';
      ALTER TABLE recipes ADD COLUMN IF NOT EXISTS photo_source_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE recipes ADD COLUMN IF NOT EXISTS photo_license TEXT NOT NULL DEFAULT '';
      ALTER TABLE recipes ADD COLUMN IF NOT EXISTS photo_illustrative INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE likes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE favorites ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ratings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
      ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
      ALTER TABLE web_sessions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE seed_migrations ENABLE ROW LEVEL SECURITY;
      CREATE INDEX IF NOT EXISTS recipes_state_idx ON recipes(state);
    `);
  } else {
    const userColumns = await db.prepare('PRAGMA table_info(users)').all();
    if (!userColumns.some((column) => column.name === 'is_suspended')) {
      await db.exec('ALTER TABLE users ADD COLUMN is_suspended INTEGER NOT NULL DEFAULT 0');
    }
    const sessionColumns = await db.prepare('PRAGMA table_info(web_sessions)').all();
    if (!sessionColumns.some((column) => column.name === 'user_id')) {
      await db.exec('ALTER TABLE web_sessions ADD COLUMN user_id INTEGER');
    }
    const recipeColumns = await db.prepare('PRAGMA table_info(recipes)').all();
    if (!recipeColumns.some((column) => column.name === 'state')) {
      await db.exec("ALTER TABLE recipes ADD COLUMN state TEXT NOT NULL DEFAULT ''");
    }
    const photoColumns = new Set((await db.prepare('PRAGMA table_info(recipes)').all()).map((column) => column.name));
    const missingPhotoColumns = [
      ['photo_credit', "TEXT NOT NULL DEFAULT ''"],
      ['photo_source_url', "TEXT NOT NULL DEFAULT ''"],
      ['photo_license', "TEXT NOT NULL DEFAULT ''"],
      ['photo_illustrative', 'INTEGER NOT NULL DEFAULT 0']
    ];
    for (const [column, definition] of missingPhotoColumns) {
      if (!photoColumns.has(column)) await db.exec(`ALTER TABLE recipes ADD COLUMN ${column} ${definition}`);
    }
    await db.exec('CREATE INDEX IF NOT EXISTS recipes_state_idx ON recipes(state)');
  }

  const adminEmail = (process.env.ADMIN_EMAIL || 'receitaadmin@sdetodos.com').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(24).toString('base64url');
  const existingAdmin = await db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(adminEmail);
  if (!existingAdmin) {
    const adminHash = bcrypt.hashSync(adminPassword, 10);
    const inserted = await db.prepare(`
      INSERT INTO users (name, email, password_hash, bio, avatar_url, is_admin)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run('Admin Receitas', adminEmail, adminHash, 'Moderador da comunidade de culinária.', '/images/default-avatar.svg');

    if (!isProduction && !process.env.ADMIN_PASSWORD) {
      console.warn(`Senha inicial do administrador (guarde-a): ${adminPassword}`);
    }

    const recipesSeed = [
      {
        user_id: inserted.lastInsertRowid,
        title: 'Risoto de cogumelos cremoso',
        category: 'massas',
        description: 'Uma refeição reconfortante com molho cremoso, cogumelos e queijo parmesão.',
        photo_url: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=900&q=80',
        ingredients: ['400g de arroz arbóreo', '250g de cogumelos', '1 xícara de vinho branco', '1 litro de caldo de legumes', '1/2 xícara de parmesão ralado', '2 colheres de manteiga', '1 cebola pequena'],
        steps: ['Refogue a cebola e os cogumelos.', 'Adicione o arroz e mexa até ficar translúcido.', 'Vá acrescentando o caldo aos poucos.', 'Quando o arroz estiver cremoso, misture o parmesão e a manteiga.', 'Sirva em seguida.'],
        prep_time: '40 minutos',
        servings: '2 a 3 pessoas',
        difficulty: 'média'
      },
      {
        user_id: inserted.lastInsertRowid,
        title: 'Bolo de cenoura fofo',
        category: 'bolos',
        description: 'Bolo clássico com cobertura cremosa e textura leve.',
        photo_url: 'https://images.unsplash.com/photo-1556910103-1c02745aae4d?auto=format&fit=crop&w=900&q=80',
        ingredients: ['3 cenouras médias', '3 ovos', '1 xícara de óleo', '2 xícaras de açúcar', '2 xícaras de farinha de trigo', '1 colher de fermento em pó'],
        steps: ['Bata cenoura, ovos e óleo no liquidificador.', 'Misture com açúcar, farinha e fermento.', 'Asse em forno preaquecido por 35 minutos.', 'Deixe esfriar e cubra com chocolate ou brigadeiro.'],
        prep_time: '50 minutos',
        servings: '8 fatias',
        difficulty: 'fácil'
      },
      {
        user_id: inserted.lastInsertRowid,
        title: 'Salada de quinoa tropical',
        category: 'saladas',
        description: 'Leve, nutritiva e cheia de sabor para o dia a dia.',
        photo_url: 'https://images.unsplash.com/photo-1546793665-c74683f339c1?auto=format&fit=crop&w=900&q=80',
        ingredients: ['1 xícara de quinoa cozida', '1 manga picada', '1/2 abacaxi em cubos', '1/2 xícara de folhas de rúcula', '1/2 abacate', 'Suco de 1 limão'],
        steps: ['Misture a quinoa com a manga e o abacaxi.', 'Adicione a rúcula e o abacate', 'Tempere com limão, sal e azeite.', 'Sirva imediatamente.'],
        prep_time: '20 minutos',
        servings: '2 porções',
        difficulty: 'fácil'
      }
    ];

    for (const recipe of recipesSeed) {
      await db.prepare(`
        INSERT INTO recipes (user_id, title, category, description, photo_url, ingredients_json, steps_json, prep_time, servings, difficulty)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recipe.user_id,
        recipe.title,
        recipe.category,
        recipe.description,
        recipe.photo_url,
        JSON.stringify(recipe.ingredients),
        JSON.stringify(recipe.steps),
        recipe.prep_time,
        recipe.servings,
        recipe.difficulty
      );
    }
  } else if (process.env.ADMIN_PASSWORD) {
    if (!bcrypt.compareSync(adminPassword, existingAdmin.password_hash)) {
      const adminHash = bcrypt.hashSync(adminPassword, 10);
      await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(adminHash, existingAdmin.id);
      await db.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(existingAdmin.id);
    }
    await db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existingAdmin.id);
  } else if (!isProduction && bcrypt.compareSync('admin123', existingAdmin.password_hash)) {
    const newAdminPassword = crypto.randomBytes(24).toString('base64url');
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newAdminPassword, 10), existingAdmin.id);
    await db.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(existingAdmin.id);
    console.warn(`A senha administrativa padrÃ£o foi substituÃ­da. Nova senha (guarde-a): ${newAdminPassword}`);
  }

  const regionalSeedName = 'regional-recipes-810-v1';
  if (!await db.prepare('SELECT 1 FROM seed_migrations WHERE name = ?').get(regionalSeedName)) {
    const regionalRecipes = require('./seed-data/regional-recipes');
    const seedOwner = await db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
    if (!seedOwner || regionalRecipes.length !== 810) {
      throw new Error('O catálogo regional precisa conter 810 receitas e uma conta administradora.');
    }
    const insertRegionalRecipe = db.prepare(`
      INSERT INTO recipes (user_id, title, category, state, description, photo_url, photo_credit, photo_source_url, photo_license, photo_illustrative, ingredients_json, steps_json, prep_time, servings, difficulty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    await db.transaction(async () => {
      for (const recipe of regionalRecipes) {
        await insertRegionalRecipe.run(
          seedOwner.id, recipe.title, recipe.category, recipe.state, recipe.description, recipe.photo_url,
          recipe.photo_credit, recipe.photo_source_url, recipe.photo_license, recipe.photo_illustrative,
          JSON.stringify(recipe.ingredients), JSON.stringify(recipe.steps), recipe.prep_time,
          recipe.servings, recipe.difficulty
        );
      }
      await db.prepare('INSERT INTO seed_migrations (name) VALUES (?)').run(regionalSeedName);
    })();
  }

  const imageMigrationName = 'regional-recipe-images-v2';
  if (!await db.prepare('SELECT 1 FROM seed_migrations WHERE name = ?').get(imageMigrationName)) {
    const regionalRecipes = require('./seed-data/regional-recipes');
    const updateRecipeImage = db.prepare(`
      UPDATE recipes
      SET photo_url = ?, photo_credit = ?, photo_source_url = ?, photo_license = ?, photo_illustrative = ?
      WHERE state = ? AND title = ?
    `);
    await db.transaction(async () => {
      for (const recipe of regionalRecipes) {
        await updateRecipeImage.run(
          recipe.photo_url, recipe.photo_credit, recipe.photo_source_url, recipe.photo_license,
          recipe.photo_illustrative, recipe.state, recipe.title
        );
      }
      await db.prepare('INSERT INTO seed_migrations (name) VALUES (?)').run(imageMigrationName);
    })();
  }

  const verifiedRecipePhotoMigration = 'regional-recipe-photos-clear-v1';
  if (!await db.prepare('SELECT 1 FROM seed_migrations WHERE name = ?').get(verifiedRecipePhotoMigration)) {
    const regionalRecipes = require('./seed-data/regional-recipes');
    const clearRecipePhoto = db.prepare(`
      UPDATE recipes
      SET photo_url = '', photo_credit = '', photo_source_url = '', photo_license = '', photo_illustrative = 0
      WHERE state = ? AND title = ?
    `);
    await db.transaction(async () => {
      for (const recipe of regionalRecipes) await clearRecipePhoto.run(recipe.state, recipe.title);
      await db.prepare('INSERT INTO seed_migrations (name) VALUES (?)').run(verifiedRecipePhotoMigration);
    })();
  }

  const exactRecipePhotoMigration = 'regional-recipe-photos-exact-v1';
  if (!await db.prepare('SELECT 1 FROM seed_migrations WHERE name = ?').get(exactRecipePhotoMigration)) {
    const regionalRecipes = require('./seed-data/regional-recipes');
    const updateVerifiedRecipePhoto = db.prepare(`
      UPDATE recipes
      SET photo_url = ?, photo_credit = ?, photo_source_url = ?, photo_license = ?, photo_illustrative = 0
      WHERE state = ? AND title = ?
    `);
    await db.transaction(async () => {
      for (const recipe of regionalRecipes) {
        await updateVerifiedRecipePhoto.run(
          recipe.photo_url, recipe.photo_credit, recipe.photo_source_url, recipe.photo_license,
          recipe.state, recipe.title
        );
      }
      await db.prepare('INSERT INTO seed_migrations (name) VALUES (?)').run(exactRecipePhotoMigration);
    })();
  }

  const regionalRecipeDraftLabelMigration = 'regional-recipe-draft-label-v1';
  if (!await db.prepare('SELECT 1 FROM seed_migrations WHERE name = ?').get(regionalRecipeDraftLabelMigration)) {
    const regionalRecipes = require('./seed-data/regional-recipes');
    const updateDraftDescription = db.prepare(`
      UPDATE recipes SET description = ?
      WHERE state = ? AND title = ? AND description LIKE 'Versão caseira de %'
    `);
    await db.transaction(async () => {
      for (const recipe of regionalRecipes) {
        await updateDraftDescription.run(recipe.description, recipe.state, recipe.title);
      }
      await db.prepare('INSERT INTO seed_migrations (name) VALUES (?)').run(regionalRecipeDraftLabelMigration);
    })();
  }

  if (isProduction && adminEmail !== 'admin@receitasdetodos.com') {
    await db.prepare('UPDATE users SET is_admin = 0 WHERE email = ?').run('admin@receitasdetodos.com');
  }
}

async function prepareDatabase() {
  if (db.isPostgres) await db.prepare('SELECT 1').get();
  await initializeDatabase();
  await db.exec('DROP TABLE IF EXISTS password_resets');
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  next();
});
app.use(express.urlencoded({ extended: true, limit: '64kb', parameterLimit: 200 }));
app.use(express.json({ limit: '32kb' }));
if (!cloudStorageEnabled) app.use('/uploads', express.static(uploadDir, { dotfiles: 'deny', index: false }));
app.use(express.static(path.join(__dirname, 'public')));
if (isProduction) app.set('trust proxy', 1);
const sessionStore = new DatabaseSessionStore(db);
const cleanupSessions = setInterval(() => {
  Promise.resolve().then(() => sessionStore.deleteExpired.run(Date.now())).catch((error) => {
    console.error('Não foi possível remover sessões expiradas.', error);
  });
}, 60 * 60 * 1000);
cleanupSessions.unref();
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex'),
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  unset: 'destroy',
  cookie: { maxAge: 1000 * 60 * 60 * 8, httpOnly: true, sameSite: 'lax', secure: isProduction }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/health', async (_req, res) => {
  await db.prepare('SELECT 1').get();
  res.status(200).type('text/plain').send('ok');
});

app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const source = req.get('origin') || req.get('referer');
  if (!source) return next();
  try {
    const sourceOrigin = new URL(source).origin;
    const requestOrigin = new URL(`${req.protocol}://${req.get('host')}`).origin;
    if (sourceOrigin === requestOrigin) return next();
  } catch (_error) {
    // Invalid Origin/Referer values are rejected below.
  }
  return res.status(403).send('Esta solicitaÃ§Ã£o foi bloqueada por seguranÃ§a.');
});

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.categories = CATEGORIES;
  res.locals.states = BRAZIL_STATES;
  res.locals.photoLicenseUrl = getPhotoLicenseUrl;
  res.locals.formatDate = formatDate;
  res.locals.prepTimeMinutes = getPrepTimeMinutes;
  res.locals.flash = req.session.flash || null;
  res.locals.pageTitle = res.locals.pageTitle || 'Receitas de Todos';
  res.locals.metaDescription = res.locals.metaDescription || 'Receitas de Todos — uma comunidade de culinária para compartilhar receitas e descobrir pratos novos.';
  delete req.session.flash;
  next();
});

async function requireAuth(req, res, next) {
  if (!req.session.user) {
    setFlash(req, 'Faça login para continuar.', 'warning');
    return res.redirect('/login');
  }
  const user = await db.prepare('SELECT is_suspended, is_admin FROM users WHERE id = ?').get(req.session.user.id);
  if (!user || user.is_suspended) {
    req.session.user = null;
    setFlash(req, 'Esta conta não está disponível. Se precisar de ajuda, fale com a administração.', 'danger');
    return res.redirect('/login');
  }
  req.session.user.is_admin = !!user.is_admin;
  next();
}

async function requireAdmin(req, res, next) {
  const user = req.session.user
    ? await db.prepare('SELECT is_admin, is_suspended FROM users WHERE id = ?').get(req.session.user.id)
    : null;
  if (!user || !user.is_admin || user.is_suspended) {
    if (req.session.user) req.session.user.is_admin = false;
    setFlash(req, 'Você não tem permissão para acessar esta área.', 'danger');
    return res.redirect('/');
  }
  req.session.user.is_admin = true;
  next();
}

async function requireRecipeEditAccess(req, res, next) {
  const recipe = await db.prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.id);
  if (!recipe) {
    setFlash(req, 'Receita nÃ£o encontrada.', 'warning');
    return res.redirect('/recipes');
  }
  if (recipe.user_id !== req.session.user.id && !req.session.user.is_admin) {
    setFlash(req, 'VocÃª nÃ£o pode editar esta receita.', 'danger');
    return res.redirect(`/recipe/${recipe.id}`);
  }
  req.recipe = recipe;
  next();
}

function establishSession(req, res, user, message, redirectTo, next) {
  req.session.regenerate((error) => {
    if (error) return next(error);
    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      bio: user.bio,
      avatar_url: user.avatar_url,
      is_admin: !!user.is_admin
    };
    setFlash(req, message, 'success');
    req.session.save((saveError) => {
      if (saveError) return next(saveError);
      res.redirect(redirectTo);
    });
  });
}

async function renderHomePage(req, res) {
  const pageSize = 20;
  const totalRecipes = (await db.prepare('SELECT COUNT(*) AS total FROM recipes').get()).total;
  const pageCount = Math.max(1, Math.ceil(totalRecipes / pageSize));
  const requestedPage = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0
    ? Math.min(requestedPage, pageCount)
    : 1;
  const recipes = await getRecipeSummary({ limit: pageSize, offset: (page - 1) * pageSize });

  res.render('home', {
    recipes,
    page,
    pageCount,
    totalRecipes,
    firstRecipeNumber: totalRecipes ? (page - 1) * pageSize + 1 : 0,
    lastRecipeNumber: Math.min(page * pageSize, totalRecipes),
    pageNumbers: Array.from({ length: pageCount }, (_value, index) => index + 1),
    pageTitle: 'Receitas de Todos'
  });
}

app.get('/', async (req, res) => {
  await renderHomePage(req, res);
});

app.get('/recipes', async (req, res) => {
  const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  const requestedState = typeof req.query.state === 'string' ? req.query.state.trim().toUpperCase() : '';
  const state = BRAZIL_STATE_CODES.has(requestedState) ? requestedState : '';
  const difficulty = typeof req.query.difficulty === 'string' ? req.query.difficulty.trim() : '';
  const requestedMaxTime = typeof req.query.max_time === 'string' ? Number(req.query.max_time) : 0;
  const maxPrepTime = [15, 30, 45, 60, 90, 120].includes(requestedMaxTime) ? requestedMaxTime : 0;
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'newest';
  const requestedPage = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 10000) : 1;
  const pageSize = 24;
  const pageRecipes = await getRecipeSummary({ search, category, state, difficulty, maxPrepTime, sort, limit: pageSize + 1, offset: (page - 1) * pageSize });
  const hasNextPage = pageRecipes.length > pageSize;
  const recipes = pageRecipes.slice(0, pageSize);
  const filterQuery = new URLSearchParams({ q: search, category, state, difficulty, max_time: String(maxPrepTime || ''), sort }).toString();

  res.render('recipes', {
    recipes,
    search,
    category,
    state,
    difficulty,
    maxPrepTime,
    sort,
    selectedCategory: category,
    page,
    hasNextPage,
    filterQuery,
    pageTitle: 'Receitas'
  });
});

app.get('/recipe/:id', async (req, res) => {
  const recipe = await getRecipeDetail(req.params.id);
  if (!recipe) {
    setFlash(req, 'Receita não encontrada.', 'warning');
    return res.redirect('/recipes');
  }

  const ingredients = safeJsonArray(recipe.ingredients_json);
  const steps = safeJsonArray(recipe.steps_json);
  const commentPageSize = 25;
  const totalTopLevelComments = (await db.prepare('SELECT COUNT(*) AS total FROM comments WHERE recipe_id = ? AND parent_id IS NULL').get(recipe.id)).total;
  const requestedCommentPage = typeof req.query.comments_page === 'string' ? Number(req.query.comments_page) : 1;
  const commentPageCount = Math.max(1, Math.ceil(totalTopLevelComments / commentPageSize));
  const commentPage = Number.isSafeInteger(requestedCommentPage) && requestedCommentPage > 0
    ? Math.min(requestedCommentPage, commentPageCount)
    : 1;
  const topLevelComments = await db.prepare(`
    SELECT c.*, u.name AS author_name, u.avatar_url AS author_avatar
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.recipe_id = ? AND c.parent_id IS NULL
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ? OFFSET ?
  `).all(recipe.id, commentPageSize, (commentPage - 1) * commentPageSize);
  const getRecentReplies = db.prepare(`
    SELECT c.*, u.name AS author_name, u.avatar_url AS author_avatar
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.parent_id = ?
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT 20
  `);
  for (const comment of topLevelComments) {
    comment.replies = (await getRecentReplies.all(comment.id)).reverse();
  }
  const hasOlderComments = commentPage < commentPageCount;
  const hasNewerComments = commentPage > 1;

  const hasLiked = req.session.user
    ? await db.prepare('SELECT 1 FROM likes WHERE recipe_id = ? AND user_id = ?').get(recipe.id, req.session.user.id)
    : null;

  const hasFavorited = req.session.user
    ? await db.prepare('SELECT 1 FROM favorites WHERE recipe_id = ? AND user_id = ?').get(recipe.id, req.session.user.id)
    : null;

  const userRating = req.session.user
    ? await db.prepare('SELECT score FROM ratings WHERE recipe_id = ? AND user_id = ?').get(recipe.id, req.session.user.id)
    : null;

  const isOwner = req.session.user && req.session.user.id === recipe.user_id;

  res.render('recipe-detail', {
    recipe,
    ingredients,
    steps,
    comments: topLevelComments,
    commentPage,
    commentPageCount,
    hasOlderComments,
    hasNewerComments,
    hasLiked,
    hasFavorited,
    userRating: userRating ? userRating.score : 0,
    isOwner,
    pageTitle: `${recipe.title} | Receitas de Todos`,
    metaDescription: recipe.description.slice(0, 155)
  });
});

app.get('/recipe/:id/edit', requireAuth, async (req, res) => {
  const recipe = await db.prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.id);
  if (!recipe) {
    return res.redirect('/recipes');
  }
  if (recipe.user_id !== req.session.user.id && !req.session.user.is_admin) {
    setFlash(req, 'Você não pode editar esta receita.', 'danger');
    return res.redirect(`/recipe/${recipe.id}`);
  }

  const ingredients = safeJsonArray(recipe.ingredients_json).join('\n');
  const steps = safeJsonArray(recipe.steps_json).join('\n');

  res.render('recipe-form', {
    mode: 'edit',
    recipe: { ...recipe, ingredients, steps },
    pageTitle: 'Editar receita'
  });
});

app.post('/recipe/:id/edit', requireAuth, requireRecipeEditAccess, writeLimiter, uploadLimiter, upload.single('photo'), verifyUploadedImage, async (req, res) => {
  const recipe = req.recipe;
  if (!recipe) {
    return res.redirect('/recipes');
  }
  if (recipe.user_id !== req.session.user.id && !req.session.user.is_admin) {
    setFlash(req, 'Você não pode editar esta receita.', 'danger');
    return res.redirect(`/recipe/${recipe.id}`);
  }

  const parsed = parseRecipeForm(req.body);
  if (parsed.error) {
    setFlash(req, parsed.error, 'warning');
    return res.redirect(`/recipe/${recipe.id}/edit`);
  }

  const fields = parsed.value;
  const photoUrl = req.file ? await storeUploadedImage(req.file) : (fields.photoUrl || recipe.photo_url || '');

  try {
    await db.prepare(`
      UPDATE recipes
      SET title = ?, category = ?, state = ?, description = ?, photo_url = ?, ingredients_json = ?, steps_json = ?, prep_time = ?, servings = ?, difficulty = ?
      WHERE id = ?
    `).run(fields.title, fields.category, fields.state, fields.description, photoUrl, fields.ingredients, fields.steps, fields.prepTime, fields.servings, fields.difficulty, recipe.id);
  } catch (error) {
    if (req.file) await removeUploadedFile(photoUrl);
    throw error;
  }
  if (recipe.photo_url !== photoUrl) await removeUploadedFile(recipe.photo_url);

  setFlash(req, 'Receita atualizada com sucesso!', 'success');
  res.redirect(`/recipe/${recipe.id}`);
});

app.post('/recipe/:id/delete', requireAuth, writeLimiter, async (req, res) => {
  const recipe = await db.prepare('SELECT * FROM recipes WHERE id = ?').get(req.params.id);
  if (!recipe) {
    return res.redirect('/recipes');
  }
  if (recipe.user_id !== req.session.user.id && !req.session.user.is_admin) {
    setFlash(req, 'Você não pode remover esta receita.', 'danger');
    return res.redirect(`/recipe/${recipe.id}`);
  }

  await removeRecipe(recipe.id);

  setFlash(req, 'Receita removida com sucesso.', 'success');
  return res.redirect('/profile');
});

app.post('/recipe/:id/like', requireAuth, writeLimiter, async (req, res) => {
  const recipeId = Number(req.params.id);
  const existing = await db.prepare('SELECT id FROM likes WHERE recipe_id = ? AND user_id = ?').get(recipeId, req.session.user.id);

  if (existing) {
    await db.prepare('DELETE FROM likes WHERE id = ?').run(existing.id);
  } else {
    await db.prepare('INSERT INTO likes (recipe_id, user_id) VALUES (?, ?)').run(recipeId, req.session.user.id);
  }

  res.redirect(`/recipe/${recipeId}`);
});

app.post('/recipe/:id/favorite', requireAuth, writeLimiter, async (req, res) => {
  const recipeId = Number(req.params.id);
  const existing = await db.prepare('SELECT id FROM favorites WHERE recipe_id = ? AND user_id = ?').get(recipeId, req.session.user.id);

  if (existing) {
    await db.prepare('DELETE FROM favorites WHERE id = ?').run(existing.id);
  } else {
    await db.prepare('INSERT INTO favorites (recipe_id, user_id) VALUES (?, ?)').run(recipeId, req.session.user.id);
  }

  res.redirect(`/recipe/${recipeId}`);
});

app.post('/recipe/:id/rate', requireAuth, writeLimiter, async (req, res) => {
  const recipeId = Number(req.params.id);
  const score = Number(req.body.score || 0);

  if (!Number.isInteger(score) || score < 1 || score > 5) {
    setFlash(req, 'Selecione uma avaliação válida.', 'warning');
    return res.redirect(`/recipe/${recipeId}`);
  }

  const existing = await db.prepare('SELECT id FROM ratings WHERE recipe_id = ? AND user_id = ?').get(recipeId, req.session.user.id);
  if (existing) {
    await db.prepare('UPDATE ratings SET score = ? WHERE id = ?').run(score, existing.id);
  } else {
    await db.prepare('INSERT INTO ratings (recipe_id, user_id, score) VALUES (?, ?, ?)').run(recipeId, req.session.user.id, score);
  }

  setFlash(req, 'Sua avaliação foi registrada.', 'success');
  res.redirect(`/recipe/${recipeId}`);
});

app.post('/recipe/:id/comment', requireAuth, writeLimiter, async (req, res) => {
  const recipeId = Number(req.params.id);
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;

  if (!body || body.length > 1000) {
    setFlash(req, 'O comentário deve ter entre 1 e 1000 caracteres.', 'warning');
    return res.redirect(`/recipe/${recipeId}`);
  }

  if (!await db.prepare('SELECT id FROM recipes WHERE id = ?').get(recipeId)) {
    setFlash(req, 'Receita não encontrada.', 'warning');
    return res.redirect('/recipes');
  }

  if (parentId) {
    const parent = await db.prepare('SELECT id FROM comments WHERE id = ? AND recipe_id = ? AND parent_id IS NULL').get(parentId, recipeId);
    if (!parent) {
      setFlash(req, 'Não foi possível responder a esse comentário.', 'warning');
      return res.redirect(`/recipe/${recipeId}`);
    }
  }

  await db.prepare('INSERT INTO comments (recipe_id, user_id, parent_id, body) VALUES (?, ?, ?, ?)').run(recipeId, req.session.user.id, parentId, body);
  setFlash(req, 'Comentário enviado.', 'success');
  res.redirect(`/recipe/${recipeId}`);
});

app.post('/recipe/:id/report', requireAuth, writeLimiter, async (req, res) => {
  const recipeId = Number(req.params.id);
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';

  if (!await db.prepare('SELECT id FROM recipes WHERE id = ?').get(recipeId)) {
    setFlash(req, 'Receita não encontrada.', 'warning');
    return res.redirect('/recipes');
  }
  if (!reason || reason.length > 500) {
    setFlash(req, 'Informe um motivo com até 500 caracteres.', 'warning');
    return res.redirect(`/recipe/${recipeId}`);
  }

  const duplicate = await db.prepare("SELECT id FROM reports WHERE type = 'recipe' AND item_id = ? AND user_id = ? AND status = 'open'").get(recipeId, req.session.user.id);
  if (!duplicate) await db.prepare('INSERT INTO reports (type, item_id, user_id, reason) VALUES (?, ?, ?, ?)').run('recipe', recipeId, req.session.user.id, reason);
  setFlash(req, 'Denúncia registrada. A equipe de moderação será avisada.', 'success');
  res.redirect(`/recipe/${recipeId}`);
});

app.post('/comment/:id/report', requireAuth, writeLimiter, async (req, res) => {
  const commentId = Number(req.params.id);
  const comment = await db.prepare('SELECT id, recipe_id FROM comments WHERE id = ?').get(commentId);
  if (!comment) {
    setFlash(req, 'Comentário não encontrado.', 'warning');
    return res.redirect('/recipes');
  }

  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 500) {
    setFlash(req, 'Informe um motivo com até 500 caracteres.', 'warning');
    return res.redirect(`/recipe/${comment.recipe_id}`);
  }

  const duplicate = await db.prepare("SELECT id FROM reports WHERE type = 'comment' AND item_id = ? AND user_id = ? AND status = 'open'").get(commentId, req.session.user.id);
  if (!duplicate) await db.prepare('INSERT INTO reports (type, item_id, user_id, reason) VALUES (?, ?, ?, ?)').run('comment', commentId, req.session.user.id, reason);
  setFlash(req, 'Denúncia registrada para análise da moderação.', 'success');
  res.redirect(`/recipe/${comment.recipe_id}`);
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/profile');
  res.render('login', { pageTitle: 'Login' });
});

app.post('/login', loginLimiter, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || user.is_suspended || Buffer.byteLength(password, 'utf8') > 72 || !bcrypt.compareSync(password, user.password_hash)) {
    setFlash(req, 'E-mail ou senha inválidos.', 'danger');
    return res.redirect('/login');
  }

  establishSession(req, res, user, `Bem-vindo(a), ${user.name}!`, '/', (error) => {
    console.error('Não foi possível iniciar a sessão do usuário.', error);
    res.status(500).send('Não foi possível iniciar sua sessão. Tente novamente.');
  });
});

app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/profile');
  res.render('register', { pageTitle: 'Cadastro', formData: { name: '', email: '' } });
});

function renderRegistrationError(req, res, message, formData, status = 400) {
  delete req.session.flash;
  return res.status(status).render('register', {
    pageTitle: 'Cadastro',
    formData,
    flash: { message, type: 'warning' }
  });
}

app.post('/register', registrationLimiter, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const formData = { name, email };

  if (name.length < 2 || name.length > 80 || email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 7 || Buffer.byteLength(password, 'utf8') > 72) {
    return renderRegistrationError(req, res, 'Confira os dados. A senha deve ter pelo menos 7 caracteres.', formData);
  }

  const existing = await db.prepare(`
    SELECT id, email FROM users
    WHERE lower(email) = ?
      OR lower(email) LIKE '%@gmail.com'
      OR lower(email) LIKE '%@googlemail.com'
  `).all(email);
  if (existing.some((user) => normalizeEmailForDuplicateCheck(user.email) === normalizeEmailForDuplicateCheck(email))) {
    return renderRegistrationError(req, res, 'Esse e-mail já está cadastrado. Entre na sua conta ou use outro e-mail.', formData);
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  let result;
  try {
    result = await db.transaction(async () => {
      const possibleDuplicates = await db.prepare(`
        SELECT email FROM users
        WHERE lower(email) = ?
          OR lower(email) LIKE '%@gmail.com'
          OR lower(email) LIKE '%@googlemail.com'
      `).all(email);
      const normalizedEmail = normalizeEmailForDuplicateCheck(email);
      if (possibleDuplicates.some((user) => normalizeEmailForDuplicateCheck(user.email) === normalizedEmail)) return null;
      return await db.prepare('INSERT INTO users (name, email, password_hash, avatar_url) VALUES (?, ?, ?, ?)')
        .run(name, email, passwordHash, '/images/default-avatar.svg');
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === '23505') {
      return renderRegistrationError(req, res, 'Esse e-mail já está cadastrado. Entre na sua conta ou use outro e-mail.', formData);
    }
    console.error('Não foi possível criar a conta.', error);
    return renderRegistrationError(req, res, 'Não foi possível criar sua conta agora. Tente novamente.', formData, 500);
  }
  if (!result) {
    return renderRegistrationError(req, res, 'Esse e-mail jÃ¡ estÃ¡ cadastrado. Entre na sua conta ou use outro e-mail.', formData);
  }
  const user = {
    id: Number(result.lastInsertRowid),
    name,
    email,
    bio: '',
    avatar_url: '/images/default-avatar.svg',
    is_admin: false
  };

  establishSession(req, res, user, 'Cadastro realizado com sucesso!', '/', (error) => {
    console.error('Não foi possível iniciar a sessão após o cadastro.', error);
    res.status(500).send('Sua conta foi criada, mas não foi possível iniciar a sessão. Entre pela página de login.');
  });
});

app.post('/logout', (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.redirect('/');
  });
});

app.get('/profile', requireAuth, async (req, res) => {
  const userData = await getUserSummary(req.session.user.id);
  const recipes = await db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM likes WHERE recipe_id = r.id) AS likes_count,
           COALESCE((SELECT AVG(score) FROM ratings WHERE recipe_id = r.id), 0) AS average_rating
    FROM recipes r
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC
  `).all(req.session.user.id);

  const favorites = await db.prepare(`
    SELECT r.*, u.name AS author_name,
           (SELECT COUNT(*) FROM likes WHERE recipe_id = r.id) AS likes_count,
           COALESCE((SELECT AVG(score) FROM ratings WHERE recipe_id = r.id), 0) AS average_rating
    FROM favorites f
    JOIN recipes r ON r.id = f.recipe_id
    JOIN users u ON u.id = r.user_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
  `).all(req.session.user.id);

  res.render('profile', { userData, recipes, favorites, isOwnProfile: true, pageTitle: 'Meu perfil', metaDescription: `Perfil de ${userData.name} na comunidade Receitas de Todos.` });
});

app.get('/profile/edit', requireAuth, async (req, res) => {
  const userData = await getUserSummary(req.session.user.id);
  res.render('profile-edit', { userData, pageTitle: 'Editar perfil' });
});

app.post('/profile/edit', requireAuth, writeLimiter, uploadLimiter, upload.single('avatar'), verifyUploadedImage, async (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const bio = typeof body.bio === 'string' ? body.bio.trim() : '';
  const avatarUrl = typeof body.avatar_url === 'string' ? body.avatar_url.trim() : '';

  if (name.length < 2 || name.length > 80 || bio.length > 500 ||
      avatarUrl.length > 2000 || !isSafeImageUrl(avatarUrl)) {
    setFlash(req, 'Confira o nome, a biografia e a URL da foto.', 'warning');
    return res.redirect('/profile/edit');
  }

  const previousAvatar = req.session.user.avatar_url;
  const nextAvatar = req.file ? await storeUploadedImage(req.file) : (avatarUrl || previousAvatar || '/images/default-avatar.svg');
  try {
    await db.prepare('UPDATE users SET name = ?, bio = ?, avatar_url = ? WHERE id = ?')
      .run(name, bio, nextAvatar, req.session.user.id);
  } catch (error) {
    if (req.file) await removeUploadedFile(nextAvatar);
    throw error;
  }
  req.session.user.name = name;
  req.session.user.bio = bio;
  req.session.user.avatar_url = nextAvatar;
  if (previousAvatar !== nextAvatar) await removeUploadedFile(previousAvatar);
  setFlash(req, 'Perfil atualizado.', 'success');
  req.session.save((error) => {
    if (error) return next(error);
    res.redirect('/profile');
  });
});

app.get('/profile/:id', async (req, res) => {
  const userData = await getUserSummary(req.params.id);
  if (!userData) {
    setFlash(req, 'Perfil não encontrado.', 'warning');
    return res.redirect('/recipes');
  }

  const recipes = await db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM likes WHERE recipe_id = r.id) AS likes_count,
           COALESCE((SELECT AVG(score) FROM ratings WHERE recipe_id = r.id), 0) AS average_rating
    FROM recipes r
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC
  `).all(userData.id);

  const canViewFavorites = req.session.user && req.session.user.id === userData.id;
  const favorites = canViewFavorites ? await db.prepare(`
    SELECT r.*, u.name AS author_name,
           (SELECT COUNT(*) FROM likes WHERE recipe_id = r.id) AS likes_count,
           COALESCE((SELECT AVG(score) FROM ratings WHERE recipe_id = r.id), 0) AS average_rating
    FROM favorites f
    JOIN recipes r ON r.id = f.recipe_id
    JOIN users u ON u.id = r.user_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
  `).all(userData.id) : [];

  res.render('profile', { userData, recipes, favorites, isOwnProfile: canViewFavorites, pageTitle: `${userData.name} | Perfil`, metaDescription: `Receitas publicadas por ${userData.name} na comunidade Receitas de Todos.` });
});

app.get('/new-recipe', requireAuth, (req, res) => {
  res.render('recipe-form', { mode: 'create', recipe: null, pageTitle: 'Nova receita' });
});

app.post('/new-recipe', requireAuth, writeLimiter, uploadLimiter, upload.single('photo'), verifyUploadedImage, async (req, res) => {
  const parsed = parseRecipeForm(req.body);
  if (parsed.error) {
    setFlash(req, parsed.error, 'warning');
    return res.redirect('/new-recipe');
  }

  const fields = parsed.value;
  const photoUrl = req.file ? await storeUploadedImage(req.file) : (fields.photoUrl || '');

  let result;
  try {
    result = await db.prepare(`
      INSERT INTO recipes (user_id, title, category, state, description, photo_url, ingredients_json, steps_json, prep_time, servings, difficulty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.session.user.id, fields.title, fields.category, fields.state, fields.description, photoUrl, fields.ingredients, fields.steps, fields.prepTime, fields.servings, fields.difficulty);
  } catch (error) {
    if (req.file) await removeUploadedFile(photoUrl);
    throw error;
  }

  setFlash(req, 'Receita publicada com sucesso!', 'success');
  res.redirect(`/recipe/${result.lastInsertRowid}`);
});

app.get('/admin', requireAdmin, async (req, res) => {
  const reports = await db.prepare(`
    SELECT r.*, u.name AS reporter_name,
           (CASE WHEN r.type = 'recipe' THEN (SELECT title FROM recipes WHERE id = r.item_id) ELSE (SELECT body FROM comments WHERE id = r.item_id) END) AS item_label
    FROM reports r
    JOIN users u ON u.id = r.user_id
    WHERE r.status = 'open'
    ORDER BY r.created_at DESC
  `).all();

  const stats = {
    users: (await db.prepare('SELECT COUNT(*) AS total FROM users').get()).total,
    recipes: (await db.prepare('SELECT COUNT(*) AS total FROM recipes').get()).total,
    reports: (await db.prepare("SELECT COUNT(*) AS total FROM reports WHERE status = 'open'").get()).total,
    comments: (await db.prepare('SELECT COUNT(*) AS total FROM comments').get()).total
  };

  const recipes = await db.prepare(`
    SELECT r.id, r.title, r.category, r.photo_url, r.photo_credit, r.photo_source_url,
           r.photo_license, r.photo_illustrative, r.created_at, u.name AS author_name
    FROM recipes r
    JOIN users u ON u.id = r.user_id
    ORDER BY r.created_at DESC
  `).all();
  const users = await db.prepare(`
    SELECT u.id, u.name, u.email, u.is_suspended, u.created_at,
           (SELECT COUNT(*) FROM recipes r WHERE r.user_id = u.id) AS recipes_count
    FROM users u
    WHERE u.is_admin = 0
    ORDER BY u.created_at DESC
    LIMIT 200
  `).all();

  res.render('admin', { reports, recipes, users, stats, pageTitle: 'Administração' });
});

app.post('/admin/resolve/:id', requireAdmin, writeLimiter, async (req, res) => {
  await db.prepare('UPDATE reports SET status = ? WHERE id = ?').run('resolved', req.params.id);
  setFlash(req, 'Denúncia resolvida.', 'success');
  res.redirect('/admin');
});

app.post('/admin/comment/:id/delete', requireAdmin, writeLimiter, async (req, res) => {
  const comment = await db.prepare('SELECT id FROM comments WHERE id = ?').get(req.params.id);
  if (comment) {
    await db.transaction(async () => {
      await db.prepare("DELETE FROM reports WHERE type = 'comment' AND item_id IN (SELECT id FROM comments WHERE id = ? OR parent_id = ?)").run(comment.id, comment.id);
      await db.prepare('DELETE FROM comments WHERE parent_id = ?').run(comment.id);
      await db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
    })();
  }
  setFlash(req, 'Comentário removido pela moderação.', 'success');
  res.redirect('/admin');
});

app.post('/admin/user/:id/toggle-suspension', requireAdmin, writeLimiter, async (req, res) => {
  const target = await db.prepare('SELECT id, is_admin, is_suspended FROM users WHERE id = ?').get(req.params.id);
  if (!target || target.is_admin || target.id === req.session.user.id) {
    setFlash(req, 'Essa conta não pode ser moderada por esta ação.', 'warning');
    return res.redirect('/admin');
  }

  const nextSuspendedState = target.is_suspended ? 0 : 1;
  await db.prepare('UPDATE users SET is_suspended = ? WHERE id = ?').run(nextSuspendedState, target.id);
  if (nextSuspendedState) await sessionStore.deleteUserSessions.run(target.id);
  setFlash(req, nextSuspendedState ? 'Conta suspensa.' : 'Conta reativada.', 'success');
  res.redirect('/admin');
});

app.post('/admin/recipe/:id/delete', requireAdmin, writeLimiter, async (req, res) => {
  await removeRecipe(req.params.id);
  setFlash(req, 'Receita removida pela moderação.', 'success');
  res.redirect('/admin');
});

app.get('/about', (req, res) => {
  res.render('static-page', { pageTitle: 'Sobre', content: `A Receitas de Todos nasceu para conectar cozinheiros, compartilhar experiências e criar uma comunidade vibrante de culinária caseira.` });
});

app.get('/contact', (req, res) => {
  res.render('static-page', { pageTitle: 'Contato', content: 'Entre em contato através do e-mail contato@receitasdetodos.com ou pela área administrativa do projeto.' });
});

app.get('/privacy', (req, res) => {
  res.render('static-page', { pageTitle: 'Política de Privacidade', content: 'Os dados dos usuários são usados apenas para operação da plataforma, autenticação, segurança e melhoria do serviço.' });
});

app.get('/terms', (req, res) => {
  res.render('static-page', { pageTitle: 'Termos de Uso', content: 'O uso da plataforma deve respeitar regras de convivência, segurança e direitos autorais. Qualquer conteúdo impróprio pode ser removido.' });
});

app.use((err, req, res, next) => {
  if (!(err instanceof multer.MulterError) &&
      err.message !== 'Formato de imagem não suportado. Envie JPG, PNG, WEBP ou GIF.' &&
      err.message !== 'O arquivo enviado não parece ser uma imagem válida.') {
    return next(err);
  }

  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    setFlash(req, 'A imagem deve ter no máximo 5 MB.', 'warning');
  } else {
    setFlash(req, err.message, 'warning');
  }

  const editPath = req.path.match(/^\/recipe\/(\d+)\/edit$/);
  if (editPath) return res.redirect(`/recipe/${editPath[1]}/edit`);
  return res.redirect(req.path === '/profile/edit' ? '/profile/edit' : '/new-recipe');
});

app.use((error, req, res, next) => {
  if (error.type === 'entity.too.large') return res.status(413).send('Os dados enviados excedem o limite permitido.');
  if (error.type === 'entity.parse.failed') return res.status(400).send('O corpo da solicitaÃ§Ã£o estÃ¡ invÃ¡lido.');
  console.error('Erro não tratado durante uma requisição.', error);
  if (res.headersSent) return next(error);
  res.status(500).send('Ocorreu um erro interno. Tente novamente mais tarde.');
});

app.use((req, res) => {
  res.status(404).render('not-found', { pageTitle: 'Página não encontrada' });
});

async function startServer() {
  await prepareDatabase();
  const displayHost = HOST.includes(':') && !HOST.startsWith('[') ? `[${HOST}]` : HOST;
  app.listen(PORT, HOST, () => {
    console.log(`Receitas de Todos rodando em http://${displayHost}:${PORT}`);
  });
}

startServer().catch(async (error) => {
  clearInterval(cleanupSessions);
  console.error('Não foi possível iniciar o servidor.', error);
  await db.close();
  process.exitCode = 1;
});
