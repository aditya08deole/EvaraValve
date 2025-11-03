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
const POLLING_RATE_MS = 500;
const STALE_POLL_THRESHOLD = 40;

// --- VIRTUAL PIN DEFINITIONS (v8.9-fix) ---
const VPIN_TOTAL_VOLUME = 'v0';
const VPIN_FLOW_RATE = 'v1';
const VPIN_VALVE_STATUS = 'v2';
const VPIN_VOLUME_LIMIT = 'v4';
const UPTIME_PIN = 'v5';
const CMD_ENABLE_HEARTBEAT_PIN = 'v6'; // PIN to enable/disable data sending from ESP32
const CMD_OPEN_VALVE_PIN = 'v10';      // Pin to send the open command
const CMD_CLOSE_VALVE_PIN = 'v11';     // Pin to send the close command for safety

// MODIFIED v8.9-fix: Add all polled pins to an array
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

// NEW v8.9-fix: Implement the "State Enforcer"
// This variable tracks what we *want* the valve state to be.
// Can be 'unknown', 'open', or 'closed'.
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
    console.log(`🚀 EvaraTap Server v8.9-fix (State Enforcer) is running on port ${PORT}`);
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
                // NEW v8.9-fix: On reconnect, force the desired state to 'closed'.
                // The enforcer logic below will handle sending the command.
                desiredValveState = 'closed';
            }

            // --- NEW v8.9-fix: "State Enforcer" Logic ---
            // This logic runs *every* successful poll (500ms)
            const actualValveState = parseInt(newData[VPIN_VALVE_STATUS] || 0); // 0 = closed, 1 = open
            const totalVolume = parseFloat(newData[VPIN_TOTAL_VOLUME] || 0);
            const volumeLimit = parseFloat(newData[VPIN_VOLUME_LIMIT] || 0);

            if (desiredValveState === 'closed' && actualValveState === 1) {
                // We *want* it closed, but it's *actually* open.
                console.warn('[ENFORCER] State mismatch. Desired: CLOSED, Actual: OPEN. Forcing close...');
                await callBlynkApi('update', `${CMD_CLOSE_VALVE_PIN}=1`);
            
            } else if (desiredValveState === 'open' && actualValveState === 0) {
                // We *want* it open, but it's *actually* closed.
                
                // First, check the volume limit lock
                if (volumeLimit > 0 && totalVolume >= volumeLimit) {
                    console.warn('[ENFORCER] Desired: OPEN, but volume limit reached. Forcing state to CLOSED.');
                    desiredValveState = 'closed'; // Give up trying to open
                } else {
                    // It's safe to open
                    console.warn('[ENFORCER] State mismatch. Desired: OPEN, Actual: CLOSED. Forcing open...');
                    await callBlynkApi('update', `${CMD_OPEN_VALVE_PIN}=1`);
                }
            }
            // --- End of State Enforcer Logic ---
        }
    }

    if (consecutiveStalePolls >= STALE_POLL_THRESHOLD) {
        console.warn(`🚨 [STATUS] OFFLINE: Stale data threshold reached.`);
        isDeviceOnline = false;
        isPollingActive = false;
        desiredValveState = 'unknown'; // Reset desired state
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
    
    // NEW v8.9-fix: When starting, set the desired state to 'closed'
    // The ESP32 also forces a close on V6=1, this keeps them in sync.
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

// MODIFIED v8.9-fix: This endpoint now sets the "desiredState"
app.post('/api/update-pin', async (req, res) => {
    const { pin, value } = req.body;

    if (!pin || value === undefined) {
        return res.status(400).json({ error: 'Pin and value are required.' });
    }
    console.log(`\n[CMD] Received command: Set ${pin} = ${value}`);

    // --- State Enforcer Logic ---
    if (pin === CMD_OPEN_VALVE_PIN) {
        // Server-side check to prevent opening valve if limit is reached.
        const totalVolume = parseFloat(deviceDataCache[VPIN_TOTAL_VOLUME] || 0);
        const volumeLimit = parseFloat(deviceDataCache[VPIN_VOLUME_LIMIT] || 0);
        if (volumeLimit > 0 && totalVolume >= volumeLimit) {
            console.log('[CMD-REJECT] Open valve command rejected: Volume limit reached.');
            return res.status(403).json({ error: 'Volume limit reached. Reset to continue.' });
        }
        desiredValveState = 'open'; // Set the desired state
    
    } else if (pin === CMD_CLOSE_VALVE_PIN) {
        desiredValveState = 'closed'; // Set the desired state
    
    } else if (pin === CMD_ENABLE_HEARTBEAT_PIN && value == 0) {
        // This is the EMERGENCY STOP button
        console.log('[CMD] Emergency Stop detected. Forcing desired state to CLOSED.');
        desiredValveState = 'closed';
    }
    // --- End State Enforcer ---

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
        // NEW v8.9-fix: Send the desired state to the dashboard (for future use)
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
