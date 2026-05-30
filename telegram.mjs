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
for (let i = 0; i < chunks.length; i++) {
  const res = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT,
      text: chunks[i],
      parse_mode: "HTML",
      disable_web_page_preview: true,
      disable_notification: i > 0, // only the first message pings
    }),
  });
  const j = await res.json();
  if (!j.ok) {
    console.error(`Telegram error on chunk ${i + 1}/${chunks.length}: ${JSON.stringify(j)}`);
    process.exit(1);
  }
}
console.error(`Sent ${chunks.length} message(s) to Telegram.`);
