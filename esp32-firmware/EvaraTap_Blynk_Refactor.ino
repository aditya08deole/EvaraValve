/********************************************************************************
 * EvaraTap ESP32 Flow Control System - v4.0 (Architectural Refactor)
 *
 * This version implements a major architectural overhaul for improved precision,
 * concurrency safety, and hardware longevity based on professional IoT principles.
 *
 * CHANGE LOG (from v3.6):
 * - Concurrency Safety: Replaced `noInterrupts()` with a FreeRTOS critical
 * section (portMUX) for safe, atomic access to shared ISR variables on the
 * dual-core ESP32.
 * - Cumulative Pulse Counting: The ISR `pulseCount` is no longer reset. The
 * main loop calculates the delta between readings, making the system more
 * robust against missed processing cycles and overflow.
 * - High-Precision ISR: The ISR now uses `micros()` for timestamps, improving
 * the accuracy of the "no pulse" fail-safe.
 * - Smoothed Flow Rate (EMA): Implemented an Exponential Moving Average (EMA)
 * filter on the flow rate calculation to provide a stable, non-jittery
 * reading on the dashboard.
 * - Intelligent EEPROM Persistence: EEPROM writes are now conditional,
 * occurring only after a set time interval OR a significant change in volume,
 * drastically reducing flash memory wear. Direct saves still occur on
 * critical events (e.g., valve changes).
 * - Refactored Data Processing: The `processSensorData` function has been
 * completely rewritten to support the new cumulative/delta logic.
 * - Refined Reset Logic: The "reset volume" command now safely resets the
 * cumulative pulse counters within a critical section.
 ********************************************************************************/

// ============= BLYNK IoT PLATFORM CREDENTIALS =============
#define BLYNK_TEMPLATE_ID "xxxx"
#define BLYNK_TEMPLATE_NAME "xxxxx"
#define BLYNK_AUTH_TOKEN "xxxxx"

// ============= LIBRARY INCLUDES =============
#define BLYNK_PRINT Serial
#include <WiFi.h>
#include <BlynkSimpleEsp32.h>
#include <EEPROM.h>

// ============= USER CONFIGURATION =============
const char* WIFI_SSID = "xxxxx";
const char* WIFI_PASSWORD = "xxxxxx";

// ============= HARDWARE CONFIGURATION =============
const int FLOW_SENSOR_PIN = 32;
const int RELAY_OPEN_PIN = 25;
const int RELAY_CLOSE_PIN = 26;
const int LED_PIN = 2;
const float PULSES_PER_LITER = 367.9; // Calibration constant

// ============= BLYNK VIRTUAL PINS =============
#define VPIN_TOTAL_VOLUME   V0
#define VPIN_FLOW_RATE      V1
#define VPIN_VALVE_STATUS   V2
#define VPIN_RESET_COUNT    V3
#define VPIN_VOLUME_LIMIT   V4
#define VPIN_ONLINE_STATUS  V5
#define VPIN_CMD_OPEN_VALVE V10
#define VPIN_CMD_CLOSE_VALVE V11
#define VPIN_CMD_RESET_VOLUME V12
#define VPIN_CMD_SET_LIMIT  V13

// ============= SYSTEM TIMING (ms) =============
const unsigned long SENSOR_PROCESS_INTERVAL = 200;    // Process pulses 5 times/sec
const unsigned long DATA_PUBLISH_INTERVAL = 1000;     // Publish to Blynk every second
const unsigned long STATUS_PUBLISH_INTERVAL = 30000;  // 30 seconds for heartbeat
const unsigned long WIFI_RECONNECT_INTERVAL = 10000;  // 10 seconds
const unsigned long BLYNK_RECONNECT_INTERVAL = 5000;  // 5 seconds
const unsigned long VALVE_RELAY_PULSE_DURATION = 500; // Latching relay pulse time
const unsigned long NO_PULSE_FAILSAFE_MS = 30000;     // 30 seconds before closing valve if no flow

// ============= EEPROM & PERSISTENCE CONFIGURATION =============
#define EEPROM_SIZE 128
const uint32_t SETTINGS_MAGIC_NUMBER = 0xDEADBEEF;
const unsigned long EEPROM_SAVE_INTERVAL_MS = 60000;      // Save at least once per minute
const float EEPROM_SAVE_VOLUME_THRESHOLD_L = 0.1;       // Or save if volume changes by this much

struct Settings {
  uint32_t magic_number;
  uint32_t totalPulseCount; // NEW: We persist total pulses for accuracy
  float volumeLimitLiters;
  uint32_t deviceResetCount;
};

