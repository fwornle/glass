'use strict';
// One opener for every SQLite file the token pipeline touches (token-usage.db,
// opencode.db, copilot's session-store.db), so the same code runs on
// better-sqlite3 (native module — coding's default) or on Node's built-in
// node:sqlite (no native code — what glass runs on, incl. native Windows).
//
// Backend: CODING_SQLITE_BACKEND=better|node; unset → better-sqlite3 when it
// resolves from `requireFrom` (the caller's own file, so each repo keeps its own
// better-sqlite3 version), else node:sqlite.
//
// The better backend returns the better-sqlite3 handle untouched. The node
// backend wraps DatabaseSync with the subset the callers use — prepare, exec,
// close, pragma(), transaction(fn) — better-sqlite3's open defaults (5 s busy
// timeout, fileMustExist honoured) and its error codes (err.code
// 'SQLITE_CONSTRAINT_PRIMARYKEY', not node's 'ERR_SQLITE_ERROR' + errcode 1555).
//
// CommonJS with no build step: the statusline gauge require()s it synchronously.

const fs = require('node:fs');
const { createRequire } = require('node:module');

const BUSY_TIMEOUT_MS = 5000; // better-sqlite3's default `timeout`

function loadBetter(requireFrom) {
  try {
    return createRequire(requireFrom || __filename)('better-sqlite3');
  } catch {
    return null;
  }
}

function loadNode() {
  try {
    return require('node:sqlite');
  } catch (err) {
    const e = new Error(`node:sqlite unavailable on Node ${process.version} (needs >= 22.13): ${err.message}`);
    e.code = 'ERR_SQLITE_BACKEND';
    throw e;
  }
}

/** Which backend openDb uses for a caller: 'better' or 'node'. */
function sqliteBackend(requireFrom) {
  const want = process.env.CODING_SQLITE_BACKEND;
  if (want === 'node' || want === 'better') return want;
  return loadBetter(requireFrom) ? 'better' : 'node';
}

// SQLite result codes by number: primary codes, plus the extended constraint codes
// callers distinguish. Other extended codes fall back to their primary name.
const PRIMARY = ['OK', 'ERROR', 'INTERNAL', 'PERM', 'ABORT', 'BUSY', 'LOCKED', 'NOMEM', 'READONLY',
  'INTERRUPT', 'IOERR', 'CORRUPT', 'NOTFOUND', 'FULL', 'CANTOPEN', 'PROTOCOL', 'EMPTY', 'SCHEMA',
  'TOOBIG', 'CONSTRAINT', 'MISMATCH', 'MISUSE', 'NOLFS', 'AUTH', 'FORMAT', 'RANGE', 'NOTADB'];
const CONSTRAINT_EXT = { 275: 'CHECK', 531: 'COMMITHOOK', 787: 'FOREIGNKEY', 1043: 'FUNCTION',
  1299: 'NOTNULL', 1555: 'PRIMARYKEY', 1811: 'TRIGGER', 2067: 'UNIQUE', 2323: 'VTAB', 2579: 'ROWID',
  2835: 'PINNED', 3091: 'DATATYPE' };

function sqliteCodeName(errcode) {
  if (CONSTRAINT_EXT[errcode]) return `SQLITE_CONSTRAINT_${CONSTRAINT_EXT[errcode]}`;
  const primary = PRIMARY[errcode & 0xff];
  return primary ? `SQLITE_${primary}` : null;
}

// Run fn; a node:sqlite error leaves with better-sqlite3's err.code.
function translating(fn) {
  try {
    return fn();
  } catch (err) {
    if (err && err.code === 'ERR_SQLITE_ERROR' && typeof err.errcode === 'number') {
      const name = sqliteCodeName(err.errcode);
      if (name) err.code = name;
    }
    throw err;
  }
}

function wrapStatement(stmt) {
  return {
    run: (...params) => translating(() => stmt.run(...params)),
    get: (...params) => translating(() => stmt.get(...params)),
    all: (...params) => translating(() => stmt.all(...params)),
  };
}

function wrapNode(db) {
  let depth = 0;
  return {
    prepare: (sql) => wrapStatement(translating(() => db.prepare(sql))),
    exec: (sql) => translating(() => { db.exec(sql); }),
    close: () => db.close(),
    get open() { return db.isOpen; },
    get inTransaction() { return db.isTransaction; },
    // better-sqlite3 runs `PRAGMA <stmt>` and returns the rows.
    pragma: (stmt) => db.prepare(`PRAGMA ${stmt}`).all(),
    // better-sqlite3 semantics: a function that runs fn inside BEGIN/COMMIT and
    // rolls back on throw; a nested call uses a savepoint.
    transaction(fn) {
      return (...args) => {
        const sp = `sp_${depth}`;
        db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
        depth++;
        try {
          const out = fn(...args);
          depth--;
          db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
          return out;
        } catch (err) {
          depth--;
          db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw err;
        }
      };
    },
  };
}

/**
 * @param {string} file database path
 * @param {{ readonly?: boolean, fileMustExist?: boolean, timeout?: number, requireFrom?: string }} [opts]
 *   requireFrom: the caller's filename or import.meta.url — resolves its better-sqlite3
 */
function openDb(file, opts = {}) {
  const { readonly = false, fileMustExist = false, timeout, requireFrom } = opts;
  if (sqliteBackend(requireFrom) === 'better') {
    const Database = loadBetter(requireFrom);
    if (!Database) {
      const e = new Error('CODING_SQLITE_BACKEND=better but better-sqlite3 does not resolve');
      e.code = 'ERR_SQLITE_BACKEND';
      throw e;
    }
    const o = { readonly, fileMustExist };
    if (timeout !== undefined) o.timeout = timeout;
    return new Database(file, o);
  }
  if ((readonly || fileMustExist) && !fs.existsSync(file)) {
    const e = new Error(`unable to open database file: ${file}`);
    e.code = 'SQLITE_CANTOPEN';
    throw e;
  }
  const { DatabaseSync } = loadNode();
  const db = new DatabaseSync(file, { readOnly: readonly });
  db.exec(`PRAGMA busy_timeout = ${Number.isFinite(timeout) ? Math.max(0, Math.floor(timeout)) : BUSY_TIMEOUT_MS}`);
  return wrapNode(db);
}

module.exports = { openDb, sqliteBackend };
