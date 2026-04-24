module.exports = {
  apps: [
    {
      name: 'botwa',
      script: 'index.js',
      watch: false, // Disarankan false untuk kestabilan tinggi
      ignore_watch: ['node_modules', 'auth', 'downloads'],
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      },
      // Menunda restart otomatis jika bot crash terlalu cepat
      exp_backoff_restart_delay: 100
    }
  ]
};