// ============= GLOBAL STATE & VARIABLES =============
enum DeviceState { INITIALIZING, CONNECTING_WIFI, CONNECTING_BLYNK, OPERATIONAL, OFFLINE_SAFE_MODE };
DeviceState currentState = INITIALIZING;

Settings settings;
BlynkTimer timer;

// --- ISR & Concurrency-Safe Variables ---
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED; // NEW: FreeRTOS mutex for critical sections
volatile uint32_t pulseCount = 0;
volatile unsigned long lastPulseMicros = 0;

// --- Data Processing Variables ---
uint32_t lastPulseCopy = 0; // NEW: For calculating deltas
float flowRateLPM = 0.0;
float flowSmoothedLPM = 0.0; // NEW: For EMA smoothing
const float EMA_ALPHA = 0.3; // NEW: Smoothing factor (lower = smoother)
float totalVolumeLiters = 0.0;

// --- System State Variables ---
bool valveOpen = false;
unsigned long valveRelayStopTime = 0;
unsigned long lastWifiReconnectAttempt = 0;
unsigned long lastBlynkReconnectAttempt = 0;
unsigned long lastEepromSaveTime = 0;
float lastSavedVolumeLiters = 0.0;

// ============= FUNCTION FORWARD DECLARATIONS =============
void IRAM_ATTR pulseCounter();
void saveSettings();


// ============= CORE FUNCTIONS =============

void setup() {
  Serial.begin(115200);
  Serial.println("\n🌊 EvaraTap Flow Control System v4.0 (Architectural Refactor)");

  pinMode(RELAY_OPEN_PIN, OUTPUT);
  pinMode(RELAY_CLOSE_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(RELAY_OPEN_PIN, LOW);
  digitalWrite(RELAY_CLOSE_PIN, LOW);

  EEPROM.begin(EEPROM_SIZE);
  loadSettings();

  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN), pulseCounter, FALLING);

  Blynk.config(BLYNK_AUTH_TOKEN);
  Blynk.connect(10000);

  timer.setInterval(SENSOR_PROCESS_INTERVAL, processSensorData);
  timer.setInterval(DATA_PUBLISH_INTERVAL, publishFlowData);
  timer.setInterval(STATUS_PUBLISH_INTERVAL, publishStatusData);
  
  currentState = CONNECTING_WIFI;
  Serial.println("✅ Initialization complete. Starting state machine.");
}

void loop() {
  if (valveRelayStopTime > 0 && millis() >= valveRelayStopTime) {
    digitalWrite(RELAY_OPEN_PIN, LOW);
    digitalWrite(RELAY_CLOSE_PIN, LOW);
    valveRelayStopTime = 0;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Blynk.run();
  }
  
  if (currentState == OPERATIONAL) {
    timer.run();
  }

  switch (currentState) {
    case CONNECTING_WIFI:   handleWifiConnection();   break;
    case CONNECTING_BLYNK:  handleBlynkConnection();  break;
    case OPERATIONAL:       handleOperationalState(); break;
    case OFFLINE_SAFE_MODE: handleOfflineSafeMode();  break;
    default: break;
  }
  updateStatusLED();
}

// ============= STATE HANDLERS (Unchanged) =============

void handleWifiConnection() {
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi Connected!");
    Serial.print("   IP Address: ");
    Serial.println(WiFi.localIP());
    currentState = CONNECTING_BLYNK;
  } else if (millis() - lastWifiReconnectAttempt > WIFI_RECONNECT_INTERVAL) {
    Serial.print("📶 Attempting WiFi connection to: ");
    Serial.println(WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    lastWifiReconnectAttempt = millis();
  }
}

void handleBlynkConnection() {
  if (WiFi.status() != WL_CONNECTED) {
    currentState = CONNECTING_WIFI;
    return;
  }
  
  if (Blynk.connected()) {
    Serial.println("✅ Blynk Connected!");
    currentState = OPERATIONAL;
  } else if (millis() - lastBlynkReconnectAttempt > BLYNK_RECONNECT_INTERVAL) {
    Serial.println("☁️ Attempting Blynk connection...");
    lastBlynkReconnectAttempt = millis();
  }
}

void handleOperationalState() {
  if (!Blynk.connected()) {
    Serial.println("⚠️ Lost connection to Blynk, entering safe mode.");
    if (valveOpen) {
      Serial.println("   Closing valve as a precaution.");
      closeValve();
    }
    currentState = OFFLINE_SAFE_MODE;
  }
}

void handleOfflineSafeMode() {
  if (WiFi.status() != WL_CONNECTED) {
    currentState = CONNECTING_WIFI;
  } 
}

