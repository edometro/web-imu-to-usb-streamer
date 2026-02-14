#include <Arduino.h>
#include "Adafruit_TinyUSB.h"

// HID report descriptor: Generic In/Out (64 bytes)
// Usage Page: 0xFF00 (Vendor Defined), Usage: 0x01 (Generic)
uint8_t const desc_hid_report[] = {
  TUD_HID_REPORT_DESC_GENERIC_INOUT(64)
};

Adafruit_USBD_HID usb_hid;

// Report Callback: Host GET_REPORT request (unused here)
uint16_t get_report_callback(uint8_t report_id, hid_report_type_t report_type, uint8_t* buffer, uint16_t reqlen) {
  (void)report_id;
  (void)report_type;
  (void)buffer;
  (void)reqlen;
  return 0;
}

// Report Callback: PC -> Pico (Output Report)
void set_report_callback(uint8_t report_id, hid_report_type_t report_type, uint8_t const* buffer, uint16_t bufsize) {
  (void)report_id;
  // Output report received from PC
  if (report_type == HID_REPORT_TYPE_OUTPUT) {
    // Send data to STM32 via UART1
    // The buffer contains 64 bytes. We assume it contains string data.
    // We should send up to the first null terminator or the whole buffer if binary.
    // Since it's IMU CSV data string, we can send bytes until 0x00 or bufsize.
    
    for (uint16_t i = 0; i < bufsize; i++) {
        if (buffer[i] == 0) break; // Stop at null terminator
        Serial1.write(buffer[i]);
    }
    
    // Toggle LED to indicate activity
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
  }
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  
  // UART1 Init (TX=GP4, RX=GP5) - Serial2 on Pico (GP0はPIO USBで使用)
  Serial2.begin(115200);

  // USB HID Init
  usb_hid.enableOutEndpoint(true);
  usb_hid.setPollInterval(2);
  usb_hid.setReportDescriptor(desc_hid_report, sizeof(desc_hid_report));
  usb_hid.setReportCallback(get_report_callback, set_report_callback);
  usb_hid.begin();

  // Wait for USB mount
  while (!TinyUSBDevice.mounted()) {
    digitalWrite(LED_BUILTIN, HIGH);
    delay(100);
    digitalWrite(LED_BUILTIN, LOW);
    delay(100);
  }
}

void loop() {
  // Nothing to do in loop, handled by callbacks
  // If we needed to send data back to PC (STM32 -> Console), we would read Serial1 here 
  // and send input report.
  delay(10);
}
