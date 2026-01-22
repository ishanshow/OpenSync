// OpenSync Protocol - Shared message definitions

const OpenSyncProtocol = {
    // Message types
    MessageType: {
        // Room management
        CREATE_ROOM: 'CREATE_ROOM',
        JOIN_ROOM: 'JOIN_ROOM',
        LEAVE_ROOM: 'LEAVE_ROOM',
        ROOM_CREATED: 'ROOM_CREATED',
        ROOM_JOINED: 'ROOM_JOINED',
        ROOM_LEFT: 'ROOM_LEFT',
        ROOM_ERROR: 'ROOM_ERROR',

        // Sync commands
        SYNC: 'SYNC',
        SYNC_REQUEST: 'SYNC_REQUEST',

        // Video control
        PLAY: 'PLAY',
        PAUSE: 'PAUSE',
        SEEK: 'SEEK',
        BUFFER: 'BUFFER',

        // Chat
        CHAT: 'CHAT',

        // Room info
        USER_JOINED: 'USER_JOINED',
        USER_LEFT: 'USER_LEFT',
        ROOM_STATE: 'ROOM_STATE'
    },

    // Create a message
    createMessage: function (type, payload = {}) {
        return {
            type: type,
            payload: payload,
            timestamp: Date.now()
        };
    },

    // Create sync state message
    createSyncState: function (state, isPlaying, currentTime, playbackRate = 1) {
        return this.createMessage(this.MessageType.SYNC, {
            state: state,
            isPlaying: isPlaying,
            currentTime: currentTime,
            playbackRate: playbackRate
        });
    },

    // Create chat message
    createChatMessage: function (username, text) {
        return this.createMessage(this.MessageType.CHAT, {
            username: username,
            text: text
        });
    },

    // Generate a random room code
    generateRoomCode: function () {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }
};

// Make it available globally
if (typeof window !== 'undefined') {
    window.OpenSyncProtocol = OpenSyncProtocol;
}

// For Node.js environment
if (typeof module !== 'undefined' && module.exports) {
    module.exports = OpenSyncProtocol;
}
