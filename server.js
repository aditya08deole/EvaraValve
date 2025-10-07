/**
 * EvaraTap Secure Backend for Blynk on Render
 *
 * This server acts as a secure, real-time proxy between the public dashboard
 * and the Blynk API. It uses a WebSocket connection to push data updates
 * to clients efficiently.
 *
 * Architecture:
 * 1. Caching: A server-side cache (`deviceDataCache`) holds the latest device state.
 * 2. Polling: The server polls the Blynk API at a regular interval (`POLLING_RATE_MS`).
 * 3. Heartbeat Logic: The server checks the ESP32's uptime counter (V5). If the counter
 * stops incrementing, the server halts data broadcasts, allowing the frontend to
 * correctly identify an offline device.
 * 4. WebSocket Broadcasting: When data changes, it's pushed to all connected clients.
 * 5. HTTP for Commands: State-changing actions (e.g., opening a valve) are handled
 * via a standard, reliable HTTP POST endpoint.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { WebSocketServer, WebSocket } from 'ws'; // Import WebSocket classes

const app = express();
const PORT = process.env.PORT || 10000;

// --- IMPORTANT: SET THESE IN YOUR RENDER ENVIRONMENT VARIABLES ---
const BLYNK_AUTH_TOKEN = process.env.BLYNK_AUTH_TOKEN;
const BLYNK_API_BASE = 'https://blynk.cloud/external/api';

// --- APPLICATION CONSTANTS ---
const POLLING_RATE_MS = 1000; // Poll Blynk every 1 second
// Define all virtual pins your dashboard needs to monitor here.
const VIRTUAL_PINS_TO_POLL = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'];

// --- STATE MANAGEMENT & CACHE ---
let deviceDataCache = {}; // In-memory cache for device pin data
// --- START: NEW VARIABLES for server.js ---
let lastUptimeValue = -1; // Tracks the device heartbeat counter from V5
let lastDataReceivedTimestamp = Date.now(); // Tracks the time of the last valid data packet
// --- END: NEW VARIABLES ---

// --- VALIDATION ---
if (!BLYNK_AUTH_TOKEN) {
    console.error('❌ CRITICAL ERROR: BLYNK_AUTH_TOKEN is not set in the environment variables.');
    process.exit(1); // Stop the server if the token is missing
}

// --- EXPRESS CONFIGURATION ---
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// --- CORE LOGIC: BLYNK DATA POLLING ---

// --- START: REPLACEMENT CODE for pollBlynkData function in server.js ---
const pollBlynkData = async () => {
    const pinParams = VIRTUAL_PINS_TO_POLL.join('&');
    const url = `${BLYNK_API_BASE}/get?token=${BLYNK_AUTH_TOKEN}&${pinParams}`;

    try {
        const blynkResponse = await fetch(url);
        if (!blynkResponse.ok) {
            throw new Error(`Blynk API responded with status: ${blynkResponse.status}`);
        }
        
        const newData = await blynkResponse.json();
        const currentUptime = newData.v5; // V5 is our uptime pin from the ESP32

        // --- NEW HEARTBEAT LOGIC ---
        // Check if the uptime value has changed. If it's the same as the last time we checked...
        if (currentUptime !== undefined && lastUptimeValue === currentUptime) {
            // ...and if more than 5 seconds have passed since we last saw a change...
            if (Date.now() - lastDataReceivedTimestamp > 5000) {
                // ...then we assume the ESP32 is offline and sending stale data.
                console.warn('Stale data detected (uptime not changing). Halting broadcast.');
                // We stop here and DO NOT broadcast, which will cause the frontend's timer to expire.
                return; 
            }
        } else {
            // If we get here, the uptime value has changed, so the data is fresh.
            // We update our trackers with the new uptime and the current time.
            lastUptimeValue = currentUptime;
            lastDataReceivedTimestamp = Date.now();
        }

        // If data is fresh, update the cache and broadcast to all connected clients.
        deviceDataCache = newData;
        broadcastDataUpdate();

    } catch (error) {
        console.error('Polling Error: Failed to fetch from Blynk API:', error.message);
    }
};
// --- END: REPLACEMENT CODE ---

// --- API ENDPOINTS ---

// This endpoint is for state-changing commands from the client (e.g., turning on a valve).
// Data retrieval is now handled by the WebSocket push mechanism.
app.post('/api/update-pin', async (req, res) => {
    const { pin, value } = req.body;
    if (!pin || value === undefined) {
        return res.status(400).json({ error: 'Pin and value are required.' });
    }

    try {
        const url = `${BLYNK_API_BASE}/update?token=${BLYNK_AUTH_TOKEN}&${pin}=${value}`;
        const blynkResponse = await fetch(url);
        
        if (!blynkResponse.ok) {
            throw new Error(`Blynk API responded with status: ${blynkResponse.status}`);
        }
        
        // After a successful update, trigger an immediate poll to get the latest state faster.
        // This makes the UI feel more responsive.
        pollBlynkData();

        res.status(200).json({ success: true, message: `Pin ${pin} updated.` });

    } catch (error) {
        console.error('Error updating Blynk pin:', error.message);
        res.status(500).json({ error: 'Failed to update pin.' });
    }
});


// --- SERVER BOILERPLATE ---

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
});

// Serve the main dashboard page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// --- SERVER INITIALIZATION ---

// Start the Express server and attach the WebSocket server to it.
const server = app.listen(PORT, () => {
    console.log(`🚀 EvaraTap Server is running on port ${PORT}`);
    console.log(`🔗 Environment: ${process.env.NODE_ENV || 'development'}`);
    
    // Start polling Blynk for data immediately after the server starts.
    setInterval(pollBlynkData, POLLING_RATE_MS);
});


// --- WEBSOCKET SERVER LOGIC ---

const wss = new WebSocketServer({ server });

/**
 * Broadcasts the latest cached data to all connected WebSocket clients.
 */
function broadcastDataUpdate() {
    const message = JSON.stringify({
        type: 'data-update',
        payload: deviceDataCache
    });

    wss.clients.forEach(client => {
        // Check if the client connection is still open before sending.
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Handle new client connections
wss.on('connection', (ws) => {
    console.log('✅ Client connected to WebSocket.');

    // Immediately send the current cached state to the new client.
    // This ensures the dashboard loads with data instantly.
    const initialStateMessage = JSON.stringify({
        type: 'initial-state',
        payload: deviceDataCache
    });
    ws.send(initialStateMessage);

    // Handle client disconnection
    ws.on('close', () => {
        console.log('❌ Client disconnected.');
    });

    // Handle potential errors on a client connection
    ws.on('error', (error) => {
        console.error('WebSocket client error:', error);
    });
});
