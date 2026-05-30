# CT Cockpit — Telegram bot (Cloudflare Workers)

Webhook bot that drives the CT system from your phone. Instant commands hit
Hyperliquid/CoinGecko directly; `/digest` and `/scorecard` trigger the repo's
GitHub Actions workflows.

## One-time deploy

All commands run from this `bot/` folder.

1. **Cloudflare account** — free, at dash.cloudflare.com (skip if you have one).

2. **GitHub token** for `/digest` `/scorecard` — create a fine-grained PAT
   (github.com/settings/personal-access-tokens) scoped to the `ct-newsletter`
   repo with **Actions: Read and write**. Copy it.

3. **Log in & set secrets:**
   ```sh
   npx wrangler login
   npx wrangler secret put TELEGRAM_BOT_TOKEN   # the bot token
   npx wrangler secret put TELEGRAM_CHAT_ID      # your chat id (1749416631)
   npx wrangler secret put WEBHOOK_SECRET        # any random string you make up
   npx wrangler secret put GITHUB_TOKEN          # the PAT from step 2
   ```

4. **Deploy** → prints your worker URL (`https://ct-bot.<sub>.workers.dev`):
   ```sh
   npx wrangler deploy
   ```

5. **Point Telegram at it** (use the same WEBHOOK_SECRET):
   ```sh
   curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -d url="https://ct-bot.<sub>.workers.dev" \
     -d secret_token="<WEBHOOK_SECRET>"
   ```

Done. Message the bot `/help`.

## Notes
- Only your `TELEGRAM_CHAT_ID` can use the bot; others are ignored.
- `npx wrangler tail` streams live logs for debugging.
- To add commands, edit `src/index.js` and `npx wrangler deploy` again.
- Keep `WALLETS` in `src/index.js` in sync with `../wallets.json` until `/track` lands.
