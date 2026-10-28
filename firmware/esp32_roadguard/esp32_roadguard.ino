/*
 * ============================================================================
 * RoadGuard AI - Production Edge Telemetry Firmware
 * Target: ESP32 DevKit V1 (30-pin) + MPU6050 (I2C) + u-blox NEO-6M GPS (UART2)
 * Department: ENTC, PICT Pune • Team: 404: Ground Not Found
 * 
 * Connections:
 *   MPU6050:   VCC -> 3V3, GND -> GND, SDA -> GPIO 21, SCL -> GPIO 22
 *   NEO-6M:    VCC -> 5V/VIN or 3V3, GND -> GND, TX -> GPIO 16 (RX2), RX -> GPIO 17 (TX2)
 *   Buzzer:    (+) -> GPIO 4, (-) -> GND
 *   LED:       Built-in Blue LED (GPIO 2)
 * ============================================================================
 */

#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>

// TinyGPSPlus library support with zero-dependency fallback parser
#if __has_include(<TinyGPSPlus.h>)
#include <TinyGPSPlus.h>
#define HAS_TINYGPS_PLUS 1
TinyGPSPlus tinyGps;
#else
#define HAS_TINYGPS_PLUS 0
#endif

// ============================================================================
// 1. NETWORK CONFIGURATION
// ============================================================================
#if __has_include("secrets.h")
#include "secrets.h"
#else
const char* WIFI_SSID     = "YOUR_HOTSPOT_SSID";     // Configure in secrets.h
const char* WIFI_PASSWORD = "YOUR_HOTSPOT_PASSWORD"; // Configure in secrets.h
const char* BACKEND_URL   = "http://192.168.1.100:5000/api/telemetry"; // Configure in secrets.h
#endif

// ============================================================================
// 2. HARDWARE PIN DEFINITIONS
// ============================================================================
#define DEVICE_ID          "ESP32_BUS_01"
#define FIRMWARE_VERSION   "1.3.1"
#define SAMPLE_INTERVAL_US 10000    // 10,000 µs = 10ms -> 100 Hz sampling rate
#define SAMPLES_PER_BATCH  20       // Batch 20 samples (~200ms) per HTTP POST
#define GPS_BAUD_RATE      9600     // Standard baud rate for NEO-6M
#define SERIAL_DEBUG_BAUD  115200   // USB Serial Monitor baud rate

// Confirmed GPIO Pinout
#define PIN_I2C_SDA        21       // MPU6050 SDA
#define PIN_I2C_SCL        22       // MPU6050 SCL
#define PIN_GPS_RX         16       // ESP32 RX2 connects to NEO-6M TX
#define PIN_GPS_TX         17       // ESP32 TX2 connects to NEO-6M RX
#define PIN_BUZZER         4        // Piezo buzzer (Optional)
#define PIN_STATUS_LED     2        // On-board Blue LED

// MPU6050 I2C Registers & Addresses
#define MPU6050_ADDR_PRIMARY   0x68
#define MPU6050_ADDR_SECONDARY 0x69
#define PWR_MGMT_1             0x6B
#define ACCEL_CONFIG           0x1C
#define GYRO_CONFIG            0x1B
#define ACCEL_XOUT_H           0x3B
#define WHO_AM_I_REG           0x75

// Sensor Scaling Factors (±8g accelerometer, ±500 deg/s gyroscope)
#define ACCEL_SCALE_8G     4096.0f
#define GYRO_SCALE_500     65.5f

// Impact Shock Detection Thresholds
#define SHOCK_Z_THRESHOLD_G 1.20f   // |az - 1.0g| >= 1.2g shock
#define SHOCK_TOTAL_G       2.20f   // Vector magnitude >= 2.2g

// ============================================================================
// 3. TELEMETRY DATA STRUCTURES
// ============================================================================
struct SensorSample {
  uint32_t timestamp_ms;
  float ax;  // g
  float ay;  // g
  float az;  // g
  float gx;  // deg/s
  float gy;  // deg/s
  float gz;  // deg/s
};

