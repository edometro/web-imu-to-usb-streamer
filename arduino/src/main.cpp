#include <Arduino.h>

// XIAO ESP32-C3 ピンマッピング
// D6 = GPIO20 (TX)
// D7 = GPIO21 (RX)
#define UART_TX_PIN D6  // GPIO20
#define UART_RX_PIN D7  // GPIO21

void setup() {
    // USBシリアル（スマホ/PC からのデータ入力 & デバッグ用）
    Serial.begin(115200);

    // 外部UART（STM32へのデータ送信）
    // Serial1: RXピン, TXピン の順で指定
    Serial1.begin(115200, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);

    Serial.println("XIAO ESP32-C3 UART Bridge Ready");
    Serial.println("USBシリアルから受信したデータをUART(D6:TX, D7:RX)へ転送します");
}

void loop() {
    // USBシリアル(スマホ)から受信 → UART(STM32)へ転送
    while (Serial.available()) {
        char c = Serial.read();
        Serial1.write(c);
    }

    // UART(STM32)から受信 → USBシリアル(デバッグ表示)
    while (Serial1.available()) {
        char c = Serial1.read();
        Serial.write(c);
    }
}
