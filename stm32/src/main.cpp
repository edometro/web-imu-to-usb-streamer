#include "mbed.h"

DigitalOut led(LED1);
UnbufferedSerial serial(USBTX, USBRX, 115200);
RawCAN can(PA_11, PA_12, 1000000);

char rx_buffer[128];
size_t rx_index = 0;

void handle_serial_data(char* data) {
    float alpha, beta, gamma, x, y, z;
    if (sscanf(data, "%f,%f,%f,%f,%f,%f", &alpha, &beta, &gamma, &x, &y, &z) == 6) {
        // ID 0x501: alpha, beta
        float data501[2] = {alpha, beta};
        can.write(CANMessage(0x501, (char*)data501, 8));

        // ID 0x502: gamma
        float data502[1] = {gamma};
        can.write(CANMessage(0x502, (char*)data502, 4));

        // ID 0x503: acc_x, acc_y (Requested to be together)
        float data503[2] = {x, y};
        can.write(CANMessage(0x503, (char*)data503, 8));

        // ID 0x504: acc_z
        float data504[1] = {z};
        can.write(CANMessage(0x504, (char*)data504, 4));
        
        led = !led;
    }
}

int main() {
    while (1) {
        char c;
        if (serial.read(&c, 1)) {
            if (c == '\n' || c == '\r') {
                rx_buffer[rx_index] = '\0';
                if (rx_index > 0) {
                    handle_serial_data(rx_buffer);
                }
                rx_index = 0;
            } else if (rx_index < sizeof(rx_buffer) - 1) {
                rx_buffer[rx_index++] = c;
            }
        }
    }
}
