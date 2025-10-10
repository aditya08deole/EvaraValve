import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { WebSocketServer, WebSocket } from 'ws';

// ===================================================================================
// --- CONFIGURATION & CONSTANTS ---
// ===================================================================================

const app = express();
const PORT = process.env.PORT || 10000;

// --- IMPORTANT: SET THIS IN YOUR RENDER/HOSTING ENVIRONMENT VARIABLES ---
const BLYNK_AUTH_TOKEN = process.env.BLYNK_AUTH_TOKEN;
const BLYNK_API_BASE = 'https://blynk.cloud/external/api';

// --- Polling and Offline Detection Configuration ---
const POLLING_RATE_MS = 2000;      // Poll every 2 seconds ONLY when a client is active.
const STALE_POLL_THRESHOLD = 10;   // Mark device offline after 10 consecutive stale polls.

// --- VIRTUAL PIN DEFINITIONS ---
const VIRTUAL_PINS_TO_POLL = ['v0', 'v1', 'v2', 'v4', 'v5', 'v6'];
const UPTIME_PIN = 'v5';           // Device heartbeat pin (e.g., seconds since boot).
const POWER_RELAY_PIN = 'v6';      // Pin controlling the main power to the ESP32 system.

// ===================================================================================
// --- STATE MANAGEMENT ---
// ===================================================================================

let deviceDataCache = {};
let lastUptimeValue = -1;
let consecutiveStalePolls = 0;
let isDeviceOnline = false;
let isPollingActive = false;
let pollingTimeoutId = null;

// ===================================================================================
// --- STARTUP VALIDATION ---
// ===================================================================================

if (!BLYNK_AUTH_TOKEN) {
    console.error('❌ CRITICAL ERROR: BLYNK_AUTH_TOKEN is not set in the environment variables.');
    process.exit(1);
}
console.log(`[INFO] Blynk Auth Token loaded: ${BLYNK_AUTH_TOKEN.substring(0, 8)}...`);

// ===================================================================================
// --- EXPRESS & WEBSOCKET SETUP ---
// ===================================================================================

app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
    console.log(`🚀 EvaraTap Server v6.3 (Debug Logging) is running on port ${PORT}`);
    console.log('[INFO] Waiting for client to initiate connection...');
});

const wss = new WebSocketServer({ server });

// ===================================================================================
// --- BLYNK API HELPER ---
// ===================================================================================

/**
 * A centralized and robust function for making GET requests to the Blynk API.
 * This version includes enhanced logging for debugging.
 * @param {string} endpoint - The specific API endpoint (e.g., 'get', 'update').
 * @param {string} params - The query parameters for the request (e.g., 'v1&v2' or 'v6=1').
 * @returns {Promise<object|null>} The JSON response from Blynk or null on failure.
 */
