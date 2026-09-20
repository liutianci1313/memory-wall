const express = require('express');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const adminKey = process.env.ADMIN_KEY || '123456789';
const root = __dirname;
const uploadDirectory = path.join(root, 'uploads');
const databaseDirectory = path.join(root, 'data');
fs.mkdirSync(uploadDirectory, { recursive: true });
fs.mkdirSync(databaseDirectory, { recursive: true });

const database = new DatabaseSync(path.join(databaseDirectory, 'photos.db'));
database.exec('PRAGMA journal_mode = WAL');
database.exec(`CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT '日常',
  note TEXT NOT NULL DEFAULT '',
  story TEXT NOT NULL DEFAULT '',
  taken_at TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
try { database.exec("ALTER TABLE photos ADD COLUMN note TEXT NOT NULL DEFAULT ''"); } catch (_error) { /* Existing database already has the column. */ }
try { database.exec("ALTER TABLE photos ADD COLUMN story TEXT NOT NULL DEFAULT ''"); } catch (_error) { /* Existing database already has the column. */ }
try { database.exec("ALTER TABLE photos ADD COLUMN taken_at TEXT NOT NULL DEFAULT ''"); } catch (_error) { /* Existing database already has the column. */ }
database.exec(`CREATE TABLE IF NOT EXISTS music (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  lyrics TEXT NOT NULL DEFAULT '',
  timed_lyrics TEXT NOT NULL DEFAULT '[]',
  lyrics_source TEXT NOT NULL DEFAULT 'none',
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
try { database.exec("ALTER TABLE music ADD COLUMN timed_lyrics TEXT NOT NULL DEFAULT '[]'"); } catch (_error) { /* Existing database already has the column. */ }
try { database.exec("ALTER TABLE music ADD COLUMN lyrics_source TEXT NOT NULL DEFAULT 'none'"); } catch (_error) { /* Existing database already has the column. */ }

const storage = multer.diskStorage({
  destination: uploadDirectory,
  filename: (_request, file, callback) => callback(null, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { files: 20, fileSize: 15 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    const imageType = /^image\/(jpeg|jpg|png|webp|gif|avif|heic|heif)$/.test(file.mimetype);
    if (imageType) return callback(null, true);
    callback(new Error('仅支持 JPG、PNG、WEBP、GIF、AVIF 或 HEIC 图片'));
  }
});
const audioStorage = multer.diskStorage({
  destination: uploadDirectory,
  filename: (_request, file, callback) => callback(null, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${path.extname(file.originalname).toLowerCase()}`)
});
const audioUpload = multer({
  storage: audioStorage,
  limits: { fileSize: 80 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => {
    const isAudio = file.fieldname === 'audio' && /^audio\/(mpeg|wav|ogg|mp4|x-m4a)$/.test(file.mimetype);
    const isLrc = file.fieldname === 'lrc' && path.extname(file.originalname).toLowerCase() === '.lrc';
    callback(null, isAudio || isLrc);
  }
});

app.use(express.json());
app.use('/uploads', express.static(uploadDirectory));
app.use(express.static(root));

app.get('/api/photos', (_request, response) => {
  const photos = database.prepare('SELECT id, original_name, category, note, story, taken_at, mime_type, created_at, stored_name FROM photos ORDER BY CASE WHEN TRIM(COALESCE(taken_at, "")) != "" THEN taken_at ELSE created_at END DESC').all();
  response.json(photos.map(photo => ({ ...photo, taken_at: normalizeTakenAt(photo.taken_at), url: `/uploads/${photo.stored_name}` })));
});

app.get('/api/music', (_request, response) => {
  const tracks = database.prepare('SELECT id, title, lyrics, timed_lyrics, lyrics_source, mime_type, created_at, stored_name FROM music ORDER BY created_at DESC').all();
  response.json(tracks.map(track => ({ ...track, timed_lyrics: parseTimedLyrics(track.timed_lyrics), url: `/uploads/${track.stored_name}` })));
});

app.get('/api/admin/check', requireAdmin, (_request, response) => response.json({ ok: true }));

function requireAdmin(request, response, next) {
  if (request.get('x-admin-key') !== adminKey) return response.status(401).json({ error: '需要管理权限' });
  next();
}

app.post('/api/photos', requireAdmin, upload.array('photos', 20), (request, response) => {
  if (!request.files?.length) return response.status(400).json({ error: '请选择至少一张图片' });
  const category = ['旅行', '日常', '灵感'].includes(request.body.category) ? request.body.category : '日常';
  const note = String(request.body.note || '').trim().slice(0, 500);
  const story = String(request.body.story || '').trim().slice(0, 5000);
  const takenAt = normalizeTakenAt(request.body.taken_at);
  const insert = database.prepare('INSERT INTO photos (original_name, stored_name, category, note, story, taken_at, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  try { response.status(201).json({ ids: (request.files || []).map(file => insert.run(file.originalname, file.filename, category, note, story, takenAt, file.mimetype, new Date().toISOString()).lastInsertRowid) }); }
  catch (error) { (request.files || []).forEach(file => fs.rmSync(file.path, { force: true })); response.status(500).json({ error: '保存照片失败' }); }
});

app.patch('/api/photos/:id', requireAdmin, (request, response) => {
  const note = String(request.body.note || '').trim().slice(0, 500);
  const story = String(request.body.story || '').trim().slice(0, 5000);
  const takenAt = normalizeTakenAt(request.body.taken_at);
  const category = ['旅行', '日常', '灵感'].includes(request.body.category) ? request.body.category : '日常';
  const result = database.prepare('UPDATE photos SET note = ?, story = ?, taken_at = ?, category = ? WHERE id = ?').run(note, story, takenAt, category, request.params.id);
  response.sendStatus(result.changes ? 204 : 404);
});

app.delete('/api/photos/:id', requireAdmin, (request, response) => {
  const photo = database.prepare('SELECT stored_name FROM photos WHERE id = ?').get(request.params.id);
  if (!photo) return response.sendStatus(404);
  database.prepare('DELETE FROM photos WHERE id = ?').run(request.params.id);
  fs.rmSync(path.join(uploadDirectory, photo.stored_name), { force: true });
  response.sendStatus(204);
});

app.post('/api/music', requireAdmin, audioUpload.fields([{ name: 'audio', maxCount: 1 }, { name: 'lrc', maxCount: 1 }]), (request, response) => {
  const audio = request.files?.audio?.[0];
  const lrc = request.files?.lrc?.[0];
  if (!audio) return response.status(400).json({ error: '请选择音频文件' });
  const title = String(request.body.title || audio.originalname).trim().slice(0, 120);
  let lyrics = String(request.body.lyrics || '').trim().slice(0, 10000);
  let timedLyrics = [];
  let lyricsSource = lyrics ? 'manual' : 'none';
  if (lrc) {
    try {
      const lrcText = fs.readFileSync(lrc.path, 'utf8').slice(0, 100000);
      timedLyrics = parseLrc(lrcText);
      lyrics = timedLyrics.map(line => line.text).filter(Boolean).join('\n').slice(0, 10000);
      lyricsSource = timedLyrics.length ? 'lrc' : 'none';
    } finally { fs.rmSync(lrc.path, { force: true }); }
  }
  try {
    const result = database.prepare('INSERT INTO music (title, stored_name, lyrics, timed_lyrics, lyrics_source, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(title, audio.filename, lyrics, JSON.stringify(timedLyrics), lyricsSource, audio.mimetype, new Date().toISOString());
    response.status(201).json({ id: result.lastInsertRowid });
  } catch (error) { fs.rmSync(audio.path, { force: true }); response.status(500).json({ error: '保存音乐失败' }); }
});

app.delete('/api/music/:id', requireAdmin, (request, response) => {
  const track = database.prepare('SELECT stored_name FROM music WHERE id = ?').get(request.params.id);
  if (!track) return response.sendStatus(404);
  database.prepare('DELETE FROM music WHERE id = ?').run(request.params.id);
  fs.rmSync(path.join(uploadDirectory, track.stored_name), { force: true });
  response.sendStatus(204);
});

app.use((error, _request, response, _next) => response.status(400).json({ error: error.message || '请求失败' }));
app.listen(port, () => console.log(`Photo wall is running at http://localhost:${port}`));

function parseLrc(content) {
  const lines = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const matches = [...rawLine.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g)];
    const text = rawLine.replace(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g, '').trim();
    for (const match of matches) lines.push({ time: Number(match[1]) * 60 + Number(match[2]), text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

function normalizeTakenAt(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.slice(0, 25);
}

function parseTimedLyrics(value) {
  try { return Array.isArray(JSON.parse(value || '[]')) ? JSON.parse(value || '[]') : []; }
  catch (_error) { return []; }
}