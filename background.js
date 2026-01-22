// OpenSync Background Script
// Handles extension lifecycle and message passing

// Default server URL (change for production)
const DEFAULT_SERVER_URL = 'ws://localhost:3000';

// Extension state
let currentRoom = null;
let serverUrl = DEFAULT_SERVER_URL;

// Initialize extension
browser.runtime.onInstalled.addListener(() => {
  console.log('OpenSync extension installed');

  // Initialize storage with defaults
  browser.storage.local.set({
    serverUrl: DEFAULT_SERVER_URL,
    username: 'User_' + Math.random().toString(36).substring(2, 8)
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
