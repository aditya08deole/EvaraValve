// --- IMPORTS ---
import express from 'express';
import fetch from 'node-fetch';
import rateLimit from 'express-rate-limit';

// --- CONFIGURATION ---
// For local development, consider using the `dotenv` package to load these from a .env file.
const config = {
  port: process.env.PORT || 10001,
  adafruit: {
    username: process.env.ADAFRUIT_IO_USERNAME,
    apiKey: process.env.ADAFRUIT_IO_KEY,
    feedKey: process.env.ADAFRUIT_IO_FEED_KEY,
  },
  // IMPORTANT: Set this to your web dashboard's domain in production.
  // e.g., 'https://dashboard.evaratap.com'
  security: {
    allowedOrigin: process.env.ALLOWED_ORIGIN,
  },
};

// --- STARTUP VALIDATION ---
if (!config.adafruit.username || !config.adafruit.apiKey || !config.adafruit.feedKey) {
  console.error('❌ CRITICAL ERROR: Adafruit IO credentials are not fully set in environment variables.');
  process.exit(1);
}
if (!config.security.allowedOrigin) {
    console.warn('⚠️ SECURITY WARNING: ALLOWED_ORIGIN is not set. CORS will block all cross-origin requests.');
}


// --- UTILITIES ---
const logger = {
  info: (message, ...args) => console.log(`[${new Date().toISOString()}] INFO:`, message, ...args),
  error: (message, ...args) => console.error(`[${new Date().toISOString()}] ERROR:`, message, ...args),
};

const app = express();


// --- MIDDLEWARE ---
// 1. Rate Limiting: Protects against brute-force attacks.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please try again later.' },
});

// 2. Body Parser: To handle JSON request bodies.
app.use(express.json());

// 3. Security Headers & CORS:
app.use((req, res, next) => {
  // Only allow requests from the specified origin.
  res.header('Access-Control-Allow-Origin', config.security.allowedOrigin);
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests for CORS
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});


// --- SERVICE LAYER (ADAFRUIT API INTERACTION) ---

/**
 * Publishes a value to a specific Adafruit IO feed.
 * @param {string} value The string value to send to the feed (e.g., "ON", "OFF").
 * @returns {Promise<object>} The JSON response from the Adafruit API.
 * @throws {Error} If the API request fails or returns a non-ok status.
 */
async function publishToAdafruitFeed(value) {
  const { username, feedKey, apiKey } = config.adafruit;
  const url = `https://io.adafruit.com/api/v2/${username}/feeds/${feedKey}/data`;
  logger.info(`Publishing "${value}" to Adafruit feed: ${feedKey}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AIO-Key': apiKey,
    },
    body: JSON.stringify({ value }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    // This custom error will be caught by our central error handler
    throw new Error(`Adafruit API Error (${response.status}): ${errorText}`);
  }

  return response.json();
}


// --- ROUTE HANDLERS & ROUTING ---

/**
 * A higher-order function to create a reusable command handler.
 * This avoids duplicating the try/catch and response logic.
 * @param {string} command The command to be sent (e.g., "ON", "OFF").
 * @returns {express.RequestHandler} An async Express route handler.
 */
const createCommandHandler = (command) => async (req, res) => {
    logger.info(`Received request to send command: ${command}`);
    const result = await publishToAdafruitFeed(command);
    res.status(200).json({
      success: true,
      message: `Command '${command}' sent successfully.`,
      data: result,
    });
};

// Apply rate limiting to command endpoints
app.use(['/power-on', '/power-off'], apiLimiter);

app.post('/power-on', createCommandHandler('ON'));
app.post('/power-off', createCommandHandler('OFF'));

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'mqtt-proxy',
    timestamp: new Date().toISOString(),
  });
});


// --- CENTRAL ERROR HANDLING ---
// This middleware catches any errors passed by `next(error)`.
// By wrapping async handlers, we ensure all promise rejections are caught here.
app.use((err, req, res, next) => {
  logger.error(err.message);
  // Avoid leaking stack traces or sensitive info in production
  res.status(500).json({
    success: false,
    error: err.message || 'An internal server error occurred.',
  });
});


// --- SERVER INITIALIZATION ---
app.listen(config.port, () => {
  logger.info(`🚀 EvaraTap MQTT Proxy v4.0 is running on port ${config.port}`);
  logger.info(`📡 Relaying commands for Adafruit user "${config.adafruit.username}" to feed "${config.adafruit.feedKey}"`);
  if (config.security.allowedOrigin) {
      logger.info(`🔒 Accepting requests only from: ${config.security.allowedOrigin}`);
  }
});