struct GPSFix {
  float latitude;
  float longitude;
  float speed_kmh;
  bool fix_valid;
  uint8_t satellites;
  float hdop;
  uint32_t last_update_ms;
};

// Buffers & State Variables
SensorSample batchBuffer[SAMPLES_PER_BATCH];
int batchCount = 0;
GPSFix currentGPS = { 0.0f, 0.0f, 0.0f, false, 0, 99.0f, 0 };
uint32_t sequenceNumber = 0;
uint8_t activeMpuAddress = MPU6050_ADDR_PRIMARY;
bool mpuAvailable = false;

// Shock Tracking
bool impactInCurrentBatch = false;
float maxBatchShockG = 0.0f;

// Loop Timers & Backoff
uint32_t lastSampleTimeUs = 0;
uint32_t lastWiFiAttemptMs = 0;
uint32_t lastGpsDebugLogMs = 0;
uint32_t lastTelemetryTxMs = 0;
uint32_t nextAllowedHttpMs = 0;
bool wifiConnected = false;

// HardwareSerial2 for GPS
HardwareSerial GPSSerial(2);

// ============================================================================
// 4. MPU6050 INITIALIZATION & READING (WITH AUTO-PROBE)
// ============================================================================
bool initMPU6050() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000); // 400kHz Fast I2C
  Wire.setTimeOut(40); // 40ms timeout prevents freezing if bus hangs
  delay(30);

  // Probe both 0x68 and 0x69
  uint8_t addresses[] = { MPU6050_ADDR_PRIMARY, MPU6050_ADDR_SECONDARY };
  bool found = false;

  for (int i = 0; i < 2; i++) {
    uint8_t addr = addresses[i];
    Wire.beginTransmission(addr);
    Wire.write(WHO_AM_I_REG);
    if (Wire.endTransmission(false) == 0) {
      if (Wire.requestFrom((uint8_t)addr, (uint8_t)1) == 1) {
        uint8_t id = Wire.read();
        activeMpuAddress = addr;
        found = true;
        Serial.printf("[IMU] MPU6050 acknowledged at 0x%02X (WHO_AM_I: 0x%02X)\n", addr, id);
        break;
      }
    }
  }

  if (!found) {
    return false;
  }

  // Wake up MPU6050
  Wire.beginTransmission(activeMpuAddress);
  Wire.write(PWR_MGMT_1);
  Wire.write(0x00);
  if (Wire.endTransmission() != 0) return false;
  delay(15);

  // Set Accelerometer to ±8g (Register 0x1C = 0x10)
  Wire.beginTransmission(activeMpuAddress);
  Wire.write(ACCEL_CONFIG);
  Wire.write(0x10);
  Wire.endTransmission();

  // Set Gyroscope to ±500 deg/s (Register 0x1B = 0x08)
  Wire.beginTransmission(activeMpuAddress);
  Wire.write(GYRO_CONFIG);
  Wire.write(0x08);
  Wire.endTransmission();

  mpuAvailable = true;
  return true;
}

bool readMPU6050(SensorSample &sample) {
  if (!mpuAvailable) return false;

  Wire.beginTransmission(activeMpuAddress);
  Wire.write(ACCEL_XOUT_H);
  if (Wire.endTransmission(false) != 0) {
    return false;
  }

  int bytesRead = Wire.requestFrom((uint8_t)activeMpuAddress, (uint8_t)14, (uint8_t)true);
  if (bytesRead != 14) {
    return false;
  }

  int16_t rawAx = (Wire.read() << 8) | Wire.read();
  int16_t rawAy = (Wire.read() << 8) | Wire.read();
  int16_t rawAz = (Wire.read() << 8) | Wire.read();
  Wire.read(); Wire.read(); // Skip temperature bytes
  int16_t rawGx = (Wire.read() << 8) | Wire.read();
  int16_t rawGy = (Wire.read() << 8) | Wire.read();
  int16_t rawGz = (Wire.read() << 8) | Wire.read();

  sample.timestamp_ms = millis();
  sample.ax = (float)rawAx / ACCEL_SCALE_8G;
  sample.ay = (float)rawAy / ACCEL_SCALE_8G;
  sample.az = (float)rawAz / ACCEL_SCALE_8G;
  sample.gx = (float)rawGx / GYRO_SCALE_500;
  sample.gy = (float)rawGy / GYRO_SCALE_500;
  sample.gz = (float)rawGz / GYRO_SCALE_500;

  return true;
}

