/************************************************************************
 * EvaraTap Server v6.0 - Final Version with Active Reconnect
 *
 * This server provides the complete backend logic for the EvaraTap dashboard.
 *
 * KEY FEATURES:
 * - Active Reconnect: When a user clicks "Try Reconnecting", the server
 * switches to a fast 5-second polling rate for a 30-second window.
 * - Intelligent Polling: The server uses three distinct polling rates:
 * 1. Online (1.5s):   Fast updates when the device is connected.
 * 2. Active Check (5s): During a manual reconnect attempt.
 * 3. Offline Idle (15s): A slow background check to save resources.
 * - Robust State Management: Cleanly handles online, offline, and
 * active checking states for reliable performance.
 * - Command API: Securely relays commands from the dashboard to Blynk.
 ************************************************************************/

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { WebSocketServer } from 'ws';

const app = express();
const PORT = process.env.PORT || 10000;

// --- IMPORTANT: Store your Blynk Auth Token in an environment variable ---
const BLYNK_AUTH_TOKEN = process.env.BLYNK_AUTH_TOKEN || "1NJUV0rE2TjnZxbTb89-tA0XmwGwZGCn";
const BLYNK_API_BASE = 'https://blynk.cloud/external/api';

// --- Configuration ---
const POLLING_RATE_ONLINE_MS = 1500;       // 1.5 seconds when device is online
const POLLING_RATE_OFFLINE_MS = 15000;     // 15 seconds for background offline polling
const POLLING_RATE_ACTIVE_CHECK_MS = 5000; // 5 seconds during a manual reconnect attempt
const ACTIVE_CHECK_DURATION_MS = 30000;    // 30 seconds for the active check window
const OFFLINE_GRACE_PERIOD_MS = 6000;      // Mark offline if no fresh data for 6 seconds

// Define which virtual pins the server should monitor
const VIRTUAL_PINS_TO_POLL = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'];

// --- State Management ---
let deviceDataCache = {};
let lastUptimeValue = -1;
let lastFreshDataTimestamp = 0;
let isDeviceOnline = false;
let isActivelyChecking = false; // State for manual reconnect cycle
let pollTimeoutId = null;
let activeCheckTimeoutId = null;
let forcePollCooldownUntil = 0;

// Critical check to ensure the Blynk token is provided
if (!BLYNK_AUTH_TOKEN) {
    console.error('❌ CRITICAL: BLYNK_AUTH_TOKEN environment variable not set.');
    process.exit(1);
}
console.log('✅ Blynk Auth Token loaded.');

// --- Express Configuration ---
app.use(express.json()); // Middleware to parse JSON bodies
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files (like index.html)

// --- Core Polling Logic ---
const pollBlynkData = async () => {
    // Clear any previously scheduled poll to prevent duplicates
    if (pollTimeoutId) clearTimeout(pollTimeoutId);

    try {
        // Efficiently request all pins in one API call
        const pinParams = VIRTUAL_PINS_TO_POLL.map(pin => `pin=${pin}`).join('&');
        const url = `${BLYNK_API_BASE}/get?token=${BLYNK_AUTH_TOKEN}&${pinParams}`;

        // Fetch data from Blynk with a timeout to prevent hanging
        const blynkResponse = await fetch(url, { timeout: 4000 });

        if (!blynkResponse.ok) {
            throw new Error(`Blynk API Error ${blynkResponse.status}`);
        }

        const newData = await blynkResponse.json();
        const currentUptime = parseInt(newData.v5) || 0;

        // The key to a reliable online check: has the device's uptime value changed?
        // This indicates the device is alive and has sent fresh data.
        const uptimeHasChanged = (currentUptime > 0 && currentUptime !== lastUptimeValue);

        if (uptimeHasChanged) {
            if (!isDeviceOnline) {
                console.log('\n✅ DEVICE ONLINE (Uptime Changed)');
                isDeviceOnline = true;
                isActivelyChecking = false; // Stop active checking once online
                if(activeCheckTimeoutId) clearTimeout(activeCheckTimeoutId);
            }
            lastFreshDataTimestamp = Date.now();
            lastUptimeValue = currentUptime;
            broadcastDataUpdate(newData, true); // Broadcast that the data is fresh
        } else {
            // If uptime hasn't changed, check if the grace period has passed
            const timeSinceFreshData = Date.now() - lastFreshDataTimestamp;
            if (isDeviceOnline && timeSinceFreshData > OFFLINE_GRACE_PERIOD_MS) {
                console.log('\n❌ DEVICE OFFLINE (Grace Period Expired)');
                isDeviceOnline = false;
            }
            broadcastDataUpdate(newData, false); // Broadcast that the data is stale
        }

    } catch (error) {
        console.error(`❌ Poll Error: ${error.message}`);
        if (isDeviceOnline) {
            console.log('   Marking device OFFLINE due to error.');
            isDeviceOnline = false;
        }
    } finally {
        // CRITICAL: Always schedule the next poll, even if an error occurred.
        const nextPollRate = getNextPollRate();
        pollTimeoutId = setTimeout(pollBlynkData, nextPollRate);
    }
};

