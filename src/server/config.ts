export interface SeedWallet {
  label: string;
  address: string;
}

export function parseSeedWallets(raw: string | undefined): SeedWallet[] {
  if (!raw || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((w): w is SeedWallet => typeof w === 'object' && w !== null)
      .map((w) => ({ label: String((w as { label?: unknown }).label ?? ''), address: String((w as { address?: unknown }).address ?? '') }))
      .filter((w) => w.address.length > 0);
  } catch {
    return [];
  }
}

/** Tier refresh seconds with floor: values below min are clamped, never too aggressive. */
export function tierSec(raw: string | undefined, def: number, min = 10): number {
  const v = Number(raw ?? def);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.max(min, Math.floor(v));
}

export function getConfig() {
  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '0.0.0.0',
    databasePath: process.env.DATABASE_PATH ?? './data/app.db',
    sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret-change-me-32chars!!',
    appPassword: process.env.APP_PASSWORD ?? '',
    nodeEnv: process.env.NODE_ENV ?? 'development',
    coingeckoApiKey: process.env.COINGECKO_API_KEY ?? '',
    etherscanApiKey: process.env.ETHERSCAN_API_KEY ?? '',
    binanceEnabled: (process.env.BINANCE_ENABLED ?? 'true') === 'true',
    yahooEnabled: (process.env.YAHOO_ENABLED ?? 'true') === 'true',
    fxCacheTtlMs: Number(process.env.FX_CACHE_TTL_MS ?? 3_600_000),
    backupDir: process.env.BACKUP_DIR ?? './backups',
    backupRetentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? 14),
    // --- Wallet tracker (read-only) ---
    seedWallets: parseSeedWallets(process.env.SEED_WALLETS),
    jupiterApiKey: process.env.JUPITER_API_KEY ?? '',
    debankAccessKey: process.env.DEBANK_ACCESS_KEY ?? '',
    debankDailyUnitBudget: Number(process.env.DEBANK_DAILY_UNIT_BUDGET ?? 0),
    solanaRpcUrl: process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
    walletSolanaCron: process.env.WALLET_SOLANA_CRON ?? '*/5 * * * *',
    walletEvmCron: process.env.WALLET_EVM_CRON ?? '*/10 * * * *',
    walletSyncCooldownMs: Number(process.env.WALLET_SYNC_COOLDOWN_MS ?? 30_000),
    meteoraDlmmBase: process.env.METEORA_DLMM_BASE ?? 'https://dlmm.datapi.meteora.ag',
    meteoraDammV2Base: process.env.METEORA_DAMM_V2_BASE ?? 'https://damm-v2.datapi.meteora.ag',
    // --- Tiered near-real-time sync (detik, min 10) ---
    priceRefreshSec: tierSec(process.env.PRICE_REFRESH_SEC, 15),
    lpRefreshSec: tierSec(process.env.LP_REFRESH_SEC, 15),
    solRefreshSec: tierSec(process.env.SOL_REFRESH_SEC, 15),
    evmRefreshSec: tierSec(process.env.EVM_REFRESH_SEC, 15),
  };
}

export function tierMinSec(): number {
  return 10;
}

export type AppConfig = ReturnType<typeof getConfig>;
