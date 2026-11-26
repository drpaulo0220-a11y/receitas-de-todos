const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const SQLite = require('better-sqlite3');
const { Pool } = require('pg');

const transactionContext = new AsyncLocalStorage();

function toPostgresPlaceholders(sql) {
  let result = '';
  let parameterIndex = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      result += character;
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      result += character;
      if (character === '*' && next === '/') {
        result += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      result += character;
      if (character === quote && next === quote) {
        result += next;
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '-' && next === '-') {
      result += character + next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === '/' && next === '*') {
      result += character + next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (character === '\'' || character === '"') {
      quote = character;
      result += character;
      continue;
    }
    if (character === '?') {
      parameterIndex += 1;
      result += `$${parameterIndex}`;
      continue;
    }
    result += character;
  }

  return result;
}

class AppDatabase {
  constructor({ databaseUrl, dataDir }) {
    this.isPostgres = Boolean(databaseUrl);
    this.sqliteTransactionTail = Promise.resolve();
    this.sqliteTransactionActive = false;
    this.sqliteTransactionDone = Promise.resolve();

    if (this.isPostgres) {
      this.pool = new Pool({
        connectionString: databaseUrl,
        max: 5,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000
      });
      this.pool.on('error', (error) => {
        console.error('Erro inesperado em uma conexão PostgreSQL ociosa.', error);
      });
      return;
    }

    this.sqlite = new SQLite(path.join(dataDir, 'recipes.db'));
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
  }

  prepare(sql) {
    return {
      get: (...values) => this.execute(sql, values, 'get'),
      all: (...values) => this.execute(sql, values, 'all'),
      run: (...values) => this.execute(sql, values, 'run')
    };
  }

  execute(sql, values = [], operation = 'all') {
    if (this.isPostgres) {
      const context = transactionContext.getStore();
      const client = context?.client || this.pool;
      let statement = toPostgresPlaceholders(sql);
      if (operation === 'run' && /^\s*INSERT\b/i.test(statement) &&
          !/\bRETURNING\b/i.test(statement) &&
          !/INSERT\s+INTO\s+(?:web_sessions|seed_migrations)\b/i.test(statement)) {
        statement = statement.trim().replace(/;$/, '') + ' RETURNING id';
      }

      return client.query(statement, values).then((result) => {
        if (operation === 'get') return result.rows[0];
        if (operation === 'run') {
          return {
            changes: result.rowCount,
            lastInsertRowid: result.rows[0]?.id
          };
        }
        return result.rows;
      });
    }

    const run = () => {
      const statement = this.sqlite.prepare(sql);
      if (operation === 'get') return statement.get(...values);
      if (operation === 'run') return statement.run(...values);
      return statement.all(...values);
    };

    if (transactionContext.getStore()?.sqlite) return run();
    if (!this.sqliteTransactionActive) return run();
    return (async () => {
      while (this.sqliteTransactionActive) await this.sqliteTransactionDone;
      return run();
    })();
  }

  exec(sql) {
    if (this.isPostgres) {
      const context = transactionContext.getStore();
      return (context?.client || this.pool).query(sql);
    }

    const run = () => this.sqlite.exec(sql);
    if (transactionContext.getStore()?.sqlite) return run();
    if (!this.sqliteTransactionActive) return run();
    return (async () => {
      while (this.sqliteTransactionActive) await this.sqliteTransactionDone;
      return run();
    })();
  }

  transaction(callback) {
    return async (...args) => {
      if (this.isPostgres) {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          const result = await transactionContext.run({ client }, () => callback(...args));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }

      const previous = this.sqliteTransactionTail;
      let release;
      this.sqliteTransactionTail = new Promise((resolve) => { release = resolve; });
      await previous;

      let finishTransaction;
      this.sqliteTransactionDone = new Promise((resolve) => { finishTransaction = resolve; });
      this.sqliteTransactionActive = true;
      try {
        return await transactionContext.run({ sqlite: true }, async () => {
          this.sqlite.exec('BEGIN IMMEDIATE');
          try {
            const result = await callback(...args);
            this.sqlite.exec('COMMIT');
            return result;
          } catch (error) {
            this.sqlite.exec('ROLLBACK');
            throw error;
          }
        });
      } finally {
        this.sqliteTransactionActive = false;
        finishTransaction();
        release();
      }
    };
  }

  async close() {
    if (this.isPostgres) {
      await this.pool.end();
    } else {
      this.sqlite.close();
    }
  }
}

module.exports = { AppDatabase, toPostgresPlaceholders };
