/**
 * EvaraTap Secure Backend for Blynk on Render - v3.0 (Professional Refactor)
 *
 * A robust Node.js backend for the EvaraTap IoT dashboard. This version
 * transitions from automatic idle-polling to a manual, on-demand reconnect
 * system, providing greater control and clear real-time feedback to the user.
 *
 * REFACTORED FOR:
 * 1. Modularity: Code is organized into logical services (Config, State, Blynk, WebSocket, Polling).
 * 2. Maintainability: Centralized configuration and state are easy to manage.
 * 3. Robustness: Added network timeouts and clearer error handling paths.
 * 4. Readability: JSDoc comments and a clean structure make the logic easy to follow.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { WebSocketServer, WebSocket } from 'ws';

// --- UTILITIES (Simple Logger for Clarity) ---
const logger = {
    info: (message) => console.log(`[INFO] ${message}`),
    error: (message) => console.error(`\x1b[31m[ERROR] ${message}\x1b[0m`),
    success: (message) => console.log(`\x1b[32m[SUCCESS] ${message}\x1b[0m`),
    warn: (message) => console.log(`\x1b[33m[WARN] ${message}\x1b[0m`),
};

// --- CENTRALIZED CONFIGURATION ---
const CONFIG = {
    PORT: process.env.PORT || 10000,
    BLYNK_AUTH_TOKEN: process.env.BLYNK_AUTH_TOKEN,
    BLYNK_API_BASE: 'https://blynk.cloud/external/api',

    POLLING_RATE_MS: 1500,              // Continuous polling at 1.5 seconds when online
    RECONNECT_POLL_INTERVAL_MS: 2000,   // Poll every 2 seconds during manual reconnect
    RECONNECT_POLL_COUNT: 5,            // Number of consecutive polls during reconnect
    RECONNECT_COOLDOWN_MS: 10000,       // 10 second cooldown between reconnect attempts
    STALE_POLL_THRESHOLD: 3,            // Mark offline after 3 consecutive stale polls
    API_TIMEOUT_MS: 3000,               // Timeout for Blynk API calls

    VIRTUAL_PINS_TO_POLL: ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'],
};

// --- CENTRALIZED APPLICATION STATE ---
const state = {
    deviceDataCache: {},
    lastUptimeValue: -1,
    isDeviceOnline: false, // Start as offline
    consecutiveStalePolls: 0,
    pollingTimeoutId: null,
    isReconnecting: false,
    lastReconnectTime: 0,
};

// --- BLYNK API SERVICE ---
const BlynkService = {
    /**
     * Fetches the latest data for all monitored virtual pins from the Blynk API.
     * @returns {Promise<object>} A promise that resolves with the pin data.
     */
    async getPinData() {
        const pinParams = CONFIG.VIRTUAL_PINS_TO_POLL.map(pin => `pin=${pin}`).join('&');
        const url = `${CONFIG.BLYNK_API_BASE}/get?token=${CONFIG.BLYNK_AUTH_TOKEN}&${pinParams}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);

        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Blynk API Error ${response.status}: ${errorText}`);
            }
            return await response.json();
        } finally {
            clearTimeout(timeoutId);
        }
    },

    /**
     * Sends an update command to a specific virtual pin.
     * @param {string} pin The virtual pin to update (e.g., 'v10').
     * @param {string|number} value The value to set.
     */
    async updatePin(pin, value) {
        const url = `${CONFIG.BLYNK_API_BASE}/update?token=${CONFIG.BLYNK_AUTH_TOKEN}&${pin}=${value}`;
        const response = await fetch(url);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Blynk API Error ${response.status}: ${errorText}`);
        }
        logger.success(`Command sent: Set ${pin} to ${value}`);
        return await response.text();
    }
};

// --- WEBSOCKET MANAGER ---
const WebSocketManager = {
    wss: null,
    initialize(server) {
        this.wss = new WebSocketServer({ server });
        this.wss.on('connection', this.handleConnection);
        logger.success('WebSocket server initialized.');
    },

    handleConnection(ws) {
        logger.info(`Client connected. Total clients: ${WebSocketManager.wss.clients.size}`);
        ws.send(JSON.stringify({
            type: 'initial-state',
            payload: {
                data: state.deviceDataCache,
                online: state.isDeviceOnline,
                isReconnecting: state.isReconnecting,
            },
        }));
        ws.on('close', () => logger.info(`Client disconnected. Total clients: ${WebSocketManager.wss.clients.size}`));
        ws.on('error', (err) => logger.error(`WebSocket client error: ${err.message}`));
    },

    /**
     * Broadcasts a message to all connected clients.
     * @param {object} messageObject The data object to send.
     */
    broadcast(messageObject) {
        if (!this.wss) return;
        const message = JSON.stringify(messageObject);
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    },

    broadcastDataUpdate(data) {
        state.deviceDataCache = data;
        logger.info(`Broadcasting data update to ${this.wss.clients.size} client(s)`);
        this.broadcast({ type: 'data-update', payload: data });
    },

    broadcastStatus(status) { // status is 'online' or 'offline'
        this.broadcast({ type: 'status-update', payload: { online: status === 'online' } });
    },

    broadcastReconnectStatus(status, currentAttempt, totalAttempts) {
        this.broadcast({
            type: 'reconnect-status',
            payload: { status, currentAttempt, totalAttempts },
        });
    }
};

// --- POLLING & RECONNECT SERVICE ---
const PollingService = {
    /** The main polling loop that runs when the device is considered online. */
    async runOnlinePollingCycle() {
        clearTimeout(state.pollingTimeoutId);

        try {
            const newData = await BlynkService.getPinData();
            const currentUptime = parseInt(newData.v5) || 0;

            if (currentUptime !== undefined && state.lastUptimeValue === currentUptime) {
                state.consecutiveStalePolls++;
                if (state.consecutiveStalePolls >= CONFIG.STALE_POLL_THRESHOLD) {
                    if (state.isDeviceOnline) {
                        logger.warn('Stale data detected. ESP32 appears to be OFFLINE.');
                        logger.info('🔴 Automatic polling stopped. Awaiting manual reconnect.');
                        state.isDeviceOnline = false;
                        WebSocketManager.broadcastStatus('offline');
                    }
                    return; // Stop the polling loop
                }
                WebSocketManager.broadcastDataUpdate(newData);
            } else {
                state.consecutiveStalePolls = 0;
                if (!state.isDeviceOnline) {
                    logger.success('Fresh data detected! ESP32 is back ONLINE.');
                    logger.info('🚀 Resuming continuous polling.');
                    WebSocketManager.broadcastStatus('online');
                }
                state.isDeviceOnline = true;
                state.lastUptimeValue = currentUptime;
                WebSocketManager.broadcastDataUpdate(newData);
            }
        } catch (error) {
            logger.error(`Polling Error: ${error.message}`);
            if (state.isDeviceOnline) {
                state.isDeviceOnline = false;
                WebSocketManager.broadcastStatus('offline');
            }
            return; // Stop the polling loop
        }

        if (state.isDeviceOnline) {
            state.pollingTimeoutId = setTimeout(this.runOnlinePollingCycle.bind(this), CONFIG.POLLING_RATE_MS);
        }
    },

    /** Initiates a sequence of manual polls to find a device. */
    async initiateManualReconnect() {
        logger.info(`Starting manual reconnect sequence (${CONFIG.RECONNECT_POLL_COUNT} polls)...`);
        state.isReconnecting = true;
        WebSocketManager.broadcastReconnectStatus('reconnecting', 0, CONFIG.RECONNECT_POLL_COUNT);

        for (let attempt = 1; attempt <= CONFIG.RECONNECT_POLL_COUNT; attempt++) {
            logger.info(`🔍 Reconnect attempt ${attempt}/${CONFIG.RECONNECT_POLL_COUNT}`);
            WebSocketManager.broadcastReconnectStatus('reconnecting', attempt, CONFIG.RECONNECT_POLL_COUNT);

            try {
                const newData = await BlynkService.getPinData();
                const currentUptime = parseInt(newData.v5) || 0;

                if (currentUptime !== undefined && currentUptime !== state.lastUptimeValue) {
                    logger.success(`Device responded with fresh data! Uptime: ${currentUptime}s`);
                    state.lastUptimeValue = currentUptime;
                    state.consecutiveStalePolls = 0;
                    WebSocketManager.broadcastReconnectStatus('success', attempt, CONFIG.RECONNECT_POLL_COUNT);
                    this.runOnlinePollingCycle(); // This will handle setting state and broadcasting data/status
                    state.isReconnecting = false;
                    return;
                }
                logger.warn(`Attempt ${attempt}: Data received but uptime is stale.`);
            } catch (error) {
                logger.error(`Attempt ${attempt} failed: ${error.message}`);
            }

            if (attempt < CONFIG.RECONNECT_POLL_COUNT) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.RECONNECT_POLL_INTERVAL_MS));
            }
        }

        logger.error(`Manual reconnect failed after ${CONFIG.RECONNECT_POLL_COUNT} attempts.`);
        WebSocketManager.broadcastReconnectStatus('failed', CONFIG.RECONNECT_POLL_COUNT, CONFIG.RECONNECT_POLL_COUNT);
        state.isReconnecting = false;
    }
};

// --- MAIN APPLICATION & API ROUTES ---
function main() {
    if (!CONFIG.BLYNK_AUTH_TOKEN) {
        logger.error('CRITICAL: BLYNK_AUTH_TOKEN is not set in environment variables. Server shutting down.');
        process.exit(1);
    }
    logger.success(`Blynk Auth Token loaded: ${CONFIG.BLYNK_AUTH_TOKEN.substring(0, 4)}...`);
    
    const app = express();
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    app.use(express.json());
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        next();
    });
    app.use(express.static(path.join(__dirname, 'public')));

    // --- API ROUTES ---
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

    app.post('/api/reconnect', (req, res) => {
        const timeSince = Date.now() - state.lastReconnectTime;
        if (timeSince < CONFIG.RECONNECT_COOLDOWN_MS) {
            const remaining = Math.ceil((CONFIG.RECONNECT_COOLDOWN_MS - timeSince) / 1000);
            logger.warn(`Reconnect request ignored due to active cooldown (${remaining}s remaining).`);
            return res.status(429).json({ error: 'Cooldown active', remainingSeconds: remaining });
        }
        if (state.isReconnecting) {
            logger.warn('Reconnect request ignored: reconnection already in progress.');
            return res.status(409).json({ error: 'Reconnect already in progress' });
        }
        if (state.isDeviceOnline) {
            logger.info('Reconnect request ignored: device is already online.');
            return res.status(200).json({ message: 'Device is already online' });
        }
        
        state.lastReconnectTime = Date.now();
        PollingService.initiateManualReconnect(); // Fire and forget
        res.status(202).json({ message: 'Reconnect sequence initiated' });
    });

    app.post('/api/update-pin', async (req, res) => {
        const { pin, value } = req.body;
        if (!pin || value === undefined) {
            return res.status(400).json({ error: 'Pin and value are required.' });
        }
        try {
            const blynkResponse = await BlynkService.updatePin(pin, value);
            res.status(200).json({ success: true, message: `Pin ${pin} updated.`, blynkResponse });
        } catch (error) {
            logger.error(`Failed to update pin ${pin}: ${error.message}`);
            res.status(500).json({ error: 'Failed to update pin via Blynk API.', details: error.message });
        }
    });

    app.get('/api/health', (req, res) => {
        res.status(200).json({
            status: 'healthy',
            deviceOnline: state.isDeviceOnline,
            isReconnecting: state.isReconnecting,
        });
    });

    // --- SERVER STARTUP ---
    const server = app.listen(CONFIG.PORT, () => {
        console.log('\n╔═════════════════════════════════════════════════════╗');
        console.log('║   EvaraTap Server v3.0 (Manual Reconnect) Started   ║');
        console.log('╚═════════════════════════════════════════════════════╝');
        logger.info(`Server running at http://localhost:${CONFIG.PORT}`);
        logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
        
        WebSocketManager.initialize(server);
        logger.info('Attempting initial device detection...');
        PollingService.runOnlinePollingCycle();
    });

    process.on('SIGTERM', () => {
        logger.warn('SIGTERM received. Shutting down gracefully...');
        clearTimeout(state.pollingTimeoutId);
        server.close(() => {
            logger.success('Server closed.');
            process.exit(0);
        });
    });
}

main();
