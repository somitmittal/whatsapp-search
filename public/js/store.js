/** Shared mutable UI state. Modules read/write fields here instead of module-private variables. */
export const store = {
  ws: undefined,
  chatData: [],
  activeChat: null,
  connected: false,
  searchActive: false,
  /** Active AI search conversation id for follow-ups. */
  searchConversationId: null,
  chatMessagesOffset: 0,
  chatHasMoreLocal: true,
  chatLoadingOlder: false,
  chatOldestAnchorTs: null,
  chatPhoneFetchAttempted: false,
  /** Set when `openChat` used jump-to-message; disables scroll-older pagination. */
  activeFocusMessageId: null,
  /** @type {{ profile: string, businessName: string, prompts: Array<{label:string,query:string}> }} */
  smbState: { profile: 'personal', businessName: '', prompts: [] },
  cvTab: 'chat',
  attachmentsPayload: null,
  /**
   * Sidebar list: `imported` (uploaded archives), `chat` (live WA DMs + groups),
   * `feed` (Status, broadcasts, newsletters) or `business` (SMB inbox).
   */
  sidebarListTab: 'imported',
  /** Once the user picks a tab themselves, stop auto-selecting one when chats load. */
  sidebarTabPinnedByUser: false,
  /** Guards the one-time jump to the live tab when WhatsApp finishes linking. */
  _waTabPromotedOnConnect: false,
  /** Grouped `status@broadcast` stacks from `/api/wa/status-feed`. */
  statusFeedData: { peers: [] },
  /** @type {{ peerIdx: number, itemIdx: number }} */
  statusViewerState: { peerIdx: 0, itemIdx: 0 },
  /** Message id for status viewer reactions (`status@broadcast`). */
  currentStatusSlideMessageId: null,
  /** @type {{ messageId: string, preview: string } | null} */
  replyTarget: null,
  editTarget: null,
  forwardTarget: null, // { chatJid, messageId, preview }
  forwardSelected: new Set(),
  _pendingDeleteMsg: null,
  /** Snapshot retained after marking a chat seen while its unread summary finishes indexing. */
  awaySummarySnapshot: null,
  /** @type {Record<string, { pct: number, show: boolean }>} */
  summaryProgressByJid: {},
  /** Per-chat message counts during WhatsApp history sync (from server). */
  waSyncByChat: {},
  /** Whether DB holds a user API key (GET /api/settings — raw keys are never sent). */
  settingsKeyState: {
    hasLlm: false,
    hasSummary: false,
    hasMediaIndex: false,
    pendingClearLlm: false,
    pendingClearSummary: false,
    pendingClearMediaIndex: false,
  },
  _ctxMenuJid: null,
  // Tracked separately from _ctxMenuJid: the click that opens the confirm dialog keeps
  // bubbling to the document listener below, which closes the context menu and clears
  // _ctxMenuJid before the user can confirm.
  _pendingDeleteJid: null,
  expenseRuns: [],
  _lastSeenMsgCount: 0,
  _waState: 'DISCONNECTED',
  _waLoggedOut: false,
  _waStateResolved: false,
  _waNeedsRelogin: false,
  _waHasEverConnected: false,
  _qrPollTimer: null,
  _lastQrDataUrl: null,
  _importFirstMvp: true,
  _waLiveSyncAutoConnect: false,
  // Live sync UI: import-first / desktop default off; web default on unless user hid it.
  _showLiveSyncUi: false,
  _archiveChatCount: 0,
  _archiveMessageCount: 0,
  isDesktopApp: undefined, // set in wa-connection.js init()
  _lastQrSeenAt: 0,
  _lastQrNudgeAt: 0,
  _syncChipPhase: null,
  /**
   * Single-flight: overlapping callers share one fetch, and a call that arrives mid-flight
   * schedules exactly one follow-up so its newer state is not lost. Without this, parallel
   * responses could land out of order and repaint the sidebar with stale data.
   */
  _refreshDashInFlight: null,
  _refreshDashQueued: false,
  /**
   * `toLocale*String(locale, opts)` builds a new Intl.DateTimeFormat on every call, which
   * dominated sidebar and chat render time. Same locale + options → identical output.
   */
  _dateFormatters: undefined,
  _refreshDashTimer: null,
  _waContactsCache: [],
  /** @type {Map<string, { chatJid: string, chatName: string, phone?: string|null }>} */
  _newGroupSelected: new Map(),
  /**
   * Sidebar rows keyed by JID. Rows whose markup did not change keep their DOM node, so a
   * live refresh mid-click cannot swap the element under the pointer (which silently drops
   * the click) and avatar <img>s are not torn down and re-requested.
   */
  _chatRowCache: undefined,
  cvOlderScrollArmed: true,
  /** JID of the just-imported chat — prevents background WA events from clearing the active chat. Reset on page reload. */
  _justImportedJid: null,
  _hwRecCache: null,
  _hwRecFetching: false,
  obOllamaRec: null,
  obOllamaPullTimer: null,
  obStep: 0,
  pullPollTimer: null,
};