// ============= INTERRUPT SERVICE ROUTINE =============

void IRAM_ATTR pulseCounter() {
  portENTER_CRITICAL_ISR(&mux);
  pulseCount++;
  lastPulseMicros = micros();
  portEXIT_CRITICAL_ISR(&mux);
}

// ============= DATA PROCESSING & PUBLISHING (REFACTORED) =============

void processSensorData() {
  uint32_t currentPulseCopy = 0;
  unsigned long currentPulseMicrosCopy = 0;

  // OPTIMIZATION: Atomic copy of shared variables inside a critical section
  portENTER_CRITICAL(&mux);
  currentPulseCopy = pulseCount;
  currentPulseMicrosCopy = lastPulseMicros;
  portEXIT_CRITICAL(&mux);

  // OPTIMIZATION: Calculate delta since last reading (handles overflow)
  uint32_t pulsesThisInterval = currentPulseCopy - lastPulseCopy;
  lastPulseCopy = currentPulseCopy;

  // --- Calculate Flow Rate ---
  float volumeIncrement = pulsesThisInterval / PULSES_PER_LITER;
  float instantaneousLPM = (volumeIncrement / (SENSOR_PROCESS_INTERVAL / 1000.0)) * 60.0;
  
  // OPTIMIZATION: Apply Exponential Moving Average (EMA) for smoothing
  flowSmoothedLPM = (EMA_ALPHA * instantaneousLPM) + (1.0 - EMA_ALPHA) * flowSmoothedLPM;

  // --- Calculate Total Volume ---
  // OPTIMIZATION: Total volume is now derived from the master cumulative pulse count
  totalVolumeLiters = currentPulseCopy / PULSES_PER_LITER;

  // --- Fail-Safes ---
  if (valveOpen && (micros() - currentPulseMicrosCopy) > (NO_PULSE_FAILSAFE_MS * 1000UL)) {
    Serial.println("🛡️ SENSOR FAILSAFE: No pulses detected, closing valve");
    closeValve();
  }

  if (valveOpen && settings.volumeLimitLiters > 0 && totalVolumeLiters >= settings.volumeLimitLiters) {
    Serial.printf("🛡️ SAFETY: Volume limit %.1fL reached, closing valve\n", settings.volumeLimitLiters);
    closeValve();
  }

  // --- Intelligent Persistence ---
  saveSettingsIfNeeded();
}


void publishFlowData() {
  Blynk.virtualWrite(VPIN_TOTAL_VOLUME, totalVolumeLiters);
  Blynk.virtualWrite(VPIN_FLOW_RATE, flowSmoothedLPM); // Publish the smoothed value
  Serial.printf("📤 Published Flow: %.2f L, %.2f LPM (Smoothed)\n", totalVolumeLiters, flowSmoothedLPM);
}

void publishStatusData() {
  Blynk.virtualWrite(VPIN_VALVE_STATUS, valveOpen ? 1 : 0);
  Blynk.virtualWrite(VPIN_RESET_COUNT, settings.deviceResetCount);
  Blynk.virtualWrite(VPIN_VOLUME_LIMIT, settings.volumeLimitLiters);
  Blynk.virtualWrite(VPIN_ONLINE_STATUS, 1);
  Serial.println("📤 Published Status Heartbeat");
}

// ============= BLYNK COMMAND HANDLERS =============

BLYNK_CONNECTED() {
  Serial.println("   Blynk reconnected. Syncing app state with device...");
  Blynk.syncAll();
  publishStatusData();
  if (currentState == OFFLINE_SAFE_MODE || currentState == CONNECTING_BLYNK) {
    currentState = OPERATIONAL;
  }
}

BLYNK_WRITE(VPIN_CMD_OPEN_VALVE) { if (param.asInt() == 1) { openValve(); } }
BLYNK_WRITE(VPIN_CMD_CLOSE_VALVE) { if (param.asInt() == 1) { closeValve(); } }

BLYNK_WRITE(VPIN_CMD_RESET_VOLUME) {
  if (param.asInt() == 1) {
    Serial.println("🔄 Volume reset to 0L by app.");
    
    // OPTIMIZATION: Atomically reset all pulse counters
    portENTER_CRITICAL(&mux);
    pulseCount = 0;
    lastPulseCopy = 0;
    portEXIT_CRITICAL(&mux);

    totalVolumeLiters = 0.0; // Also reset the float representation
    
    Blynk.virtualWrite(VPIN_TOTAL_VOLUME, 0);
    saveSettings(); // Force save on manual reset
  }
}

