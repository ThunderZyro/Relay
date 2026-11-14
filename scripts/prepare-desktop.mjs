if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('Build the Windows Relay installer on Windows x64.');
  process.exit(1);
}
console.log('No local server, database, or Node runtime needs to be bundled. Relay Desktop connects to the shared hosted service.');