async function callBlynkApi(endpoint, params) {
    const url = `${BLYNK_API_BASE}/${endpoint}?token=${BLYNK_AUTH_TOKEN}&${params}`;
    
    // Create a version of the URL for logging that hides most of the token.
    const displayUrl = `${BLYNK_API_BASE}/${endpoint}?token=${BLYNK_AUTH_TOKEN.substring(0,4)}...&${params}`;
    console.log(`[API-CALL] Attempting to fetch: ${displayUrl}`);

    try {
        const response = await fetch(url);
        // Log the response status immediately after the fetch completes.
        console.log(`[API-CALL] Fetch completed for ${params} with status: ${response.status}`);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[API-ERROR] Blynk API Error on ${endpoint} (${response.status}):`, errorText);
            return null;
        }
        if (response.headers.get('content-length') === '0') {
            return { success: true };
        }
        return response.json();
    } catch (error) {
        console.error(`[API-ERROR] Network error or exception during fetch for ${displayUrl}:`, error.message);
        return null;
    }
}


// ===================================================================================
// --- CORE POLLING LOGIC ---
// ===================================================================================

const pollBlynkData = async () => {
    if (!isPollingActive) {
        console.log('[POLL] Polling is inactive. Stopping loop.');
        return;
    }

    const pinParams = VIRTUAL_PINS_TO_POLL.join('&');
    const newData = await callBlynkApi('get', pinParams);

    if (!newData) {
        consecutiveStalePolls++;
    } else {
        const currentUptime = parseInt(newData[UPTIME_PIN]) || 0;
        if (lastUptimeValue === currentUptime && isDeviceOnline) {
            consecutiveStalePolls++;
            console.log(`[POLL-WARN] Stale data detected. Uptime ${currentUptime}s unchanged. Stale count: ${consecutiveStalePolls}/${STALE_POLL_THRESHOLD}`);
        } else {
            if (!isDeviceOnline) {
                console.info('✅ [STATUS] Fresh data detected! ESP32 is now ONLINE.');
            }
            isDeviceOnline = true;
            consecutiveStalePolls = 0;
            lastUptimeValue = currentUptime;
            deviceDataCache = newData;
            broadcastDataUpdate();
        }
    }

    if (consecutiveStalePolls >= STALE_POLL_THRESHOLD) {
        console.warn(`🚨 [STATUS] OFFLINE: Stale data threshold reached (${STALE_POLL_THRESHOLD} polls).`);
        isDeviceOnline = false;
        isPollingActive = false;
        broadcastDataUpdate();
        console.log(`[SAFETY] Triggering safety shutdown: Turning off power relay (${POWER_RELAY_PIN}).`);
        await callBlynkApi('update', `${POWER_RELAY_PIN}=0`);
        return;
    }
    pollingTimeoutId = setTimeout(pollBlynkData, POLLING_RATE_MS);
};

// ===================================================================================
// --- API ENDPOINTS ---
// ===================================================================================

app.post('/api/start-connection', async (req, res) => {
    if (isPollingActive) {
        return res.status(400).json({ message: 'A connection is already active.' });
    }
    console.log('[API] Received request to start connection. Powering on device...');
    const powerOnResult = await callBlynkApi('update', `${POWER_RELAY_PIN}=1`);
    if (!powerOnResult) {
        return res.status(500).json({ error: 'Failed to send power-on command to Blynk.' });
    }
    isPollingActive = true;
    isDeviceOnline = false;
    consecutiveStalePolls = 0;
    lastUptimeValue = -1;
    if (pollingTimeoutId) clearTimeout(pollingTimeoutId);
    pollBlynkData();
    res.status(202).json({ success: true, message: 'Connection sequence initiated.' });
});

app.post('/api/update-pin', async (req, res) => {
    const { pin, value } = req.body;

    if (!pin || value === undefined) {
        return res.status(400).json({ error: 'Pin and value are required.' });
    }
    console.log(`[CMD] Received command: Set ${pin} = ${value}`);

    const updateResult = await callBlynkApi('update', `${pin}=${value}`);
    if (!updateResult) {
        console.error(`[CMD-FAIL] Blynk API call failed for ${pin}=${value}`);
        return res.status(500).json({ success: false, error: 'Failed to send command to Blynk API.' });
    }
    
    console.log(`[CMD-SENT] ✅ Command ${pin}=${value} sent to Blynk.`);
    return res.status(200).json({ success: true, message: `Command sent: ${pin} set to ${value}.` });
});


// ===================================================================================
// --- WEBSOCKET BROADCAST LOGIC ---
// ===================================================================================

function broadcastDataUpdate() {
    const message = JSON.stringify({
        type: isDeviceOnline ? 'data-update' : 'device-offline',
        payload: deviceDataCache,
        deviceOnline: isDeviceOnline,
        timestamp: Date.now()
    });

    let clientCount = 0;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
            clientCount++;
        }
    });

    if (clientCount > 0 && isDeviceOnline) {
        const { v0, v1, v2, v5 } = deviceDataCache;
        console.log(`[WSS] 📡 Broadcast to ${clientCount} client(s): v0=${v0}L, v1=${v1}LPM, v2=${v2}, v5=${v5}s`);
    } else if (clientCount > 0 && !isDeviceOnline) {
        console.log(`[WSS] 📡 Broadcast 'device-offline' to ${clientCount} client(s).`);
    }
}

wss.on('connection', (ws) => {
    console.log('[WSS] ✅ Client connected to WebSocket.');
    ws.send(JSON.stringify({
        type: 'initial-state',
        payload: deviceDataCache,
        deviceOnline: isDeviceOnline,
        timestamp: Date.now()
    }));
    ws.on('close', () => console.log('[WSS] ❌ Client disconnected from WebSocket.'));
    ws.on('error', (error) => console.error('[WSS-ERROR] WebSocket client error:', error));
});

