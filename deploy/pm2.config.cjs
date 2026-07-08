const path = require('node:path')

module.exports = {
  apps: [
    {
      name: 'ai-cli-hub',
      cwd: path.resolve(__dirname, '..'),
      script: 'bun',
      args: 'run start',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
