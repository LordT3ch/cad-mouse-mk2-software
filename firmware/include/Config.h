#pragma once

#include <Arduino.h>

namespace Config {

// Hardware pins (XIAO RP2040)
const int PIN_RIGHT_BTN = D0;
const int PIN_LEFT_BTN = D2;
const int PIN_LED_DATA = D3;
const int PIN_LED_LS = D1;
const int PIN_MAG1_LS = D10;
const int PIN_MAG2_LS = D9;
const int PIN_MAG3_LS = D8;

// Samples for calibration offset
const int ZERO_SAMPLES = 200;

// Gains, signs and dead zones now live per mode in Settings (flash).

// Smoothing
const float SMOOTH_TAU_S = 0.08;

// Final axis output range
const float AXIS_LIMIT = 350.0;

// RGB LEDs
const int LED_COUNT = 8;
const unsigned long LED_CALIBRATING_COLOR = 0x0000FF;

// FSM timing
const long IDLE_SLEEP_TIMEOUT_MS = 3 * 60 * 1000;

}  // namespace Config