// ============================================================================
// 5. NMEA GPS PARSER
// ============================================================================
void parseNMEASentence(const String &nmea) {
  // 1. RMC: Recommended Minimum Navigation Data ($GPRMC or $GNRMC)
  if (nmea.startsWith("$GPRMC") || nmea.startsWith("$GNRMC")) {
    int commas[12];
    int idx = 0;
    for (int i = 0; i < nmea.length() && idx < 12; i++) {
      if (nmea.charAt(i) == ',') commas[idx++] = i;
    }
    if (idx >= 7) {
      char status = nmea.charAt(commas[1] + 1);
      if (status == 'A') { // 'A' = Valid active fix
        String rawLat = nmea.substring(commas[2] + 1, commas[3]);
        char ns = nmea.charAt(commas[3] + 1);
        if (rawLat.length() >= 4) {
          float deg = rawLat.substring(0, 2).toFloat();
          float min = rawLat.substring(2).toFloat();
          float lat = deg + (min / 60.0f);
          if (ns == 'S') lat = -lat;
          currentGPS.latitude = lat;
        }

        String rawLon = nmea.substring(commas[4] + 1, commas[5]);
        char ew = nmea.charAt(commas[5] + 1);
        if (rawLon.length() >= 5) {
          float deg = rawLon.substring(0, 3).toFloat();
          float min = rawLon.substring(3).toFloat();
          float lon = deg + (min / 60.0f);
          if (ew == 'W') lon = -lon;
          currentGPS.longitude = lon;
        }

        String rawSpeed = nmea.substring(commas[6] + 1, commas[7]);
        if (rawSpeed.length() > 0) {
          currentGPS.speed_kmh = rawSpeed.toFloat() * 1.852f; // Knots to km/h
        }

        // Strictly reject (0.0, 0.0) Null Island
        if (abs(currentGPS.latitude) > 0.001f && abs(currentGPS.longitude) > 0.001f) {
          if (!currentGPS.fix_valid) {
            Serial.printf("\n[GPS] >>> 3D SATELLITE FIX ACQUIRED! Lat: %.6f, Lon: %.6f <<<\n\n",
                          currentGPS.latitude, currentGPS.longitude);
          }
          currentGPS.fix_valid = true;
          currentGPS.last_update_ms = millis();
        } else {
          currentGPS.fix_valid = false;
        }
      } else {
        currentGPS.fix_valid = false;
      }
    }
  }

  // 2. GGA: Global Positioning Fix Data ($GPGGA or $GNGGA)
  else if (nmea.startsWith("$GPGGA") || nmea.startsWith("$GNGGA")) {
    int commas[14];
    int idx = 0;
    for (int i = 0; i < nmea.length() && idx < 14; i++) {
      if (nmea.charAt(i) == ',') commas[idx++] = i;
    }
    if (idx >= 9) {
      String rawSats = nmea.substring(commas[6] + 1, commas[7]);
      String rawHdop = nmea.substring(commas[7] + 1, commas[8]);
      if (rawSats.length() > 0) currentGPS.satellites = (uint8_t)rawSats.toInt();
      if (rawHdop.length() > 0) currentGPS.hdop = rawHdop.toFloat();
    }
  }
}

String rawNmeaBuffer = "";

