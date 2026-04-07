// OpenSync Background Script
// Handles extension lifecycle and message passing

// Default server URL (change for production)
const DEFAULT_SERVER_URL = 'wss://opensync.onrender.com';

// Extension state
let currentRoom = null;
let serverUrl = DEFAULT_SERVER_URL;

const KEEPALIVE_ALARM = 'opensync-server-keepalive';

function getHealthUrl(wsUrl) {
  return (wsUrl || DEFAULT_SERVER_URL)
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://') + '/health';
}

function preWarmServer() {
  browser.storage.local.get('serverUrl').then(data => {
    const url = getHealthUrl(data.serverUrl);
    console.log('[OpenSync] Pre-warming server:', url);
    fetch(url).catch(() => {});
  });
}

// Pre-warm on browser startup and extension install so the server is ready by
// the time the user needs it (Render free tier takes ~3 min to cold-start)
browser.runtime.onStartup.addListener(preWarmServer);

// Initialize extension
browser.runtime.onInstalled.addListener(() => {
  console.log('OpenSync extension installed');

  browser.storage.local.get(['serverUrl', 'username']).then(existing => {
    const defaults = {};
    if (!existing.serverUrl) defaults.serverUrl = DEFAULT_SERVER_URL;
    if (Object.keys(defaults).length > 0) {
      browser.storage.local.set(defaults);
    }
  });

  preWarmServer();
});

// Periodic keepalive: ping /health every 10 min while a room is active
// to prevent Render from putting the server to sleep
browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 10 });

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  browser.storage.local.get(['opensync_room', 'serverUrl']).then(data => {
    if (data.opensync_room) {
      fetch(getHealthUrl(data.serverUrl)).catch(() => {});
    }
  });
});

// Handle messages from popup and content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_STATE':
      // Return current extension state
      browser.storage.local.get(['serverUrl', 'username', 'currentRoom']).then(data => {
        sendResponse({
          serverUrl: data.serverUrl || DEFAULT_SERVER_URL,
          username: data.username,
          currentRoom: data.currentRoom || null
        });
      });
      return true; // Keep channel open for async response

    case 'SET_ROOM':
      // Update current room in storage
      browser.storage.local.set({ currentRoom: message.room });
      currentRoom = message.room;
      sendResponse({ success: true });
      return true;

    case 'LEAVE_ROOM':
      browser.storage.local.remove('currentRoom');
      browser.storage.local.remove(['opensync_room', 'opensync_redirect', 'opensync_just_switched_url', 'opensync_sync_time']);
      currentRoom = null;
      sendResponse({ success: true });
      return true;

    case 'GET_ACTIVE_TAB':
      // Get current active tab info
      browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
        const tab = tabs[0];
        sendResponse({
          tabId: tab ? tab.id : null,
          url: tab ? tab.url : null
        });
      });
      return true;

    case 'UPDATE_SERVER_URL':
      serverUrl = message.serverUrl;
      browser.storage.local.set({ serverUrl: message.serverUrl });
      sendResponse({ success: true });
      return true;

    default:
      console.log('Unknown message type:', message.type);
      return false;
  }
});

console.log('OpenSync background script loaded');
