// Stáhne zprávy z Discord kanálu a uloží je do news.json (+ obrázky do news-img/).
// Spouští se v GitHub Actions, nepotřebuje žádné npm balíčky (Node 20+).

import { mkdir, readFile, writeFile, readdir, unlink, access } from 'node:fs/promises';
import path from 'node:path';

const { DISCORD_TOKEN, DISCORD_CHANNEL_ID, ALLOWED_AUTHOR_IDS = '' } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID) {
  console.error('Chybí DISCORD_TOKEN nebo DISCORD_CHANNEL_ID (nastav je v GitHub Secrets).');
  process.exit(1);
}

const MAX_NEWS = 20; // kolik nejnovějších aktualit se zobrazí
const IMG_DIR = 'news-img';
const allowed = ALLOWED_AUTHOR_IDS.split(',').map(s => s.trim()).filter(Boolean);

// --- Stažení zpráv z kanálu ---
const res = await fetch(
  `https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages?limit=50`,
  { headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'User-Agent': 'DiscordBot (liberec-omsi-web, 1.0)' } }
);

if (!res.ok) {
  console.error(`Discord API vrátilo ${res.status}: ${await res.text()}`);
  if (res.status === 401) console.error('-> Špatný token bota.');
  if (res.status === 403) console.error('-> Bot nemá přístup ke kanálu (View Channel + Read Message History).');
  if (res.status === 404) console.error('-> Špatné ID kanálu, nebo bot není na serveru.');
  process.exit(1);
}

const messages = await res.json(); // od nejnovější po nejstarší

// --- Pomocné funkce ---
function cleanText(t) {
  return t
    .replace(/<a?:\w+:\d+>/g, '')        // vlastní emoji
    .replace(/<@[!&]?\d+>/g, '')         // zmínky uživatelů a rolí
    .replace(/<#\d+>/g, '')              // zmínky kanálů
    .replace(/\r/g, '')
    .trim();
}

function cleanTitle(t) {
  return t.replace(/^#{1,3}\s*/, '').replace(/(\*\*|__)/g, '').trim();
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('cs-CZ', {
    timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric'
  });
}

async function exists(p) { try { await access(p); return true; } catch { return false; } }

await mkdir(IMG_DIR, { recursive: true });

// --- Převod zpráv na aktuality ---
const news = [];
const usedImages = new Set();

for (const m of messages) {
  if (news.length >= MAX_NEWS) break;
  if (m.author?.bot) continue;
  if (allowed.length && !allowed.includes(m.author.id)) continue;

  const content = cleanText(m.content || '');
  const img = (m.attachments || []).find(a => (a.content_type || '').startsWith('image/'));
  if (!content && !img) continue;

  const lines = content.split('\n');
  const title = cleanTitle(lines[0] || '') || 'Aktualita';
  const text = lines.slice(1).join('\n').trim();

  const item = { id: m.id, date: formatDate(m.timestamp), iso: m.timestamp, title, text };

  if (img) {
    const ext = (path.extname(img.filename || '').toLowerCase().replace(/[^.a-z0-9]/g, '')) || '.png';
    const file = `${m.id}${ext}`;
    const dest = path.join(IMG_DIR, file);
    try {
      if (!(await exists(dest))) {
        const r = await fetch(img.url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await writeFile(dest, Buffer.from(await r.arrayBuffer()));
      }
      item.image = `${IMG_DIR}/${file}`;
      usedImages.add(file);
    } catch (e) {
      console.warn(`Obrázek ke zprávě ${m.id} se nepodařilo stáhnout: ${e.message}`);
    }
  }
  news.push(item);
}

// --- Úklid nepoužitých obrázků ---
for (const f of await readdir(IMG_DIR)) {
  if (!usedImages.has(f) && f !== '.gitkeep') await unlink(path.join(IMG_DIR, f));
}
await writeFile(path.join(IMG_DIR, '.gitkeep'), '');

// --- Uložení news.json ---
const out = JSON.stringify(news, null, 2) + '\n';
let old = '';
try { old = await readFile('news.json', 'utf8'); } catch {}
if (out !== old) {
  await writeFile('news.json', out);
  console.log(`news.json aktualizován (${news.length} aktualit).`);
} else {
  console.log('Beze změny.');
}
