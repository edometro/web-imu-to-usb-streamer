#include <Arduino.h>
#include "Adafruit_TinyUSB.h"


// USB WebUSB object
Adafruit_USBD_WebUSB usb_web;

// Landing Page: Scheme (1: https), URL
// This is optional but nice to have.
WEBUSB_URL_DEF(landingPage, 1 /*https*/, "edometro.github.io/web-imu-to-usb-streamer/");

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);

  // Configure WebUSB
  usb_web.setLandingPage(&landingPage);
  usb_web.begin();

  // UART2 Init (TX=GP4, RX=GP5) for STM32 communication
  // Note: Serial1 is usually GP0/GP1 but we use Serial2 to avoid conflict with PIO USB on GP0/GP1 if used.
  // Actually, PIO USB uses specific pins defined by PIO_USB_DP_PIN, default 0.
  Serial2.begin(115200);

  // Wait for USB mount
  while (!TinyUSBDevice.mounted()) {
    digitalWrite(LED_BUILTIN, HIGH);
    delay(100);
    digitalWrite(LED_BUILTIN, LOW);
    delay(100);
  }
}

void loop() {
  // LED blink to show activity
  static uint32_t led_timer = 0;
  if (millis() - led_timer > 1000) {
    led_timer = millis();
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
  }

  // USB WebUSB -> UART2 (STM32)
  if (usb_web.available()) {
    Serial2.write(usb_web.read());
  }

  // UART2 (STM32) -> USB WebUSB
  // Echo back or send debug info
  if (Serial2.available()) {
    usb_web.write(Serial2.read());
  }
}
