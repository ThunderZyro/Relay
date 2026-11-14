const fs = require('node:fs');
const path = require('node:path');

const owner = process.env.RELAY_GITHUB_OWNER || 'ThunderZyro';
const repo = process.env.RELAY_GITHUB_REPO || 'Relay';

module.exports = {
  appId: 'com.relay.platform',
  productName: 'Relay',
  executableName: 'Relay',
  // Pin the app directory to the repository root.
  directories: { app: '.', output: 'release/desktop' },
  files: [
    '**/*',
    '!desktop-runtime/**',
    '!desktop-stage/**',
    '!release/**',
    '!**/*.map'
  ],
  // electron-builder is currently omitting the root manifest from
  // resources/app even though it is present in the source tree. Restore it
  // after the app files are copied and before installer generation.
  afterPack: async (context) => {
    if (context.electronPlatformName !== 'win32') return;
    const appDir = path.join(context.appOutDir, 'resources', 'app');
    const sourceManifest = path.resolve(__dirname, '..', 'package.json');
    const targetManifest = path.join(appDir, 'package.json');
    if (!fs.existsSync(sourceManifest)) {
      throw new Error(`Relay app manifest source is missing: ${sourceManifest}`);
    }
    fs.mkdirSync(appDir, { recursive: true });
    fs.copyFileSync(sourceManifest, targetManifest);
    if (!fs.existsSync(targetManifest)) {
      throw new Error(`Relay app manifest was not staged: ${targetManifest}`);
    }
    console.log(`Staged Electron app manifest: ${targetManifest}`);
  },
  extraResources: [
    { from: 'desktop-runtime/node.exe', to: 'runtime/node.exe' },
    { from: 'desktop-stage/node_modules', to: 'relay/node_modules' },
    { from: 'package.json', to: 'relay/package.json' },
    { from: 'client/dist', to: 'relay/client/dist' },
    { from: 'server/dist', to: 'relay/server/dist' },
    { from: 'server/migrations', to: 'relay/server/migrations' }
  ],
  asar: false,
  npmRebuild: false,
  nativeRebuilder: 'legacy',
  nodeGypRebuild: false,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'Relay-Setup-${version}.${ext}'
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Relay',
    differentialPackage: true,
    uninstallDisplayName: 'Relay',
    runAfterFinish: true
  },
  publish: [{
    provider: 'github',
    owner,
    repo,
    releaseType: 'release'
  }]
};
