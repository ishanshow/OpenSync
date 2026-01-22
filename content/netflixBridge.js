// OpenSync Netflix Player Bridge
// Injected into the MAIN world to access Netflix's internal Player API

(function () {
    console.log('[OpenSync Bridge] Initializing Netflix Player Bridge...');

    // Locate the Netflix Player API
    function getNetflixPlayer() {
        try {
            const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI()?.videoPlayer;
            const sessionId = videoPlayer?.getAllPlayerSessionIds()[0];
            return videoPlayer?.getVideoPlayerBySessionId(sessionId);
        } catch (e) {
            return null;
        }
    }

    // Command handlers
    function handleCommand(event) {
        // Only accept messages from the content script (same window)
        if (event.source !== window || event.data.source !== 'OPENSYNC_CONTENT') return;

        const player = getNetflixPlayer();
        if (!player) {
            console.warn('[OpenSync Bridge] Netflix player not found');
            return;
        }

        const { type, payload } = event.data;

        try {
            switch (type) {
                case 'SEEK':
                    console.log('[OpenSync Bridge] Seeking to', payload.time);
                    player.seek(payload.time * 1000); // Netflix uses milliseconds
                    break;
                case 'PLAY':
                    console.log('[OpenSync Bridge] Playing');
                    player.play();
                    break;
                case 'PAUSE':
                    console.log('[OpenSync Bridge] Pausing');
                    player.pause();
                    break;
            }
        } catch (e) {
            console.error('[OpenSync Bridge] Command error:', e);
        }
    }

    // Listen for commands
    window.addEventListener('message', handleCommand);

    console.log('[OpenSync Bridge] Ready');
})();