// --- Intelligent Polling Scheduler ---
function getNextPollRate() {
    if (isDeviceOnline) return POLLING_RATE_ONLINE_MS;
    if (isActivelyChecking) return POLLING_RATE_ACTIVE_CHECK_MS;
    return POLLING_RATE_OFFLINE_MS; // Default to the slowest rate
}

// Function to send data to all connected clients via WebSocket
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
        // Log to console for debugging, but only for fresh updates
        console.log(`📡 Broadcast [ONLINE]: v5=${data.v5}s`);
    }
}

// --- API Endpoint for Commands ---
// This allows the frontend to send commands to the device
app.post('/api/update-pin', async (req, res) => {
    const { pin, value } = req.body;
    console.log(`📲 Command Received: Set ${pin} to ${value}`);
    if (!pin || value === undefined) {
        return res.status(400).json({ error: 'Pin and value are required.' });
    }
    try {
        const url = `${BLYNK_API_BASE}/update?token=${BLYNK_AUTH_TOKEN}&${pin}=${value}`;
        await fetch(url);
        res.status(200).json({ success: true, message: `Pin ${pin} updated.` });
    } catch (error) {
        console.error('❌ Command Failed:', error.message);
        res.status(500).json({ error: 'Failed to update pin.' });
    }
});


// --- Server Initialization & WebSocket Setup ---
const server = app.listen(PORT, () => {
    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║  EvaraTap Server v6.0 - Final Version        ║');
    console.log('╚════════════════════════════════════════════════╝');
    console.log(`\n🚀 Server running at http://localhost:${PORT}`);
    console.log(`- Online Poll Rate: ${POLLING_RATE_ONLINE_MS / 1000}s`);
    console.log(`- Offline Poll Rate: ${POLLING_RATE_OFFLINE_MS / 1000}s`);
    console.log(`- Active Check Poll Rate: ${POLLING_RATE_ACTIVE_CHECK_MS / 1000}s\n`);

    // Start the polling cycle
    pollBlynkData();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('🔌 New client connected via WebSocket.');

    // Listen for messages from the client (e.g., the reconnect button press)
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            // This handles the "Try Reconnecting" button press from the client
            if (data.type === 'force-poll') {
                const now = Date.now();
                if (now < forcePollCooldownUntil) {
                    console.log('❕ Force poll request ignored (cooldown).');
                    return; // Prevent spamming the reconnect button
                }

                console.log('⚡ User triggered active reconnect check...');
                forcePollCooldownUntil = now + ACTIVE_CHECK_DURATION_MS;
                isActivelyChecking = true;

                pollBlynkData(); // Immediately trigger a poll

                // Set a timer to automatically stop the active check period
                if(activeCheckTimeoutId) clearTimeout(activeCheckTimeoutId);
                activeCheckTimeoutId = setTimeout(() => {
                    console.log('⌛ Active check period finished.');
                    isActivelyChecking = false;
                }, ACTIVE_CHECK_DURATION_MS);
            }
        } catch (e) {
            console.error('❗️ Invalid WebSocket message:', e);
        }
    });

    // When a new client connects, immediately send them the latest known state
    ws.send(JSON.stringify({
        type: 'initial-state',
        payload: deviceDataCache,
        isOnline: isDeviceOnline
    }));

    ws.on('close', () => console.log('👋 Client disconnected.'));
    ws.on('error', (error) => console.error('❗️ WebSocket Error:', error));
});
