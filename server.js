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
const POLLING_RATE_MS = 250;
const STALE_POLL_THRESHOLD = 40; // 40 * 250ms = 10 second offline detection

// --- VIRTUAL PIN DEFINITIONS (v8.9-fix) ---
const VPIN_TOTAL_VOLUME = 'v0';
const VPIN_FLOW_RATE = 'v1';
const VPIN_VALVE_STATUS = 'v2';
const VPIN_VOLUME_LIMIT = 'v4';
const UPTIME_PIN = 'v5';
const CMD_ENABLE_HEARTBEAT_PIN = 'v6'; 
const CMD_OPEN_VALVE_PIN = 'v10';      
const CMD_CLOSE_VALVE_PIN = 'v11';     

const VIRTUAL_PINS_TO_POLL = [VPIN_TOTAL_VOLUME, VPIN_FLOW_RATE, VPIN_VALVE_STATUS, VPIN_VOLUME_LIMIT, UPTIME_PIN];

// ===================================================================================
// --- STATE MANAGEMENT ---
// ===================================================================================

let deviceDataCache = {};
let lastUptimeValue = -1;
let consecutiveStalePolls = 0;
let isDeviceOnline = false;
let isPollingActive = false;
let pollingTimeoutId = null;

let desiredValveState = 'unknown';

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
    console.log(`🚀 EvaraTap Server v9.0 (Failsafe Respect) is running on port ${PORT}`);
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
            const wasPreviouslyOffline = !isDeviceOnline;

            if (wasPreviouslyOffline) {
                console.info('✅ [STATUS] Fresh data detected! ESP32 is now ONLINE.');
            }
            isDeviceOnline = true;
            consecutiveStalePolls = 0;
            lastUptimeValue = currentUptime;
            deviceDataCache = newData;
            
            broadcastDataUpdate();

            if (wasPreviouslyOffline) {
                console.log(`[SAFETY] Device just reconnected. Setting desired state to CLOSED.`);
                desiredValveState = 'closed';
            }

            // --- "State Enforcer" Logic ---
            const actualValveState = parseInt(newData[VPIN_VALVE_STATUS] || 0); // 0 = closed, 1 = open
            const totalVolume = parseFloat(newData[VPIN_TOTAL_VOLUME] || 0);
            const volumeLimit = parseFloat(newData[VPIN_VOLUME_LIMIT] || 0);

            if (desiredValveState === 'closed' && actualValveState === 1) {
                console.warn('[ENFORCER] State mismatch. Desired: CLOSED, Actual: OPEN. Forcing close...');
                await callBlynkApi('update', `${CMD_CLOSE_VALVE_PIN}=1`);
            
            // MODIFIED v9.0: This is the fix for the "Ghost Open"
            } else if (desiredValveState === 'open' && actualValveState === 0) {
                // A mismatch was detected. The server *wanted* it open, but it's closed.
                // This means a local failsafe (no-flow or volume limit) on the ESP32 must have triggered.
                // We must respect the failsafe and update our own state.
                console.warn('[ENFORCER] Mismatch detected (Device closed while desired=OPEN).');
                console.warn('[ENFORCER] Assuming local ESP32 failsafe. Resetting desired state to CLOSED.');
                desiredValveState = 'closed';
                // We DO NOT send an 'open' command. We've "given up" on opening.
            }
        }
    }

    if (consecutiveStalePolls >= STALE_POLL_THRESHOLD) {
        console.warn(`🚨 [STATUS] OFFLINE: Stale data threshold reached.`);
        isDeviceOnline = false;
        isPollingActive = false;
        desiredValveState = 'unknown'; 
        broadcastDataUpdate();

        console.log('[SAFETY] Initiating graceful shutdown sequence...');
        console.log(`[SAFETY] Sending final close valve command (${CMD_CLOSE_VALVE_PIN}=1) for redundancy...`);
        await callBlynkApi('update', `${CMD_CLOSE_VALVE_PIN}=1`);
        console.log('🛑 [SAFETY] Shutdown sequence complete. Server is now idle.');
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
    
    desiredValveState = 'closed';

    const activationResult = await callBlynkApi('update', `${CMD_ENABLE_HEARTBEAT_PIN}=1`);

    if (!activationResult) {
        return res.status(500).json({ error: 'Failed to send activation command to Blynk.' });
    }

    isPollingActive = true;
    isDeviceOnline = false;
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

    if (pin === CMD_OPEN_VALVE_PIN) {
        const totalVolume = parseFloat(deviceDataCache[VPIN_TOTAL_VOLUME] || 0);
        const volumeLimit = parseFloat(deviceDataCache[VPIN_VOLUME_LIMIT] || 0);
        if (volumeLimit > 0 && totalVolume >= volumeLimit) {
            console.log('[CMD-REJECT] Open valve command rejected: Volume limit reached.');
            return res.status(403).json({ error: 'Volume limit reached. Reset to continue.' });
        }
        desiredValveState = 'open';
    
    } else if (pin === CMD_CLOSE_VALVE_PIN) {
        desiredValveState = 'closed';
    
    } else if (pin === CMD_ENABLE_HEARTBEAT_PIN && value == 0) {
        console.log('[CMD] Emergency Stop detected. Forcing desired state to CLOSED.');
        desiredValveState = 'closed';
    }

    let updateResult = await callBlynkApi('update', `${pin}=${value}`);

    if (!updateResult) {
        console.error(`[CMD-FAIL] API call failed for ${pin}=${value}`);
        return res.status(500).json({ success: false, error: 'Failed to send command to Blynk API.' });
    }
    
    console.log(`[CMD-SENT] ✅ Command ${pin}=${value} sent to Blynk.`);
    return res.status(200).json({ success: true, message: `Command sent.` });
});

// ===================================================================================
// --- WEBSOCKET BROADCAST LOGIC ---
// ===================================================================================

function broadcastDataUpdate() {
    const message = JSON.stringify({
        type: isDeviceOnline ? 'data-update' : 'device-offline',
        payload: deviceDataCache,
        deviceOnline: isDeviceOnline,
        desiredState: desiredValveState, 
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
        desiredState: desiredValveState,
        timestamp: Date.now()
    }));
    ws.on('close', () => console.log('[WSS] ❌ Client disconnected from WebSocket.'));
    ws.on('error', (error) => console.error('[WSS-ERROR] WebSocket client error:', error));
});
