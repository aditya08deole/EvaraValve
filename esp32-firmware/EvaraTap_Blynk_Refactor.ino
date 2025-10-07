/********************************************************************************
 * EvaraTap ESP32 Flow Control System - v4.5 (Refactored)
 *
 * CHANGE LOG (from v4.4):
 * - CONSOLIDATED PUBLISHING: Replaced publishFlowData() and publishStatusData()
 * with a single publishAllData() function. This ensures all dashboard widgets
 * update simultaneously every second for a synchronized user experience.
 * - UPTIME HEARTBEAT: Implemented a true uptime counter on Virtual Pin V5.
 * This value increments every second, allowing the server to reliably
 * detect if the device is genuinely offline vs. just idle.
 * - CLEANUP: Removed the redundant STATUS_PUBLISH_INTERVAL constant and updated
 * the timer and BLYNK_CONNECTED() function to use the new architecture.
 ********************************************************************************/

#define BLYNK_TEMPLATE_ID "XXXXX"
#define BLYNK_TEMPLATE_NAME "XXXXXX"
#define BLYNK_AUTH_TOKEN "XXXXXX"

#define BLYNK_PRINT Serial
#include <WiFi.h>
#include <BlynkSimpleEsp32.h>
#include <EEPROM.h>

const char* WIFI_SSID = "XXXXX";
const char* WIFI_PASSWORD = "XXXXXX";

const int FLOW_SENSOR_PIN = 32;
// --- FINAL FIX: Using user-confirmed pin layout ---
const int RELAY_OPEN_PIN = 26;
const int RELAY_CLOSE_PIN = 25;
// --- END OF FIX ---
const int LED_PIN = 2;
const float PULSES_PER_LITER = 367.9;

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

const unsigned long SENSOR_PROCESS_INTERVAL = 200;
const unsigned long DATA_PUBLISH_INTERVAL = 1000;
// const unsigned long STATUS_PUBLISH_INTERVAL = 10000; // DELETED as it's no longer needed
const unsigned long WIFI_RECONNECT_INTERVAL = 10000;
const unsigned long BLYNK_RECONNECT_INTERVAL = 5000;
const unsigned long VALVE_RELAY_PULSE_DURATION = 500;
const unsigned long NO_PULSE_FAILSAFE_MS = 30000;

#define EEPROM_SIZE 128
const uint32_t SETTINGS_MAGIC_NUMBER = 0xDEADBEEF;
const unsigned long EEPROM_SAVE_INTERVAL_MS = 60000;
const float EEPROM_SAVE_VOLUME_THRESHOLD_L = 0.1;

struct Settings {
  uint32_t magic_number;
  uint32_t totalPulseCount;
  float volumeLimitLiters;
  uint32_t deviceResetCount;
};

enum DeviceState { INITIALIZING, CONNECTING_WIFI, CONNECTING_BLYNK, OPERATIONAL, OFFLINE_SAFE_MODE };
DeviceState currentState = INITIALIZING;

Settings settings;
BlynkTimer timer;

portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t pulseCount = 0;
volatile unsigned long lastPulseMicros = 0;

uint32_t lastPulseCopy = 0;
float flowRateLPM = 0.0;
float flowSmoothedLPM = 0.0;
const float EMA_ALPHA = 0.3;
float totalVolumeLiters = 0.0;

bool valveOpen = false; // System state starts as 'closed'
unsigned long valveRelayStopTime = 0;
unsigned long lastWifiReconnectAttempt = 0;
unsigned long lastBlynkReconnectAttempt = 0;
unsigned long lastEepromSaveTime = 0;
float lastSavedVolumeLiters = 0.0;
bool interruptAttached = false;

// Add this line with your other global variables
uint32_t deviceUptimeSeconds = 0;

// Function forward declarations for clarity
void IRAM_ATTR pulseCounter();
void saveSettings();
void loadSettings();
void processSensorData();
void publishAllData(); // New consolidated function
void handleWifiConnection();
void handleBlynkConnection();
void handleOperationalState();
void handleOfflineSafeMode();
void updateStatusLED();
void openValve();
void closeValve();
void saveSettingsIfNeeded();