BLYNK_WRITE(VPIN_CMD_SET_LIMIT) {
  float newLimit = param.asFloat();
  if (newLimit >= 1.0 && newLimit <= 9999.0) {
    settings.volumeLimitLiters = newLimit;
    Blynk.virtualWrite(VPIN_VOLUME_LIMIT, newLimit);
    saveSettings(); // Force save on manual limit change
    Serial.printf("🎯 Volume limit set to: %.1fL by app\n", newLimit);
  }
}

// ============= VALVE CONTROL =============

void openValve() {
  if (valveOpen) return;
  Serial.println("🔓 Opening valve...");
  digitalWrite(RELAY_CLOSE_PIN, LOW);
  digitalWrite(RELAY_OPEN_PIN, HIGH);
  valveRelayStopTime = millis() + VALVE_RELAY_PULSE_DURATION;
  valveOpen = true;
  if(Blynk.connected()) Blynk.virtualWrite(VPIN_VALVE_STATUS, 1);
  saveSettings();
}

void closeValve() {
  if (!valveOpen) return;
  Serial.println("🔒 Closing valve...");
  digitalWrite(RELAY_OPEN_PIN, LOW);
  digitalWrite(RELAY_CLOSE_PIN, HIGH);
  valveRelayStopTime = millis() + VALVE_RELAY_PULSE_DURATION;
  valveOpen = false;
  if(Blynk.connected()) Blynk.virtualWrite(VPIN_VALVE_STATUS, 0);
  saveSettings();
}

// ============= EEPROM & PERSISTENCE (REFACTORED) =============

void loadSettings() {
  EEPROM.get(0, settings);
  if (settings.magic_number != SETTINGS_MAGIC_NUMBER) {
    Serial.println("⚠️ EEPROM invalid or uninitialized. Loading defaults.");
    settings.magic_number = SETTINGS_MAGIC_NUMBER;
    settings.totalPulseCount = 0;
    settings.volumeLimitLiters = 100.0;
    settings.deviceResetCount = 0;
  } else {
    Serial.println("✅ EEPROM settings loaded successfully.");
  }
  
  // Initialize volatile counters from persisted data
  portENTER_CRITICAL(&mux);
  pulseCount = settings.totalPulseCount;
  lastPulseCopy = settings.totalPulseCount;
  portEXIT_CRITICAL(&mux);

  totalVolumeLiters = (float)settings.totalPulseCount / PULSES_PER_LITER;
  lastSavedVolumeLiters = totalVolumeLiters;

  settings.deviceResetCount++;
  saveSettings(); // Save the incremented boot count immediately
  
  Serial.printf("   Total Volume: %.2fL, Limit: %.1fL, Boot Count: %u\n",
    totalVolumeLiters, settings.volumeLimitLiters, settings.deviceResetCount);
}

void saveSettings() {
  // Update the settings struct with the latest master pulse count
  portENTER_CRITICAL(&mux);
  settings.totalPulseCount = pulseCount;
  portEXIT_CRITICAL(&mux);
  
  EEPROM.put(0, settings);
  if (!EEPROM.commit()) {
    Serial.println("❌ ERROR: Failed to commit settings to EEPROM!");
  } else {
    Serial.println("💾 Settings saved to EEPROM.");
    lastEepromSaveTime = millis();
    lastSavedVolumeLiters = totalVolumeLiters;
  }
}

// NEW: Intelligent save function to reduce EEPROM wear
void saveSettingsIfNeeded() {
  bool timeExceeded = millis() - lastEepromSaveTime > EEPROM_SAVE_INTERVAL_MS;
  bool volumeChanged = abs(totalVolumeLiters - lastSavedVolumeLiters) >= EEPROM_SAVE_VOLUME_THRESHOLD_L;

  if (timeExceeded || volumeChanged) {
    if(volumeChanged) Serial.printf("   Volume change threshold reached (%.2f L). ", totalVolumeLiters);
    if(timeExceeded) Serial.printf("   Save interval of %lus reached. ", EEPROM_SAVE_INTERVAL_MS / 1000);
    saveSettings();
  }
}


// ============= UTILITIES (Unchanged) =============

void updateStatusLED() {
  static unsigned long lastBlink = 0;
  static bool ledState = false;
  unsigned long interval = 1000;

  switch(currentState) {
    case OPERATIONAL: 
      digitalWrite(LED_PIN, HIGH);
      return;
    case CONNECTING_WIFI: interval = 500; break;
    case CONNECTING_BLYNK: interval = 250; break;
    case OFFLINE_SAFE_MODE: interval = 100; break;
  }

  if (millis() - lastBlink > interval) {
    ledState = !ledState;
    digitalWrite(LED_PIN, ledState);
    lastBlink = millis();
  }
}
