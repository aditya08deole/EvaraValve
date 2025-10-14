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
const POLLING_RATE_MS = 1000;      // Poll every 2 seconds ONLY when a client is active.
const STALE_POLL_THRESHOLD = 20;   // Mark device offline after 10 consecutive stale polls.

// --- VIRTUAL PIN DEFINITIONS (v8.0 Update) ---
const VIRTUAL_PINS_TO_POLL = ['v0', 'v1', 'v2', 'v4', 'v5', 'v6'];
const UPTIME_PIN = 'v5';
const CMD_ENABLE_HEARTBEAT_PIN = 'v6'; // PIN to enable/disable data sending from ESP32
const CMD_CLOSE_VALVE_PIN = 'v11';     // Pin to send the close command for safety

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
    console.log(`🚀 EvaraTap Server v8.0 (Active/Standby) is running on port ${PORT}`);
    console.log('[INFO] Waiting for client to initiate connection...');
});

const wss = new WebSocketServer({ server });

// ===================================================================================
// --- BLYNK API HELPERS ---
// ===================================================================================

async function callBlynkApi(endpoint, params) {
    const url = `${BLYNK_API_BASE}/${endpoint}?token=${BLYNK_AUTH_TOKEN}&${params}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[API-ERROR] Blynk API Error on ${endpoint} (${response.status}):`, errorText);
            return null;
        }
        // For 'update' calls, Blynk often returns an empty body on success
        if (response.headers.get('content-length') === '0') {
            return { success: true };
        }
        return response.json();
    } catch (error) {
        console.error(`[API-ERROR] Network error during fetch for ${endpoint}:`, error.message);
        return null;
    }
}

// NOTE: The setRelayState function has been removed as it's obsolete in v8.0.

// ===================================================================================
// --- CORE POLLING LOGIC ---
// ===================================================================================

const pollBlynkData = async () => {
    if (!isPollingActive) {
        return;
    }
    const pinParams = VIRTUAL_PINS_TO_POLL.join('&');
    const newData = await callBlynkApi('get', pinParams);

    if (!newData) {
        consecutiveStalePolls++;
    } else {
        const currentUptime = parseInt(newData[UPTIME_PIN]) || 0;
        // The core logic: if the uptime value hasn't changed, the device is stale.
        if (lastUptimeValue === currentUptime && isDeviceOnline) {
            consecutiveStalePolls++;
        } else {
            const wasPreviouslyOffline = !isDeviceOnline;

            if (wasPreviouslyOffline) {
                console.info('✅ [STATUS] Fresh data detected! ESP32 is now ONLINE.');
            }

            // Reset counters and update cache with fresh data
            isDeviceOnline = true;
            consecutiveStalePolls = 0;
            lastUptimeValue = currentUptime;
            deviceDataCache = newData;
            
            broadcastDataUpdate(); // Inform UI that device is online

            // --- Safety logic for when device first comes online ---
            if (wasPreviouslyOffline) {
                console.log(`[SAFETY] Device just reconnected. Sending command to ensure valve is closed.`);
                await callBlynkApi('update', `${CMD_CLOSE_VALVE_PIN}=1`);
            }
        }
    }

    // --- SAFETY SHUTDOWN LOGIC (Triggered by Stale Data) ---
    if (consecutiveStalePolls >= STALE_POLL_THRESHOLD) {
        console.warn(`🚨 [STATUS] OFFLINE: Stale data threshold reached.`);
        isDeviceOnline = false;
        isPollingActive = false; // Stop polling to save resources
        broadcastDataUpdate();

        console.log('[SAFETY] Initiating graceful shutdown sequence...');
        
        console.log(`[SAFETY] Sending final close valve command (${CMD_CLOSE_VALVE_PIN}=1) for redundancy...`);
        await callBlynkApi('update', `${CMD_CLOSE_VALVE_PIN}=1`);
        
        console.log('🛑 [SAFETY] Shutdown sequence complete. Server is now idle.');
        return; // Stop the polling loop
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
    console.log('[API] Received request to start connection...');
    
    // Send command to ESP32 to enable its heartbeat and enter "Active" mode
    const activationResult = await callBlynkApi('update', `${CMD_ENABLE_HEARTBEAT_PIN}=1`);

    if (!activationResult) {
        return res.status(500).json({ error: 'Failed to send activation command to Blynk.' });
    }

    // Start server-side polling to listen for the device's response
    isPollingActive = true;
    isDeviceOnline = false; // Assume offline until first successful poll
    consecutiveStalePolls = 0;
    lastUptimeValue = -1;
    if (pollingTimeoutId) clearTimeout(pollingTimeoutId);
    pollBlynkData();
    res.status(202).json({ success: true, message: 'Activation sequence initiated.' });
});

app.post('/api/update-pin', async (req, res) => {
    const { pin, value } = req.body;

    if (!pin || value === undefined) {
        return res.status(400).json({ error: 'Pin and value are required.' });
    }
    console.log(`\n[CMD] Received command: Set ${pin} = ${value}`);

    let updateResult;

    if (pin === CMD_ENABLE_HEARTBEAT_PIN) {
        const isActivating = parseInt(value) === 1;
        if (!isActivating) {
            console.log('🚨 [STANDBY] Standby command received! The device will go silent, triggering an offline event.');
        }
        updateResult = await callBlynkApi('update', `${pin}=${value}`);
        // NOTE: We no longer stop polling here. We let the stale data detector handle the offline transition gracefully.
    } else {
        updateResult = await callBlynkApi('update', `${pin}=${value}`);
    }

    if (!updateResult) {
        console.error(`[CMD-FAIL] API call failed for ${pin}=${value}`);
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
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
}

wss.on('connection', (ws) => {
    console.log('[WSS] ✅ Client connected to WebSocket.');
    // Send the current state immediately on connection
    ws.send(JSON.stringify({
        type: 'initial-state',
        payload: deviceDataCache,
        deviceOnline: isDeviceOnline,
        timestamp: Date.now()
    }));
    ws.on('close', () => console.log('[WSS] ❌ Client disconnected from WebSocket.'));
    ws.on('error', (error) => console.error('[WSS-ERROR] WebSocket client error:', error));
});
