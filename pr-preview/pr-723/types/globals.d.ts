// Ambient APIs the page relies on that TypeScript's DOM lib does not know.
// Only what `// @ts-check`ed files touch; widen as more files opt in.

interface Navigator {
  /** WebHID (Chromium). */
  hid?: {
    getDevices(): Promise<any[]>;
    requestDevice(opts: { filters: any[] }): Promise<any[]>;
    addEventListener(type: 'connect' | 'disconnect', cb: (e: any) => void): void;
    removeEventListener(type: 'connect' | 'disconnect', cb: (e: any) => void): void;
  };
}

interface Window {
  /** Steamworks bridge from electron/preload.js (desktop builds only). */
  steam?: any;
  /** Overlay / desktop preload bridge. */
  electronAPI?: any;
  /** js/game.js publishes the live Game for smoke tests and the console. */
  _game?: any;
}

/** Google Identity Services, loaded from accounts.google.com/gsi/client. */
declare const google: any;
/** qrcode-generator global (unpkg). */
declare function qrcode(typeNumber: number, errorCorrectionLevel: string): any;
/** PeerJS global (unpkg). */
declare const Peer: any;
