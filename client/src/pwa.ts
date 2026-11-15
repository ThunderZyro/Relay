type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

let deferredInstallPrompt: InstallPromptEvent | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event as InstallPromptEvent;
    window.dispatchEvent(new Event('relay:install-available'));
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    window.dispatchEvent(new Event('relay:install-available'));
  });
}

export function hasRelayInstallPrompt() {
  return deferredInstallPrompt !== null;
}

export async function promptRelayInstall() {
  const prompt = deferredInstallPrompt;
  if (!prompt) return null;
  deferredInstallPrompt = null;
  window.dispatchEvent(new Event('relay:install-available'));
  await prompt.prompt();
  const choice = await prompt.userChoice;
  window.dispatchEvent(new Event('relay:install-available'));
  return choice;
}
