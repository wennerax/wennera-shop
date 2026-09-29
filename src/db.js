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
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
  );
  CREATE TABLE IF NOT EXISTS owner_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    profile_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

for (const column of ['language_code TEXT', 'is_premium INTEGER NOT NULL DEFAULT 0', 'bio TEXT', 'profile_music TEXT']) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${column}`); } catch (error) {
    if (!error.message.includes('duplicate column name')) throw error;
  }
}

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
    FROM requests WHERE telegram_id = ? AND type != 'message' ORDER BY id DESC`).all(telegramId);
}

for (const column of ['owner_message_id INTEGER', 'reply_text TEXT', 'replied_at TEXT']) {
  try { db.exec(`ALTER TABLE messages ADD COLUMN ${column}`); } catch (error) {
    if (!error.message.includes('duplicate column name')) throw error;
  }
}

export function getUserMessages(telegramId) {
  return db.prepare(`SELECT id, title, details, reply_text, replied_at, status, created_at
    FROM messages WHERE telegram_id = ? ORDER BY id DESC`).all(telegramId);
}

export function createMessage(message) {
  return db.prepare(`INSERT INTO messages (telegram_id, title, details)
    VALUES (@telegram_id, @title, @details)`).run(message).lastInsertRowid;
}

export function setOwnerMessageId(id, ownerMessageId) {
  db.prepare('UPDATE messages SET owner_message_id = ? WHERE id = ?').run(ownerMessageId, id);
}

export function getMessageByOwnerMessageId(ownerMessageId) {
  return db.prepare('SELECT * FROM messages WHERE owner_message_id = ?').get(ownerMessageId);
}

export function getMessageById(id) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

export function saveMessageReply(id, replyText) {
  db.prepare(`UPDATE messages SET reply_text = ?, replied_at = CURRENT_TIMESTAMP, status = 'answered' WHERE id = ?`).run(replyText, id);
}

export function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}

export function getOwnerProfile() {
  const row = db.prepare('SELECT profile_json FROM owner_profile WHERE id = 1').get();
  return row ? JSON.parse(row.profile_json) : null;
}

export function saveOwnerProfile(profile) {
  db.prepare(`INSERT INTO owner_profile (id, profile_json) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=CURRENT_TIMESTAMP`)
    .run(JSON.stringify(profile));
}