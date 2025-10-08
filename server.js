/********************************************************************************
 * EvaraTap Server v4.0 - Manual Reconnect & Enhanced Polling
 *
 * FEATURES:
 * - Faster Polling: 1.5s when online, 15s when offline.
 * - Manual Reconnect: Client can send a 'force-poll' WebSocket message.
 * - Server-Side Cooldown: Enforces a 30-second cooldown on forced polls
 * to prevent API spam.
 * - Bug Fix: Correctly formats multi-pin polling URL for the Blynk API.
 * - Robust state management and clear logging.
 ********************************************************************************/

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const PORT = process.env.PORT || 10000;

const BLYNK_AUTH_TOKEN = process.env.BLYNK_AUTH_TOKEN || "1NJUV0rE2TjnZxbTb89-tA0XmwGwZGCn";
const BLYNK_API_BASE = 'https://blynk.cloud/external/api';

// --- Configuration ---
const POLLING_RATE_ONLINE_MS = 1500;       // 1.5 seconds when device is online
const POLLING_RATE_OFFLINE_MS = 15*60*1000;      // 15 minutes when device is offline
const OFFLINE_GRACE_PERIOD_MS = 6000;       // Mark offline if no fresh data for 6 seconds
const FORCE_POLL_COOLDOWN_MS = 30000;      // 30-second cooldown for manual reconnect requests

const VIRTUAL_PINS_TO_POLL = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'];

// --- State Management ---
let deviceDataCache = {};
let lastUptimeValue = -1;
let lastFreshDataTimestamp = 0;
let isDeviceOnline = false;
let currentPollingRate = POLLING_RATE_ONLINE_MS;
let pollingTimeoutId = null;
let lastForcePollTimestamp = 0;

// --- Validation ---
if (!BLYNK_AUTH_TOKEN) {
    console.error('❌ CRITICAL: BLYNK_AUTH_TOKEN not set');
    process.exit(1);
}
console.log('✅ Token loaded.');

// --- Express Configuration ---
app.use(express.json());
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// --- Core Polling Logic ---
const pollBlynkData = async (isForced = false) => {
    // Clear any scheduled poll, as we are running one now.
    if (pollingTimeoutId) clearTimeout(pollingTimeoutId);

    try {
        if (isForced) console.log('⚡ Manual poll triggered by client.');
        
        // ** CRITICAL BUG FIX: Correctly format the URL for multiple pins **
        const pinParams = VIRTUAL_PINS_TO_POLL.map(pin => `pin=${pin}`).join('&');
        const url = `${BLYNK_API_BASE}/get?token=${BLYNK_AUTH_TOKEN}&${pinParams}`;
        
        const blynkResponse = await fetch(url, { timeout: 8000 });
        if (!blynkResponse.ok) {
            throw new Error(`Blynk API Error ${blynkResponse.status}: ${await blynkResponse.text()}`);
        }
        
        const newData = await blynkResponse.json();
        const currentUptime = parseInt(newData.v5) || 0;
        const uptimeHasChanged = (currentUptime > 0 && currentUptime !== lastUptimeValue);

        if (uptimeHasChanged) {
            if (!isDeviceOnline) {
                console.log('\n✅ DEVICE ONLINE: Uptime has changed.');
                console.log(`   Switching to FAST polling (${POLLING_RATE_ONLINE_MS / 1000}s).\n`);
                isDeviceOnline = true;
                currentPollingRate = POLLING_RATE_ONLINE_MS;
            }
            lastFreshDataTimestamp = Date.now();
            lastUptimeValue = currentUptime;
            broadcastDataUpdate(newData, true);
        } else {
            const timeSinceFreshData = Date.now() - lastFreshDataTimestamp;
            if (isDeviceOnline && timeSinceFreshData > OFFLINE_GRACE_PERIOD_MS) {
                console.log('\n❌ DEVICE OFFLINE: No fresh data received within grace period.');
                console.log(`   Switching to SLOW polling (${POLLING_RATE_OFFLINE_MS / 1000}s).\n`);
                isDeviceOnline = false;
                currentPollingRate = POLLING_RATE_OFFLINE_MS;
            }
            broadcastDataUpdate(newData, false);
        }
    } catch (error) {
        console.error('❌ Polling Error:', error.message);
        if (isDeviceOnline) {
            console.log('   Marking device OFFLINE due to error.');
            isDeviceOnline = false;
            currentPollingRate = POLLING_RATE_OFFLINE_MS;
        }
        // Even on error, broadcast the offline status
        broadcastDataUpdate(deviceDataCache, false);
    } finally {
        // Schedule the next poll
        pollingTimeoutId = setTimeout(pollBlynkData, currentPollingRate);
    }
};

function broadcastDataUpdate(data, isFresh) {
    deviceDataCache = data;
    const message = JSON.stringify({
        type: 'data-update',
        payload: deviceDataCache,
        timestamp: Date.now(),
        isOnline: isDeviceOnline,
        isFresh: isFresh && isDeviceOnline
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
    
    if (isFresh && isDeviceOnline) {
        console.log(`📡 Broadcast [ONLINE]: v5=${data.v5}s`);
    }
}

// --- API Endpoint for Commands (Unchanged) ---
app.post('/api/update-pin', async (req, res) => {
    const { pin, value } = req.body;
    console.log(`📲 Command Received: Set ${pin} to ${value}`);
    if (!pin || value === undefined) {
        return res.status(400).json({ error: 'Pin and value are required.' });
    }
    try {
        const url = `${BLYNK_API_BASE}/update?token=${BLYNK_AUTH_TOKEN}&${pin}=${value}`;
        const blynkResponse = await fetch(url);
        if (!blynkResponse.ok) {
            throw new Error(`Blynk command failed with status ${blynkResponse.status}`);
        }
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('❌ Command Failed:', error.message);
        res.status(500).json({ error: 'Failed to update pin.', details: error.message });
    }
});

// --- Server & WebSocket Initialization ---
const server = app.listen(PORT, () => {
    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║   EvaraTap Server v4.0 - Manual Reconnect      ║');
    console.log('╚════════════════════════════════════════════════╝');
    console.log(`\n🚀 Server running at http://localhost:${PORT}`);
    console.log(`⚡ Online polling rate: ${POLLING_RATE_ONLINE_MS / 1000}s`);
    console.log(`🐢 Offline polling rate: ${POLLING_RATE_OFFLINE_MS / 1000}s`);
    console.log(`🛡️  Manual reconnect cooldown: ${FORCE_POLL_COOLDOWN_MS / 1000}s\n`);
    
    pollBlynkData(); // Start the polling loop
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('🔌 New client connected.');
    
    ws.send(JSON.stringify({
        type: 'initial-state',
        payload: deviceDataCache,
        timestamp: Date.now(),
        isOnline: isDeviceOnline
    }));

    // --- NEW: WebSocket Message Handler for Force Poll ---
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'force-poll') {
                const now = Date.now();
                if (now - lastForcePollTimestamp > FORCE_POLL_COOLDOWN_MS) {
                    lastForcePollTimestamp = now;
                    pollBlynkData(true); // `true` indicates it's a forced poll
                } else {
                    console.log('🚫 Manual poll request ignored (cooldown).');
                }
            }
        } catch (e) {
            console.error('Invalid WebSocket message:', e);
        }
    });
    
    ws.on('close', () => console.log('👋 Client disconnected.'));
    ws.on('error', (error) => console.error('❗️ WebSocket Error:', error));
});
