module.exports = {
  apps: [
    {
      name: 'dompet-saya',
      script: 'dist/server/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
    },
  ],
};
