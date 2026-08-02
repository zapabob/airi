import { useChatSyncStore } from './chat-sync'

type ChatSyncWindowRole = 'authority' | 'follower' | 'client'

const AUTHORITY_FALLBACK_DELAY_MS = 5000

function normalizeRoutePath(routePath: string) {
  const [path = ''] = routePath.split(/[?#]/)
  return path || '/'
}

/**
 * Resolves hash routes before Vue Router hydrates `route.path`.
 */
export function resolveInitialChatSyncRoutePath(routePath: string, hash = globalThis.location?.hash ?? '') {
  const hashPath = hash.startsWith('#') ? hash.slice(1) : ''
  return normalizeRoutePath(hashPath || routePath)
}

function resolveChatSyncWindowRole(routePath: string): ChatSyncWindowRole | null {
  const path = normalizeRoutePath(routePath)
  if (path === '/')
    return 'authority'
  if (path === '/chat' || path === '/spotlight')
    return 'follower'
  if (path === '/settings' || path.startsWith('/settings/'))
    return 'client'
  return null
}

/**
 * Owns chat-sync BroadcastChannel lifecycle for one Electron renderer window.
 *
 * The role is captured from the initial window route and must be initialized
 * from the renderer root. Route pages should not dispose the channel because
 * in-window navigation can unmount them while the BrowserWindow is still alive.
 */
export function createChatSyncWindowLifecycle(routePath: string, hash?: string) {
  const chatSyncStore = useChatSyncStore()
  const role = resolveChatSyncWindowRole(resolveInitialChatSyncRoutePath(routePath, hash))
  let authorityFallbackTimer: ReturnType<typeof setTimeout> | undefined

  function clearAuthorityFallbackTimer() {
    if (authorityFallbackTimer) {
      clearTimeout(authorityFallbackTimer)
      authorityFallbackTimer = undefined
    }
  }

  return {
    role,
    initialize() {
      if (!role)
        return

      chatSyncStore.initialize(role)

      // In normal operation the main `/` window announces itself as the
      // authority. If that window failed to load, the standalone Chat window
      // would otherwise remain a follower forever and every request would
      // time out. Promote only when no authority announcement was observed;
      // this preserves the normal main-window authority path.
      if (role === 'follower') {
        clearAuthorityFallbackTimer()
        authorityFallbackTimer = setTimeout(() => {
          authorityFallbackTimer = undefined
          if (!chatSyncStore.authorityId)
            chatSyncStore.initialize('authority')
        }, AUTHORITY_FALLBACK_DELAY_MS)
      }
    },
    dispose() {
      clearAuthorityFallbackTimer()
      if (role)
        chatSyncStore.dispose()
    },
  }
}
