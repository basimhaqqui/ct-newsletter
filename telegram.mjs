// Sends digest.html (Telegram-flavored HTML) to a Telegram chat via the Bot API.
// Splits on blank-line boundaries to respect Telegram's 4096-char/message limit.
// Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node telegram.mjs

import { readFile } from "node:fs/promises";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const FILE = process.env.DIGEST_FILE || "digest.html";

if (!TOKEN || !CHAT) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.");
  process.exit(1);
}

const text = (await readFile(FILE, "utf8")).trim();
if (!text) {
  console.error(`${FILE} is empty — nothing to send.`);
  process.exit(1);
}

// Pack paragraphs into <=3800-char chunks (headroom under the 4096 limit).
const LIMIT = 3800;
const blocks = text.split(/\n\s*\n/);
const chunks = [];
let cur = "";
for (const b of blocks) {
  if ((cur + "\n\n" + b).length > LIMIT && cur) {
    chunks.push(cur);
    cur = b;
  } else {
    cur = cur ? cur + "\n\n" + b : b;
  }
}
if (cur) chunks.push(cur);

const api = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
const send = (body) => fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

let failed = 0;
for (let i = 0; i < chunks.length; i++) {
  const base = { chat_id: CHAT, disable_web_page_preview: true, disable_notification: i > 0 };
  let j = await send({ ...base, text: chunks[i], parse_mode: "HTML" });
  if (!j.ok) {
    // Summarizer occasionally emits malformed HTML (unclosed tag) → Telegram 400.
    // Resend as plain text (tags stripped) so the digest always lands.
    console.error(`HTML send failed on chunk ${i + 1} (${j.description}); retrying as plain text.`);
    j = await send({ ...base, text: chunks[i].replace(/<[^>]+>/g, "") });
  }
  if (!j.ok) { console.error(`Telegram error on chunk ${i + 1}/${chunks.length}: ${JSON.stringify(j)}`); failed++; }
}
if (failed) process.exit(1);
console.error(`Sent ${chunks.length} message(s) to Telegram.`);
