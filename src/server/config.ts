export function getConfig() {
  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '0.0.0.0',
    databasePath: process.env.DATABASE_PATH ?? './data/app.db',
    sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret-change-me-32chars!!',
    appPassword: process.env.APP_PASSWORD ?? '',
    nodeEnv: process.env.NODE_ENV ?? 'development',
    coingeckoApiKey: process.env.COINGECKO_API_KEY ?? '',
    binanceEnabled: (process.env.BINANCE_ENABLED ?? 'true') === 'true',
    yahooEnabled: (process.env.YAHOO_ENABLED ?? 'true') === 'true',
    fxCacheTtlMs: Number(process.env.FX_CACHE_TTL_MS ?? 3_600_000),
    backupDir: process.env.BACKUP_DIR ?? './backups',
    backupRetentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? 14),
  };
}

export type AppConfig = ReturnType<typeof getConfig>;
