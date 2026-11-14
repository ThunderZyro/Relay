const owner = process.env.RELAY_GITHUB_OWNER || 'ThunderZyro';
const repo = process.env.RELAY_GITHUB_REPO || 'Relay';

module.exports = {
  appId: 'com.relay.platform',
  productName: 'Relay',
  executableName: 'Relay',
  directories: { app: '.', output: 'release/desktop' },
  files: [
    'desktop/main.cjs',
    'package.json',
    '!**/*.map'
  ],
  asar: true,
  npmRebuild: false,
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
