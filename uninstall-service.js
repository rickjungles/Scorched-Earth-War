const { Service } = require('node-windows');
const path = require('path');

const svc = new Service({
  name: 'nodejs_scorched',
  script: path.join(__dirname, 'server.js'),
});

svc.on('uninstall', () => console.log('Service "nodejs_scorched" uninstalled.'));
svc.uninstall();
