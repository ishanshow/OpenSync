// OpenSync Platform Controllers
// Platform-specific video detection and control logic for Netflix, Prime Video, and Hotstar

const OpenSyncPlatformControllers = (function () {
    'use strict';

    // Platform configurations with selectors and quirks
    const platforms = {
        netflix: {
            name: 'Netflix',
            hostnames: ['netflix.com', 'www.netflix.com'],
            videoSelectors: [
                '.watch-video--player-view video',
                'video.VideoPlayer',
                '.NFPlayer video',
                'video[src*="nflxvideo"]',
                'video'
            ],
            // Netflix uses shadow DOM in some cases
            useShadowDOM: true,
            // Netflix quirks: may need to wait for video to be "active"
            quirks: {
                waitForReady: true,
                minDuration: 30 // Only consider videos longer than 30s
            },
            // Netflix Bridge Control
            controls: {
                play: () => sendBridgeCommand('PLAY'),
                pause: () => sendBridgeCommand('PAUSE'),
                seek: (time) => sendBridgeCommand('SEEK', { time })
            },
            init: () => {
                injectInlineScript(`
                    // OpenSync Netflix Player Bridge (Inline)
                    try {
                        console.log('[OpenSync Bridge] Initializing Netflix Player Bridge...');
                        function getNetflixPlayer() {
                            try {
                                const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI()?.videoPlayer;
                                const sessionId = videoPlayer?.getAllPlayerSessionIds()[0];
                                return videoPlayer?.getVideoPlayerBySessionId(sessionId);
                            } catch (e) { return null; }
                        }
                        
                        window.addEventListener('message', function(event) {
                            if (event.source !== window || event.data.source !== 'OPENSYNC_CONTENT') return;
                            const player = getNetflixPlayer();
                            if (!player) return;
                            
                            const { type, payload } = event.data;
                            try {
                                switch (type) {
                                    case 'SEEK': player.seek(payload.time * 1000); break;
                                    case 'PLAY': player.play(); break;
                                    case 'PAUSE': player.pause(); break;
                                }
                            } catch (e) { console.error('[OpenSync Bridge] Error:', e); }
                        });
                        console.log('[OpenSync Bridge] Ready');
                        window.postMessage({ source: 'OPENSYNC_BRIDGE', type: 'READY' }, '*');
                    } catch(e) { console.error('[OpenSync Bridge] Init failed:', e); }
                `);
            }
        },

        primevideo: {
            name: 'Prime Video',
            hostnames: ['primevideo.com', 'www.primevideo.com', 'amazon.com', 'www.amazon.com'],
            videoSelectors: [
                '.webPlayerSDKContainer video',
                '#dv-web-player video',
                '.rendererContainer video',
                '.atvwebplayersdk-overlays-container ~ div video',
                '[data-testid="webPlayer"] video',
                'video'
            ],
            useShadowDOM: true,
            quirks: {
                waitForReady: true,
                checkVisibility: true
            }
        },

        hotstar: {
            name: 'Disney+ Hotstar',
            hostnames: ['hotstar.com', 'www.hotstar.com'],
            videoSelectors: [
                '.player-base video',
                '.shaka-video-container video',
                '.bmpui-ui-videocontainer video',
                '#bitmovinplayer-video-player video',
                'video[src]',
                'video'
            ],
            useShadowDOM: false,
            quirks: {
                waitForReady: true,
                checkVisibility: true
            }
        }
    };

    // Find video using platform-specific selectors
    function findVideoForPlatform(platform) {
        const config = platforms[platform];
        if (!config) {
            console.warn('[OpenSync] Unknown platform:', platform);
            return findGenericVideo();
        }

        console.log(`[OpenSync] Finding video for ${config.name}...`);

        // Try each selector in order
        for (const selector of config.videoSelectors) {
            // First try regular DOM
            let videos = document.querySelectorAll(selector);

            // Also search in shadow DOMs if enabled
            if (config.useShadowDOM) {
                videos = [...videos, ...findVideosInShadowDOM(selector)];
            }

            for (const video of videos) {
                if (isValidVideo(video, config.quirks)) {
                    console.log(`[OpenSync] Found ${config.name} video with selector: ${selector}`);
                    return video;
                }
            }
        }

        console.log(`[OpenSync] No valid video found for ${config.name}, falling back to generic`);
        return findGenericVideo();
    }

    // Search for videos inside shadow DOMs
    function findVideosInShadowDOM(selector) {
        const videos = [];
        const allElements = document.querySelectorAll('*');

        for (const el of allElements) {
            if (el.shadowRoot) {
                try {
                    const shadowVideos = el.shadowRoot.querySelectorAll(selector);
                    videos.push(...shadowVideos);

                    // Recursive shadow root search
                    const nestedElements = el.shadowRoot.querySelectorAll('*');
                    for (const nested of nestedElements) {
                        if (nested.shadowRoot) {
                            const nestedVideos = nested.shadowRoot.querySelectorAll(selector);
                            videos.push(...nestedVideos);
                        }
                    }
                } catch (e) {
                    // Access denied to shadow root
                }
            }
        }

        return videos;
    }

    // Validate if video element is suitable for sync
    function isValidVideo(video, quirks = {}) {
        if (!video) return false;

        // Check if video has a source
        if (!video.src && !video.querySelector('source') && !video.srcObject) {
            return false;
        }

        // Check visibility if required
        if (quirks.checkVisibility) {
            const rect = video.getBoundingClientRect();
            if (rect.width < 200 || rect.height < 100) {
                return false;
            }
        }

        // Check minimum duration if required
        if (quirks.minDuration && video.duration) {
            if (video.duration < quirks.minDuration) {
                return false;
            }
        }

        // Check if video is ready
        if (quirks.waitForReady) {
            // readyState >= 1 means metadata is loaded
            if (video.readyState < 1) {
                return false;
            }
        }

        return true;
    }

    // Generic video finder (fallback)
    function findGenericVideo() {
        const videos = document.querySelectorAll('video');

        for (const video of videos) {
            if (video.src || video.querySelector('source') || video.srcObject) {
                const rect = video.getBoundingClientRect();
                if (rect.width > 200 && rect.height > 100) {
                    return video;
                }
            }
        }

        return videos[0] || null;
    }

    // Detect platform from current URL
    function detectPlatform() {
        const hostname = window.location.hostname.toLowerCase();

        for (const [key, config] of Object.entries(platforms)) {
            if (config.hostnames.some(h => hostname.includes(h.replace('www.', '')))) {
                console.log(`[OpenSync] Auto-detected platform: ${config.name}`);
                return key;
            }
        }

        return null;
    }

    // Get platform config
    function getPlatformConfig(platform) {
        return platforms[platform] || null;
    }

    // Get platform display name
    function getPlatformName(platform) {
        return platforms[platform]?.name || 'Unknown';
    }

    // Check if current site matches selected platform
    function isOnCorrectPlatform(platform) {
        const config = platforms[platform];
        if (!config) return true; // Unknown platform, allow

        const hostname = window.location.hostname.toLowerCase();
        return config.hostnames.some(h => hostname.includes(h.replace('www.', '')));
    }

    return {
        findVideoForPlatform,
        detectPlatform,
        getPlatformConfig,
        getPlatformName,
        isOnCorrectPlatform,
        getController,
        platforms
    };

    // --- Helpers for Bridge Communication ---

    // Get controller for platform
    function getController(platform) {
        return platforms[platform];
    }

    // Inject a script into the page context (Inline fallback for Firefox)
    function injectInlineScript(code) {
        const script = document.createElement('script');
        script.textContent = code;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
        console.log(`[OpenSync] Injected inline bridge`);
    }

    // Inject a script into the page context (File based - kept for reference)
    function injectScript(path) {
        try {
            const script = document.createElement('script');
            script.src = browser.runtime.getURL(path);
            script.onload = () => script.remove();
            (document.head || document.documentElement).appendChild(script);
            console.log(`[OpenSync] Injected ${path}`);
        } catch (e) {
            console.error('[OpenSync] Injection failed:', e);
        }
    }

    // Send command to the page-level bridge
    function sendBridgeCommand(type, payload = {}) {
        window.postMessage({
            source: 'OPENSYNC_CONTENT',
            type,
            payload
        }, '*');
    }
})();

// Make available globally
window.OpenSyncPlatformControllers = OpenSyncPlatformControllers;
