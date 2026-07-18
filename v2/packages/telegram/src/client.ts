// Telegram Bot API client: retry/backoff, timeout, injectable fetch, and a
// no-credentials console fallback (v1 behavior) so dry runs never explode.

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
}

export function createDefaultTelegramConfig(
  overrides: Partial<TelegramConfig> = {},
): TelegramConfig {
  return {
    botToken: '',
    chatId: '',
    baseUrl: 'https://api.telegram.org',
    timeoutMs: 10_000,
    maxRetries: 3,
    retryBackoffMs: 1_000,
    ...overrides,
  };
}

export interface SendResult {
  ok: boolean;
  delivered: boolean; // false when falling back to console (no creds)
  error?: string;
}

export interface TelegramSender {
  send(html: string): Promise<SendResult>;
}

export class TelegramClient implements TelegramSender {
  private readonly config: TelegramConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (msg: string) => void;

  constructor(
    config?: Partial<TelegramConfig>,
    fetchImpl?: typeof fetch,
    log: (msg: string) => void = (m) => console.error(m),
  ) {
    this.config = createDefaultTelegramConfig(config);
    this.fetchImpl = fetchImpl ?? fetch;
    this.log = log;
  }

  async send(html: string): Promise<SendResult> {
    if (!this.config.botToken || !this.config.chatId) {
      this.log(html.replace(/<[^>]*>/g, ''));
      return { ok: true, delivered: false };
    }

    const url = `${this.config.baseUrl}/bot${this.config.botToken}/sendMessage`;
    let lastError = '';
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.config.chatId,
            text: html,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const body = (await res.json()) as { ok?: boolean; description?: string };
        if (res.ok && body.ok) return { ok: true, delivered: true };
        lastError = body.description ?? `HTTP ${res.status}`;
        // 429/5xx retry; 4xx (bad markup, bad chat) do not
        if (res.status !== 429 && res.status < 500) break;
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < this.config.maxRetries) {
        await new Promise((r) => setTimeout(r, this.config.retryBackoffMs * Math.pow(2, attempt)));
      }
    }
    return { ok: false, delivered: false, error: lastError };
  }
}
