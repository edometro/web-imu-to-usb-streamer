#include <Arduino.h>
#include "Adafruit_TinyUSB.h"
#include <SPI.h>
#include <mcp_can.h>

// CAN Pins (based on rp2350_can)
const int PIN_CAN_INT  = 8;
const int PIN_SPI_CS   = 9;
const int PIN_SPI_SCK  = 10;
const int PIN_SPI_MOSI = 11;
const int PIN_SPI_MISO = 12;

// MCP_CAN instance
MCP_CAN CAN0(&SPI1, PIN_SPI_CS);

// USB WebUSB object
Adafruit_USBD_WebUSB usb_web;

// Landing Page: Scheme (1: https), URL
WEBUSB_URL_DEF(landingPage, 1 /*https*/, "edometro.github.io/web-imu-to-usb-streamer/");

// CSV parsing buffer
String inputBuffer = "";
bool can_initialized = false;

void sendIMUtoCAN(float alpha, float beta, float gamma, float ax, float ay, float ayz) {
  if (!can_initialized) {
    usb_web.println("ERR:NO_CAN_INIT");
    return;
  }

  uint8_t data[8];
  bool success = true;
  
  // Pack alpha, beta (4B + 4B = 8B) -> ID 0x501
  memcpy(data, &alpha, 4);
  memcpy(data + 4, &beta, 4);
  if (CAN0.sendMsgBuf(0x501, 0, 8, data) != CAN_OK) success = false;

  // Pack gamma, ax (4B + 4B = 8B) -> ID 0x502
  memcpy(data, &gamma, 4);
  memcpy(data + 4, &ax, 4);
  if (CAN0.sendMsgBuf(0x502, 0, 8, data) != CAN_OK) success = false;

  // Pack ay, az (4B + 4B = 8B) -> ID 0x503
  memcpy(data, &ay, 4);
  memcpy(data + 4, &az, 4);
  if (CAN0.sendMsgBuf(0x503, 0, 8, data) != CAN_OK) success = false;

  if (success) {
    usb_web.println("ACK");
  } else {
    // エラー詳細を返す
    usb_web.println("ERR:CAN_SEND");
  }
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH); // Setup start

  // 1. Configure WebUSB
  usb_web.setLandingPage(&landingPage);
  usb_web.begin();

  // 2. UART2 Init
  Serial2.begin(115200);

  // 3. SPI1 Init for MCP2515
  SPI1.setSCK(PIN_SPI_SCK);
  SPI1.setTX(PIN_SPI_MOSI);
  SPI1.setRX(PIN_SPI_MISO);
  SPI1.begin();

  // 4. CAN Init
  if (CAN0.begin(MCP_ANY, CAN_1000KBPS, MCP_16MHZ) == CAN_OK) {
    CAN0.setMode(MCP_NORMAL);
    can_initialized = true;
  }

  digitalWrite(LED_BUILTIN, LOW); // Setup finished (waiting for mount)

  // Wait for USB mount with high-speed blink
  while (!TinyUSBDevice.mounted()) {
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
    delay(50);
  }
  digitalWrite(LED_BUILTIN, LOW);
}

void loop() {
  // LED blink to show activity
  static uint32_t led_timer = 0;
  if (millis() - led_timer > 1000) {
    led_timer = millis();
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
  }

  // USB WebUSB -> UART2 & Parse for CAN
  while (usb_web.available()) {
    char c = usb_web.read();
    Serial2.write(c); // Forward to UART
    
    // Buffer for CSV parsing
    if (c == '\n') {
      // Parse CSV: alpha,beta,gamma,ax,ay,az
      float vals[6] = {0};
      int count = 0;
      int startPos = 0;
      for (int i = 0; i < inputBuffer.length() && count < 6; i++) {
        if (inputBuffer.charAt(i) == ',') {
          vals[count++] = inputBuffer.substring(startPos, i).toFloat();
          startPos = i + 1;
        }
      }
      if (count < 6 && startPos < inputBuffer.length()) {
        vals[count++] = inputBuffer.substring(startPos).toFloat();
      }

      if (count == 6) {
        sendIMUtoCAN(vals[0], vals[1], vals[2], vals[3], vals[4], vals[5]);
      }
      inputBuffer = "";
    } else {
      inputBuffer += c;
    }
  }

  // UART2 (STM32) -> USB WebUSB
  if (Serial2.available()) {
    usb_web.write(Serial2.read());
  }
}
