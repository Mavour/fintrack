module.exports = {
  apps: [
    {
      name: 'dompet-saya',
      cwd: __dirname,
      interpreter: process.execPath,
      script: 'dist/server/index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production', PORT: '3100', DATABASE_PATH: './data/app.db' },
    },
  ],
};
