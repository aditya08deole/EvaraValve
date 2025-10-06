/*
 * EvaraTap ESP32 Flow Control System - v3.4 Final Deployment
 *
 * Architecture:
 * - Explicit, non-blocking state machine for robust connection management.
 * - Decoupled timers for sensor processing and network publishing.
 * - Sensor data is processed at a high frequency for maximum accuracy.
 * - Network data is published at the fastest practical rate for Blynk's free tier.
 * - Interrupt-driven pulse accumulation for 100% data accuracy.
 * - Enhanced data-loss prevention by ensuring pulses are never discarded.
 * - Safe EEPROM persistence using a struct with a magic number.
 */

#define BLYNK_PRINT Serial
#include <WiFi.h>
#include <BlynkSimpleEsp32.h>
#include <EEPROM.h>

// ============= USER CONFIGURATION =============
// Get this Auth Token from the Blynk App or Web Console
char BLYNK_AUTH_TOKEN[] = "YOUR_BLYNK_AUTH_TOKEN";
const char* WIFI_SSID = "XXXXX";
const char* WIFI_PASSWORD = "XXXXXX";

// ============= HARDWARE CONFIGURATION =============
const int FLOW_SENSOR_PIN = 32;
const int RELAY_OPEN_PIN = 25;
const int RELAY_CLOSE_PIN = 26;
const int LED_PIN = 2;
const float PULSES_PER_LITER = 367.9; // Adjust based on your sensor

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
const unsigned long SENSOR_PROCESS_INTERVAL = 200;   // Process pulses 5 times/sec for real-time accuracy
const unsigned long DATA_PUBLISH_INTERVAL = 1000;    // Publish to Blynk once per second (fastest practical rate)
const unsigned long STATUS_PUBLISH_INTERVAL = 30000;   // 30 seconds for status heartbeat
const unsigned long WIFI_RECONNECT_INTERVAL = 10000;   // 10 seconds
const unsigned long BLYNK_RECONNECT_INTERVAL = 5000;   // 5 seconds
const unsigned long VALVE_RELAY_PULSE_DURATION = 500;  // Latching relays only need a short pulse

// ============= EEPROM CONFIGURATION =============
#define EEPROM_SIZE 128
struct Settings {
  uint32_t magic_number; // To validate data integrity
  float totalVolumeLiters;
  float volumeLimitLiters;
  uint32_t deviceResetCount;
};
const uint32_t SETTINGS_MAGIC_NUMBER = 0xDEADBEEF;

// ============= GLOBAL STATE & VARIABLES =============
enum DeviceState { INITIALIZING, CONNECTING_WIFI, CONNECTING_BLYNK, OPERATIONAL, OFFLINE_SAFE_MODE };
DeviceState currentState = INITIALIZING;

Settings settings;
BlynkTimer timer;

volatile unsigned long pulseCount = 0;
float flowRateLPM = 0.0;
bool valveOpen = false;

unsigned long valveRelayStopTime = 0;
unsigned long lastWifiReconnectAttempt = 0;
unsigned long lastBlynkReconnectAttempt = 0;

// ============= CORE FUNCTIONS =============

void setup() {
  Serial.begin(115200);
  Serial.println("\n🌊 EvaraTap Flow Control System v3.4 (Final Deployment)");

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

  // Always run Blynk to keep connection alive if possible
  if (WiFi.status() == WL_CONNECTED) {
    Blynk.run();
  }

  switch (currentState) {
    case CONNECTING_WIFI:     handleWifiConnection();   break;
    case CONNECTING_BLYNK:      handleBlynkConnection();    break;
    case OPERATIONAL:         handleOperationalState();   break;
    case OFFLINE_SAFE_MODE:   handleOfflineSafeMode();    break;
    default: break;
  }
  updateStatusLED();
}

// ============= STATE HANDLERS =============

void handleWifiConnection() {
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi Connected!");
    currentState = CONNECTING_BLYNK;
  } else if (millis() - lastWifiReconnectAttempt > WIFI_RECONNECT_INTERVAL) {
    Serial.print("📶 Attempting WiFi connection...");
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
    Serial.print("☁️ Attempting Blynk connection...");
    // Blynk.connect() is blocking, so we don't use it here. 
    // Blynk.run() in the main loop handles non-blocking connection.
    lastBlynkReconnectAttempt = millis();
  }
}

