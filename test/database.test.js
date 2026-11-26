const assert = require('node:assert/strict');
const test = require('node:test');
const { toPostgresPlaceholders } = require('../database');

test('converts positional parameters without changing quoted question marks', () => {
  const sql = `SELECT * FROM recipes WHERE id = ? AND note = '?' AND title = "?" AND category = ?`;
  assert.equal(
    toPostgresPlaceholders(sql),
    `SELECT * FROM recipes WHERE id = $1 AND note = '?' AND title = "?" AND category = $2`
  );
});

test('does not convert question marks inside SQL comments', () => {
  const sql = `SELECT ? -- ?\nFROM recipes /* ? */ WHERE id = ?`;
  assert.equal(toPostgresPlaceholders(sql), `SELECT $1 -- ?\nFROM recipes /* ? */ WHERE id = $2`);
});
