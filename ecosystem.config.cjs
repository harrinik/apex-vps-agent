// PM2 Ecosystem Config — production cluster with graceful reload
module.exports = {
  apps: [
    {
      name:             'apex-vps-agent',
      script:           'dist/index.js',
      instances:        1,           // 1 per VPS — this is a system daemon, not a web server
      exec_mode:        'fork',
      watch:            false,
      max_memory_restart: '512M',
      restart_delay:    5000,        // 5s between restarts
      max_restarts:     10,
      min_uptime:       '30s',

      // Graceful shutdown
      kill_timeout:     15000,       // Give 15s to drain queue before SIGKILL
      listen_timeout:   10000,

      env_production: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
      env_development: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
      },

      // Log management
      out_file:    '/var/log/apex-vps-agent/out.log',
      error_file:  '/var/log/apex-vps-agent/error.log',
      merge_logs:  true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};