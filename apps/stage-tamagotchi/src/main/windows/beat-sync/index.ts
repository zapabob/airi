import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { initScreenCaptureForWindow } from '@proj-airi/electron-screen-capture/main'
import { BrowserWindow } from 'electron'

import { baseUrl, getElectronMainDirname, load } from '../../libs/electron/location'
import { protectPrivilegedWindowNavigation } from '../shared/window'

export async function setupBeatSync() {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), '../preload/beat-sync.mjs'),
      sandbox: false,
    },
  })

  protectPrivilegedWindowNavigation(window)

  // NOTICE: BeatSync is a background capture window. Its renderer can take a long
  // time to finish loading, and blocking DI here prevents the user-facing window
  // from being created. Keep the window handle available immediately and surface
  // asynchronous navigation failures through the main-process logger.
  void load(window, baseUrl(resolve(getElectronMainDirname(), '..', 'renderer'), 'beat-sync.html'))
    .catch(error => console.error('[BeatSync] Failed to load renderer:', error))

  initScreenCaptureForWindow(window)

  return window
}
