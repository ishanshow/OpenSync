// OpenSync Background Script
// Handles extension lifecycle and message passing

// Default server URL (change for production)
const DEFAULT_SERVER_URL = 'wss://opensync.onrender.com';

// Extension state
let currentRoom = null;
let serverUrl = DEFAULT_SERVER_URL;

// Initialize extension
browser.runtime.onInstalled.addListener(() => {
  console.log('OpenSync extension installed');

  // Only set defaults for values that don't already exist
  browser.storage.local.get(['serverUrl', 'username']).then(existing => {
    const defaults = {};
    if (!existing.serverUrl) defaults.serverUrl = DEFAULT_SERVER_URL;
    // Don't set a default username here -- let the popup onboarding handle it
    if (Object.keys(defaults).length > 0) {
      browser.storage.local.set(defaults);
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
      // Clear room from storage
      browser.storage.local.remove('currentRoom');
      browser.storage.local.remove(['opensync_room', 'opensync_redirect', 'opensync_just_switched_url', 'opensync_sync_time']);
      currentRoom = null;
      // Broadcast to ALL tabs so the correct content script disconnects
      browser.tabs.query({}).then(tabs => {
        for (const tab of tabs) {
          browser.tabs.sendMessage(tab.id, { type: 'ROOM_LEFT' }).catch(() => {});
        }
      });
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