void handleOperationalState() {
  // FINAL IMPROVEMENT: Check connection status FIRST, before running timers.
  if (!Blynk.connected()) {
    Serial.println("⚠️ Lost connection to Blynk, entering safe mode.");
    if (valveOpen) {
      Serial.println("   Closing valve as a precaution.");
      closeValve();
    }
    currentState = OFFLINE_SAFE_MODE;
    return;
  }
  
  // Only run the timers if we are in the operational state.
  timer.run();
}

void handleOfflineSafeMode() {
  if (WiFi.status() != WL_CONNECTED) {
    currentState = CONNECTING_WIFI;
  } else if (Blynk.connected()) {
    // Connection restored!
    currentState = OPERATIONAL;
  }
  // Blynk.run() in the main loop will keep trying to reconnect.
}

// ============= INTERRUPT SERVICE ROUTINE =============

void IRAM_ATTR pulseCounter() {
  pulseCount++;
}

// ============= DATA PROCESSING & PUBLISHING (TIMED) =============

void processSensorData() {
  unsigned long pulsesToProcess = 0;
  noInterrupts();
  pulsesToProcess = pulseCount;
  pulseCount = 0;
  interrupts();
  
  float volumeIncrement = pulsesToProcess / PULSES_PER_LITER;
  settings.totalVolumeLiters += volumeIncrement;
  
  flowRateLPM = (volumeIncrement / (SENSOR_PROCESS_INTERVAL / 1000.0)) * 60.0;

  if (valveOpen && settings.volumeLimitLiters > 0 && settings.totalVolumeLiters >= settings.volumeLimitLiters) {
    Serial.printf("🛡️ SAFETY: Volume limit %.1fL reached, closing valve\n", settings.volumeLimitLiters);
    closeValve();
  }
}

void publishFlowData() {
  Blynk.virtualWrite(VPIN_TOTAL_VOLUME, settings.totalVolumeLiters);
  Blynk.virtualWrite(VPIN_FLOW_RATE, flowRateLPM);
  Serial.printf("📤 Published Flow: %.2f L, %.2f LPM\n", settings.totalVolumeLiters, flowRateLPM);
  saveSettings();
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
  Serial.println("   Syncing app state with device...");
  Blynk.syncAll();
  publishStatusData();
}

BLYNK_WRITE(VPIN_CMD_OPEN_VALVE) { if (param.asInt() == 1) { openValve(); } }
BLYNK_WRITE(VPIN_CMD_CLOSE_VALVE) { if (param.asInt() == 1) { closeValve(); } }

BLYNK_WRITE(VPIN_CMD_RESET_VOLUME) {
  if (param.asInt() == 1) {
    Serial.println("🔄 Volume reset to 0L by app.");
    settings.totalVolumeLiters = 0.0;
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
}

void closeValve() {
  if (!valveOpen) return;
  Serial.println("🔒 Closing valve...");
  digitalWrite(RELAY_OPEN_PIN, LOW);
  digitalWrite(RELAY_CLOSE_PIN, HIGH);
  valveRelayStopTime = millis() + VALVE_RELAY_PULSE_DURATION;
  valveOpen = false;
  if(Blynk.connected()) Blynk.virtualWrite(VPIN_VALVE_STATUS, 0);
}

// ============= EEPROM & PERSISTENCE =============

void loadSettings() {
  EEPROM.get(0, settings);
  if (settings.magic_number != SETTINGS_MAGIC_NUMBER) {
    Serial.println("⚠️ EEPROM invalid or uninitialized. Loading defaults.");
    settings.magic_number = SETTINGS_MAGIC_NUMBER;
    settings.totalVolumeLiters = 0.0;
    settings.volumeLimitLiters = 100.0;
    settings.deviceResetCount = 0;
  } else {
    Serial.println("✅ EEPROM settings loaded successfully.");
  }
  settings.deviceResetCount++;
  saveSettings();
  Serial.printf("   Total Volume: %.2fL, Limit: %.1fL, Boot Count: %u\n",
    settings.totalVolumeLiters, settings.volumeLimitLiters, settings.deviceResetCount);
}

void saveSettings() {
  EEPROM.put(0, settings);
  if (!EEPROM.commit()) {
    Serial.println("❌ ERROR: Failed to commit settings to EEPROM!");
  }
}

// ============= UTILITIES =============

void updateStatusLED() {
  static unsigned long lastBlink = 0;
  static bool ledState = false;
  unsigned long interval = 1000;

  switch(currentState) {
    case OPERATIONAL: interval = 2000; break;
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

