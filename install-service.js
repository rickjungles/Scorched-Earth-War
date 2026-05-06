const { Service } = require('node-windows');
const path = require('path');

const svc = new Service({
  name: 'nodejs_scorched',
  description: 'Scorched Earth multiplayer WebSocket server',
  script: path.join(__dirname, 'server.js'),
});

svc.on('install', () => {
  svc.start();
  console.log('Service "nodejs_scorched" installed and started.');
});
svc.on('alreadyinstalled', () => console.log('Service "nodejs_scorched" is already installed.'));
svc.install();
