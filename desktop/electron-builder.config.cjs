const owner = process.env.RELAY_GITHUB_OWNER || 'CHANGE_ME_GITHUB_OWNER';
const repo = process.env.RELAY_GITHUB_REPO || 'relay-platform';

module.exports = {
  appId: 'com.relay.platform',
  productName: 'Relay',
  executableName: 'Relay',
  directories: { output: 'release/desktop' },
  files: [
    'desktop/main.cjs',
    'package.json'
  ],
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