void setup() {
  Serial.begin(115200);
  Serial.println("\nEvaraTap Flow Control System v4.5 (Refactored)");

  pinMode(RELAY_OPEN_PIN, OUTPUT);
  pinMode(RELAY_CLOSE_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(RELAY_OPEN_PIN, LOW);
  digitalWrite(RELAY_CLOSE_PIN, LOW);

  // --- SAFE BOOT SEQUENCE ---
  // This physically closes the valve on every power-up or reset.
  Serial.println("Executing Safe Boot: Ensuring valve is closed...");
  digitalWrite(RELAY_CLOSE_PIN, HIGH);
  delay(VALVE_RELAY_PULSE_DURATION);
  digitalWrite(RELAY_CLOSE_PIN, LOW);
  Serial.println("Valve closed command sent.");
  // --- END OF SAFE BOOT SEQUENCE ---

  EEPROM.begin(EEPROM_SIZE);
  loadSettings();

  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);

  Blynk.config(BLYNK_AUTH_TOKEN);
  
  // --- START: REPLACEMENT CODE for setup() timers ---
  timer.setInterval(SENSOR_PROCESS_INTERVAL, processSensorData);
  timer.setInterval(DATA_PUBLISH_INTERVAL, publishAllData); // This now calls the new unified function
  // --- END: REPLACEMENT CODE ---
  
  currentState = CONNECTING_WIFI;
  Serial.println("Initialization complete. Awaiting connections...");
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

void handleWifiConnection() {
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi Connected!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
    currentState = CONNECTING_BLYNK;
  } else if (millis() - lastWifiReconnectAttempt > WIFI_RECONNECT_INTERVAL) {
    Serial.print("Attempting WiFi connection to: ");
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
  
  if (millis() - lastBlynkReconnectAttempt > BLYNK_RECONNECT_INTERVAL) {
    Serial.println("Attempting Blynk connection...");
    lastBlynkReconnectAttempt = millis();
  }
}

void handleOperationalState() {
  if (!Blynk.connected()) {
    Serial.println("Lost connection to Blynk, entering safe mode.");
    if (valveOpen) {
      Serial.println("Closing valve as a precaution.");
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

void IRAM_ATTR pulseCounter() {
  portENTER_CRITICAL_ISR(&mux);
  pulseCount++;
  lastPulseMicros = micros();
  portEXIT_CRITICAL_ISR(&mux);
}

void processSensorData() {
  uint32_t currentPulseCopy = 0;
  unsigned long currentPulseMicrosCopy = 0;

  portENTER_CRITICAL(&mux);
  currentPulseCopy = pulseCount;
  currentPulseMicrosCopy = lastPulseMicros;
  portEXIT_CRITICAL(&mux);

  uint32_t pulsesThisInterval = currentPulseCopy - lastPulseCopy;
  lastPulseCopy = currentPulseCopy;

  float volumeIncrement = pulsesThisInterval / PULSES_PER_LITER;
  float instantaneousLPM = (volumeIncrement / (SENSOR_PROCESS_INTERVAL / 1000.0)) * 60.0;
  
  flowSmoothedLPM = (EMA_ALPHA * instantaneousLPM) + (1.0 - EMA_ALPHA) * flowSmoothedLPM;
  totalVolumeLiters = currentPulseCopy / PULSES_PER_LITER;

  if (valveOpen && (micros() - currentPulseMicrosCopy) > (NO_PULSE_FAILSAFE_MS * 1000UL)) {
    Serial.println("SENSOR FAILSAFE: No pulses detected, closing valve");
    closeValve();
  }

  if (valveOpen && settings.volumeLimitLiters > 0 && totalVolumeLiters >= settings.volumeLimitLiters) {
    Serial.printf("SAFETY: Volume limit %.1fL reached, closing valve\n", settings.volumeLimitLiters);
    closeValve();
  }

  saveSettingsIfNeeded();
}

// --- START: REPLACEMENT CODE for publishing functions ---
// This new function replaces both publishFlowData() and publishStatusData()
void publishAllData() {
  // Increment uptime every time we publish (which is every second)
  deviceUptimeSeconds++;

  // Send the high-frequency flow and volume data
  Blynk.virtualWrite(VPIN_TOTAL_VOLUME, totalVolumeLiters);
  Blynk.virtualWrite(VPIN_FLOW_RATE, flowSmoothedLPM);

  // Also send the critical status data in the same packet
  Blynk.virtualWrite(VPIN_VALVE_STATUS, valveOpen ? 1 : 0);
  Blynk.virtualWrite(VPIN_VOLUME_LIMIT, settings.volumeLimitLiters);
  Blynk.virtualWrite(VPIN_RESET_COUNT, settings.deviceResetCount);

  // Send the new uptime counter on V5 as a true heartbeat
  Blynk.virtualWrite(VPIN_ONLINE_STATUS, deviceUptimeSeconds);

  // Update the serial monitor with a comprehensive log message
  Serial.printf("Published Data Packet: %.2f L, %.2f LPM, Uptime: %u s, Valve: %s\n",
    totalVolumeLiters, flowSmoothedLPM, deviceUptimeSeconds, valveOpen ? "OPEN" : "CLOSED");
}
// --- END: REPLACEMENT CODE ---


// --- START: REPLACEMENT CODE for BLYNK_CONNECTED() ---
BLYNK_CONNECTED() {
  Serial.println("Blynk Connected! Syncing state...");
  Blynk.syncAll();
  
  // Sync all data immediately using the new consolidated function
  publishAllData();
  
  if (currentState != OPERATIONAL) {
    currentState = OPERATIONAL;
  }

  if (!interruptAttached) {
    attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN), pulseCounter, FALLING);
    interruptAttached = true;
    Serial.println("Flow sensor interrupt attached.");
  }
}
// --- END: REPLACEMENT CODE ---

BLYNK_WRITE(VPIN_CMD_OPEN_VALVE) { if (param.asInt() == 1) { openValve(); } }
BLYNK_WRITE(VPIN_CMD_CLOSE_VALVE) { if (param.asInt() == 1) { closeValve(); } }

BLYNK_WRITE(VPIN_CMD_RESET_VOLUME) {
  if (param.asInt() == 1) {
    Serial.println("Volume reset by app.");
    
    portENTER_CRITICAL(&mux);
    pulseCount = 0;
    lastPulseCopy = 0;
    portEXIT_CRITICAL(&mux);

    totalVolumeLiters = 0.0;
    
    Blynk.virtualWrite(VPIN_TOTAL_VOLUME, 0);
    saveSettings(); 
  }
}

BLYNK_WRITE(VPIN_CMD_SET_LIMIT) {
  float newLimit = param.asFloat();
  if (newLimit >= 1.0 && newLimit <= 9999.0) {
    settings.volumeLimitLiters = newLimit;
    Blynk.virtualWrite(VPIN_VOLUME_LIMIT, newLimit);
    saveSettings(); 
    Serial.printf("Volume limit set to: %.1fL by app\n", newLimit);
  }
}

void openValve() {
  if (valveOpen) return;
  Serial.println("Opening valve...");
  digitalWrite(RELAY_CLOSE_PIN, LOW);
  digitalWrite(RELAY_OPEN_PIN, HIGH);
  valveRelayStopTime = millis() + VALVE_RELAY_PULSE_DURATION;
  valveOpen = true;
  if(Blynk.connected()) Blynk.virtualWrite(VPIN_VALVE_STATUS, 1);
}

void closeValve() {
  if (!valveOpen) return;
  Serial.println("Closing valve...");
  digitalWrite(RELAY_OPEN_PIN, LOW);
  digitalWrite(RELAY_CLOSE_PIN, HIGH);
  valveRelayStopTime = millis() + VALVE_RELAY_PULSE_DURATION;
  valveOpen = false;
  if(Blynk.connected()) Blynk.virtualWrite(VPIN_VALVE_STATUS, 0);
}

void loadSettings() {
  EEPROM.get(0, settings);
  if (settings.magic_number != SETTINGS_MAGIC_NUMBER) {
    Serial.println("EEPROM invalid. Loading defaults.");
    settings.magic_number = SETTINGS_MAGIC_NUMBER;
    settings.totalPulseCount = 0;
    settings.volumeLimitLiters = 100.0;
    settings.deviceResetCount = 0;
  } else {
    Serial.println("EEPROM settings loaded.");
  }
  
  portENTER_CRITICAL(&mux);
  pulseCount = settings.totalPulseCount;
  lastPulseCopy = settings.totalPulseCount;
  portEXIT_CRITICAL(&mux);

  totalVolumeLiters = (float)settings.totalPulseCount / PULSES_PER_LITER;
  lastSavedVolumeLiters = totalVolumeLiters;

  settings.deviceResetCount++;
  saveSettings();
  
  Serial.printf("Volume: %.2fL, Limit: %.1fL, Boot Count: %u\n",
    totalVolumeLiters, settings.volumeLimitLiters, settings.deviceResetCount);
}

void saveSettings() {
  portENTER_CRITICAL(&mux);
  settings.totalPulseCount = pulseCount;
  portEXIT_CRITICAL(&mux);
  
  EEPROM.put(0, settings);
  if (!EEPROM.commit()) {
    Serial.println("ERROR: Failed to commit settings to EEPROM!");
  } else {
    Serial.println("Settings saved to EEPROM.");
    lastEepromSaveTime = millis();
    lastSavedVolumeLiters = totalVolumeLiters;
  }
}

void saveSettingsIfNeeded() {
  bool timeExceeded = millis() - lastEepromSaveTime > EEPROM_SAVE_INTERVAL_MS;
  bool volumeChanged = abs(totalVolumeLiters - lastSavedVolumeLiters) >= EEPROM_SAVE_VOLUME_THRESHOLD_L;

  if (timeExceeded || volumeChanged) {
    saveSettings();
  }
}

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
