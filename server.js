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
    console.log(`🚀 EvaraTap Server v6.7 (Fixed Emergency Stop) is running on port ${PORT}`);
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
        if (response.headers.get('content-length') === '0') {
            return { success: true };
        }
        return response.json();
    } catch (error) {
        console.error(`[API-ERROR] Network error during fetch for ${endpoint}:`, error.message);
        return null;
    }
}

/**
 * A dedicated function to control the power relay.
 * This is the single source of truth for turning the relay ON or OFF.
 * @param {boolean} turnOn - True to turn the relay ON (v6=1), false to turn it OFF (v6=0).
 * @returns {Promise<object|null>} The result from the Blynk API call.
 */
async function setRelayState(turnOn) {
    const value = turnOn ? 1 : 0;
    console.log(`[RELAY-CMD] Setting power relay state to ${turnOn ? 'ON' : 'OFF'} (v6=${value})`);
    console.log(`[RELAY-CMD] API URL: ${BLYNK_API_BASE}/update?token=***&v6=${value}`);
    
    const result = await callBlynkApi('update', `${POWER_RELAY_PIN}=${value}`);
    
    if (!result) {
        console.error(`[RELAY-FAIL] ❌ The API call to set relay state to ${value} failed.`);
    } else {
        console.log(`[RELAY-SUCCESS] ✅ Relay command sent successfully: v6=${value}`);
        console.log(`[RELAY-SUCCESS] Blynk should now trigger BLYNK_WRITE(V6) with value=${value}`);
    }
    return result;
}

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
        if (lastUptimeValue === currentUptime && isDeviceOnline) {
            consecutiveStalePolls++;
        } else {
            if (!isDeviceOnline) console.info('✅ [STATUS] Fresh data detected! ESP32 is now ONLINE.');
            isDeviceOnline = true;
            consecutiveStalePolls = 0;
            lastUptimeValue = currentUptime;
            deviceDataCache = newData;
            broadcastDataUpdate();
        }
    }
    if (consecutiveStalePolls >= STALE_POLL_THRESHOLD) {
        console.warn(`🚨 [STATUS] OFFLINE: Stale data threshold reached.`);
        isDeviceOnline = false;
        isPollingActive = false;
        broadcastDataUpdate();
        console.log(`[SAFETY] Triggering safety shutdown.`);
        await setRelayState(false); // Use the dedicated function for safety shutdown
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
    console.log('[API] Received request to start connection...');
    
    // This calls the shared function to turn the relay ON
    const powerOnResult = await setRelayState(true);

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
    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`[CMD] Received command: Set ${pin} = ${value}`);
    console.log(`═══════════════════════════════════════════════════`);

    let updateResult;

    // Check if the command is for the power relay
    if (pin === POWER_RELAY_PIN) {
        const turnOn = parseInt(value) === 1;
        
        if (!turnOn) {
            console.log('🚨 [EMERGENCY-STOP] Emergency stop initiated!');
            console.log('📡 [STEP 1] Keeping connection alive to deliver command...');
        }
        
        // Call the shared function to turn the relay ON or OFF
        updateResult = await setRelayState(turnOn);
        
        if (!turnOn && updateResult) {
            console.log('✅ [STEP 2] OFF command sent to Blynk API successfully.');
            console.log('⏳ [STEP 3] Waiting 3 seconds for ESP32 to process command...');
            
            // CRITICAL FIX: Wait for ESP32 to actually receive and process the command
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            console.log('🔌 [STEP 4] Now stopping polling and marking system offline...');
            isPollingActive = false;
            isDeviceOnline = false;
            if (pollingTimeoutId) {
                clearTimeout(pollingTimeoutId);
                pollingTimeoutId = null;
            }
            broadcastDataUpdate();
            console.log('🛑 [COMPLETE] Emergency stop sequence completed.\n');
        }
    } else {
        // For any other pin, send the command directly
        updateResult = await callBlynkApi('update', `${pin}=${value}`);
    }

    if (!updateResult) {
        console.error(`[CMD-FAIL] API call failed for ${pin}=${value}`);
        return res.status(500).json({ success: false, error: 'Failed to send command to Blynk API.' });
    }
    
    console.log(`[CMD-SENT] ✅ Command ${pin}=${value} sent to Blynk.`);
    return res.status(200).json({ success: true, message: `Command sent: ${pin} set to ${value}.` });
});

// *** NEW: Test endpoint to verify relay state ***
app.get('/api/test-relay', async (req, res) => {
    console.log('[TEST] Testing relay OFF command...');
    const result = await setRelayState(false);
    if (result) {
        return res.json({ success: true, message: 'Test OFF command sent successfully' });
    } else {
        return res.status(500).json({ success: false, message: 'Test OFF command failed' });
    }
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
    ws.send(JSON.stringify({
        type: 'initial-state',
        payload: deviceDataCache,
        deviceOnline: isDeviceOnline,
        timestamp: Date.now()
    }));
    ws.on('close', () => console.log('[WSS] ❌ Client disconnected from WebSocket.'));
    ws.on('error', (error) => console.error('[WSS-ERROR] WebSocket client error:', error));
});