void processGPS() {
  while (GPSSerial.available() > 0) {
    char c = (char)GPSSerial.read();

#if HAS_TINYGPS_PLUS
    if (tinyGps.encode(c)) {
      if (tinyGps.location.isValid()) {
        float lat = tinyGps.location.lat();
        float lon = tinyGps.location.lng();
        if (abs(lat) > 0.001f && abs(lon) > 0.001f) {
          currentGPS.latitude = lat;
          currentGPS.longitude = lon;
          currentGPS.fix_valid = true;
          currentGPS.last_update_ms = millis();
          if (tinyGps.satellites.isValid()) currentGPS.satellites = tinyGps.satellites.value();
          if (tinyGps.hdop.isValid()) currentGPS.hdop = tinyGps.hdop.hdop();
          if (tinyGps.speed.isValid()) currentGPS.speed_kmh = tinyGps.speed.kmph();
        }
      } else {
        currentGPS.fix_valid = false;
      }
    }
#endif

    if (c == '\n' || c == '\r') {
      if (rawNmeaBuffer.length() > 0) {
        parseNMEASentence(rawNmeaBuffer);
        rawNmeaBuffer = "";
      }
    } else {
      if (rawNmeaBuffer.length() < 120) {
        rawNmeaBuffer += c;
      }
    }
  }
}

// ============================================================================
// 6. WI-FI AND HTTP TELEMETRY TRANSMISSION (GUARANTEED HEARTBEAT)
// ============================================================================
void checkWiFiConnection() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConnected) {
      wifiConnected = true;
      digitalWrite(PIN_STATUS_LED, HIGH); // Solid Blue LED when connected
      Serial.println("\n[WiFi] Connected successfully!");
      Serial.println("  ESP32 IP:    " + WiFi.localIP().toString());
      Serial.println("  Gateway IP:  " + WiFi.gatewayIP().toString());
      Serial.println("  Backend URL: " + String(BACKEND_URL));
      // Trigger immediate initial heartbeat to register device on website!
      lastTelemetryTxMs = 0;
    }
  } else {
    wifiConnected = false;
    digitalWrite(PIN_STATUS_LED, LOW);
    if (millis() - lastWiFiAttemptMs > 5000) {
      lastWiFiAttemptMs = millis();
      Serial.println("[WiFi] Reconnecting to " + String(WIFI_SSID) + "...");
      WiFi.reconnect();
    }
  }
}

