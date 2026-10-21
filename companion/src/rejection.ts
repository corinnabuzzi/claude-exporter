import type { Rejection } from './hub.ts';

export const RELEASES_URL = 'https://github.com/corinnabuzzi/claude-exporter/releases';

// what the user should do about a refused connection; null when there's nothing to do
export function explainRejection(rejection: Rejection): string | null {
  switch (rejection.kind) {
    // a web page probing localhost: blocked, and not the user's problem
    case 'origin':
      return null;
    case 'token':
      return `${rejection.browser} tried to connect with a different pairing token. Paste this program's token into the extension popup.`;
    case 'protocol':
      return rejection.theirs > rejection.ours
        ? `The extension in ${rejection.browser} is newer than this program. Download the latest program: ${RELEASES_URL}`
        : `The extension in ${rejection.browser} is older than this program. Update the extension, then reopen its popup.`;
  }
}
