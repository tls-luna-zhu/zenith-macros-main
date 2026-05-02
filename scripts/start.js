const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');

const child = spawn('npx', ['tauri', 'dev'], {
  stdio: 'inherit',
  cwd: root,
  shell: true,
  env: {
    ...process.env,
    ZENITH_DEV_AUTH: process.env.ZENITH_DEV_AUTH || 'true',
    ZENITH_LICENSE_API: process.env.ZENITH_LICENSE_API || 'http://127.0.0.1:5000',
  },
});

child.on('exit', (code) => process.exit(code ?? 0));