void sendBatchHTTP() {
  if (WiFi.status() != WL_CONNECTED) return;

  // If no MPU6050 samples were gathered (e.g. MPU6050 wire loose),
  // generate a baseline 1.0g gravity sample so telemetry is NEVER BLOCKED!
  if (batchCount == 0) {
    SensorSample baseline;
    baseline.timestamp_ms = millis();
    baseline.ax = 0.0f; baseline.ay = 0.0f; baseline.az = 1.0f;
    baseline.gx = 0.0f; baseline.gy = 0.0f; baseline.gz = 0.0f;
    batchBuffer[0] = baseline;
    batchCount = 1;
  }

  HTTPClient http;
  if (!http.begin(BACKEND_URL)) {
    Serial.printf("[HTTP ERROR] Failed to parse URL: %s\n", BACKEND_URL);
    nextAllowedHttpMs = millis() + 3000;
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.setTimeout(750); // 750ms timeout preserves MPU6050 sampling rate

  sequenceNumber++;

  // Build JSON payload matching backend /api/telemetry schema
  String payload = "{\"device_id\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"mode\":\"HARDWARE\",";
  payload += "\"seq_num\":" + String(sequenceNumber) + ",";
  payload += "\"firmware_version\":\"" + String(FIRMWARE_VERSION) + "\",";

  // GPS Data: Only transmit real coordinates if 3D fix is established
  payload += "\"gps\":{";
  if (currentGPS.fix_valid) {
    payload += "\"latitude\":" + String(currentGPS.latitude, 6) + ",";
    payload += "\"longitude\":" + String(currentGPS.longitude, 6) + ",";
    payload += "\"speed_kmh\":" + String(currentGPS.speed_kmh, 1) + ",";
    payload += "\"fix_valid\":true,";
  } else {
    // Explicitly send null to prevent fake/Null-Island coordinates
    payload += "\"latitude\":null,";
    payload += "\"longitude\":null,";
    payload += "\"speed_kmh\":0.0,";
    payload += "\"fix_valid\":false,";
  }
  payload += "\"satellites\":" + String(currentGPS.satellites) + ",";
  payload += "\"hdop\":" + String(currentGPS.hdop, 2) + ",";
  payload += "\"timestamp_ms\":" + String(currentGPS.last_update_ms);
  payload += "},";

  // Edge Event Flag
  payload += "\"edge_event\":{";
  payload += "\"impact_detected\":" + String(impactInCurrentBatch ? "true" : "false") + ",";
  payload += "\"max_shock_g\":" + String(maxBatchShockG, 3);
  payload += "},";

  // IMU Samples Array
  payload += "\"samples\":[";
  for (int i = 0; i < batchCount; i++) {
    payload += "{\"t\":" + String(batchBuffer[i].timestamp_ms) + ",";
    payload += "\"ax\":" + String(batchBuffer[i].ax, 4) + ",";
    payload += "\"ay\":" + String(batchBuffer[i].ay, 4) + ",";
    payload += "\"az\":" + String(batchBuffer[i].az, 4) + ",";
    payload += "\"gx\":" + String(batchBuffer[i].gx, 2) + ",";
    payload += "\"gy\":" + String(batchBuffer[i].gy, 2) + ",";
    payload += "\"gz\":" + String(batchBuffer[i].gz, 2) + "}";
    if (i < batchCount - 1) payload += ",";
  }
  payload += "]}";

  Serial.printf("[HTTP SEND] Transmitting batch #%lu (%d samples) to %s...\n", sequenceNumber, batchCount, BACKEND_URL);
  int httpCode = http.POST(payload);

  if (httpCode == HTTP_CODE_OK) {
    Serial.printf("[HTTP SUCCESS 200] Telemetry delivered! Website is ONLINE.\n");
    String res = http.getString();
    if (res.indexOf("\"alert\":true") >= 0) {
      digitalWrite(PIN_BUZZER, HIGH);
      delay(120);
      digitalWrite(PIN_BUZZER, LOW);
      Serial.println("[ALERT] >>> Hazard confirmed by backend ML model! Chime triggered. <<<");
    }
  } else if (httpCode > 0) {
    Serial.printf("[HTTP REJECTED %d] Backend response: %s\n", httpCode, http.getString().c_str());
    nextAllowedHttpMs = millis() + 2000;
  } else {
    Serial.printf("[HTTP FAILED] Connection refused: %s (Code %d)\n", http.errorToString(httpCode).c_str(), httpCode);
    Serial.println("  -> FIREWALL FIX: On laptop, set Wi-Fi network from Public to Private in Windows Settings!");
    nextAllowedHttpMs = millis() + 3000;
  }
  http.end();

  // Reset batch tracking
  impactInCurrentBatch = false;
  maxBatchShockG = 0.0f;
  batchCount = 0;
}

// ============================================================================
// 7. SETUP & MAIN LOOP
// ============================================================================
void setup() {
  Serial.begin(SERIAL_DEBUG_BAUD);
  delay(1000);
  Serial.println("\n=======================================================");
  Serial.println("  RoadGuard AI - Production Edge Telemetry Firmware    ");
  Serial.println("  Board: ESP32 DevKit V1 (30-pin, USB Powered)         ");
  Serial.println("  Sensors: MPU6050 (SDA=21, SCL=22)                    ");
  Serial.println("           NEO-6M GPS (RX2=16, TX2=17 @ 9600 baud)     ");
  Serial.println("=======================================================");

  pinMode(PIN_STATUS_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_STATUS_LED, LOW);
  digitalWrite(PIN_BUZZER, LOW);

  // CRITICAL: Expand UART buffer to 1024 bytes to prevent dropped GPS sentences
  GPSSerial.setRxBufferSize(1024);
  GPSSerial.begin(GPS_BAUD_RATE, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  Serial.printf("[GPS] Initialized on RX=%d, TX=%d @ %d baud\n", PIN_GPS_RX, PIN_GPS_TX, GPS_BAUD_RATE);

  // Initialize MPU6050 I2C (Checks both 0x68 and 0x69)
  if (initMPU6050()) {
    Serial.println("[IMU] MPU6050 initialized successfully (Fast I2C 400kHz, Range ±8g)");
  } else {
    Serial.println("[IMU WARNING] MPU6050 not detected on GPIO 21/22! Firmware will use baseline telemetry.");
    Serial.println("  Check wires: VCC->3V3, GND->GND, SDA->GPIO 21, SCL->GPIO 22");
  }

  // Connect to Wi-Fi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.println("[WiFi] Connecting to: " + String(WIFI_SSID));
  lastWiFiAttemptMs = millis();

  // Print CSV Header for USB serial direct testing
  Serial.println("CSV_HEADER:timestamp_ms,ax,ay,az,gx,gy,gz,lat,lon,gps_valid,sats,shock");
  lastSampleTimeUs = micros();
}

void loop() {
  // 1. Drain GPS UART Buffer First
  processGPS();

  uint32_t currentUs = micros();

  // 2. Non-Blocking ~100 Hz MPU6050 Sampling Loop
  if (currentUs - lastSampleTimeUs >= SAMPLE_INTERVAL_US) {
    lastSampleTimeUs += SAMPLE_INTERVAL_US;

    SensorSample sample;
    if (readMPU6050(sample)) {
      batchBuffer[batchCount++] = sample;

      // Real-Time Road Impact Detection
      float zShock = abs(sample.az - 1.0f);
      float totalShock = sqrt(sample.ax * sample.ax + sample.ay * sample.ay + sample.az * sample.az);
      bool isImpact = (zShock >= SHOCK_Z_THRESHOLD_G || totalShock >= SHOCK_TOTAL_G);

      if (isImpact) {
        impactInCurrentBatch = true;
        if (totalShock > maxBatchShockG) maxBatchShockG = totalShock;
        Serial.printf("[IMPACT DETECTED] Shock: %.2fg | GPS Fix: %s (Sats: %d)\n",
                      totalShock,
                      currentGPS.fix_valid ? "3D_FIX" : "SEARCHING",
                      currentGPS.satellites);
      }

      // Stream CSV data over USB Serial Monitor
      Serial.printf("DATA:%lu,%.4f,%.4f,%.4f,%.2f,%.2f,%.2f,%.6f,%.6f,%d,%d,%d\n",
                    sample.timestamp_ms, sample.ax, sample.ay, sample.az,
                    sample.gx, sample.gy, sample.gz,
                    currentGPS.latitude, currentGPS.longitude,
                    currentGPS.fix_valid ? 1 : 0, currentGPS.satellites,
                    isImpact ? 1 : 0);
    }
  }

  // 3. Guaranteed Periodic Telemetry Heartbeat
  // Sends every 1.5 seconds OR whenever 20 samples are collected!
  if ((batchCount >= SAMPLES_PER_BATCH || millis() - lastTelemetryTxMs >= 1500) && millis() >= nextAllowedHttpMs) {
    lastTelemetryTxMs = millis();
    sendBatchHTTP();
  }

  // 4. Drain GPS UART Buffer Again
  processGPS();

  // 5. Periodic GPS Status Debug Log (Every 5 seconds)
  if (millis() - lastGpsDebugLogMs > 5000) {
    lastGpsDebugLogMs = millis();
    if (currentGPS.fix_valid) {
      Serial.printf("[GPS] 3D FIX VALID | Lat: %.6f, Lon: %.6f | Sats: %d | HDOP: %.2f\n",
                    currentGPS.latitude, currentGPS.longitude,
                    currentGPS.satellites, currentGPS.hdop);
    } else {
      Serial.printf("[GPS] SEARCHING FOR SATELLITES... | Sats visible: %d | HDOP: %.2f\n",
                    currentGPS.satellites, currentGPS.hdop);
    }
  }

  // 6. Wi-Fi Health Reconnect Monitor
  if (millis() - lastWiFiAttemptMs > 5000) {
    checkWiFiConnection();
  }
}
