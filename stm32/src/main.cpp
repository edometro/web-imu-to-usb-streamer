#include "mbed.h"
#include <cstring>

DigitalOut led(LED1);

// USBシリアル（PCへの出力）
UnbufferedSerial pc(USBTX, USBRX, 115200);

// 外部UART（XIAO ESP32-C3からの受信）
// Nucleo F303K8: D0 = PA_10 (RX), D1 = PA_9 (TX)
UnbufferedSerial ext_uart(PA_9, PA_10, 115200);

char rx_buffer[256];
size_t rx_index = 0;

int main() {
    // const char* msg = "STM32 UART-to-USB Bridge Ready\r\n";
    // pc.write(msg, strlen(msg));

    while (1) {
        char c;
        // 外部UART(XIAO)から受信 → USBシリアル(PC)へ転送
        if (ext_uart.read(&c, 1)) {
            pc.write(&c, 1);

            // 改行検出でLED点滅（1行受信の目印）
            if (c == '\n' || c == '\r') {
                if (rx_index > 0) {
                    led = !led;
                }
                rx_index = 0;
            } else if (rx_index < sizeof(rx_buffer) - 1) {
                rx_buffer[rx_index++] = c;
            }
        }
    }
}
