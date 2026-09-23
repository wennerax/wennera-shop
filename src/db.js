import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });
export const db = new Database(path.join(dataDir, 'assistant.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT,
    username TEXT, photo_url TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('bug', 'order', 'message')),
    title TEXT NOT NULL, details TEXT NOT NULL, bot_name TEXT, budget INTEGER,
    media_path TEXT, status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
  );
`);

export function upsertUser(user) {
  db.prepare(`INSERT INTO users (telegram_id, first_name, last_name, username, photo_url)
    VALUES (@id, @first_name, @last_name, @username, @photo_url)
    ON CONFLICT(telegram_id) DO UPDATE SET first_name=excluded.first_name,
    last_name=excluded.last_name, username=excluded.username, photo_url=excluded.photo_url,
    updated_at=CURRENT_TIMESTAMP`).run(user);
}

export function createRequest(request) {
  return db.prepare(`INSERT INTO requests
    (telegram_id, type, title, details, bot_name, budget, media_path)
    VALUES (@telegram_id, @type, @title, @details, @bot_name, @budget, @media_path)`).run(request).lastInsertRowid;
}

export function getUserRequests(telegramId) {
  return db.prepare(`SELECT id, type, title, details, bot_name, budget, status, created_at
    FROM requests WHERE telegram_id = ? ORDER BY id DESC`).all(telegramId);
}

export function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}