#pragma once

#include <Arduino.h>

// Persistent settings (flash via EEPROM emulation), one Profile per USB mode.
// Directions: k = axis*2 + (0 = plus, 1 = minus); axes Tx,Ty,Tz,Rx,Ry,Rz.

enum Mode : uint8_t { MODE_SPACEMOUSE = 0, MODE_JOYSTICK = 1, MODE_COUNT = 2 };
enum Mix : uint8_t { MIX_FREE = 0, MIX_DAMP = 1, MIX_SINGLE = 2 };

struct Profile {
  float tpl[12][9];   // learned sensor fingerprint per direction (full push -> a = 1)
  float dsens[12];    // sensitivity per direction
  float dead[6];      // dead zone per axis, output units (0..350)
  uint8_t mix[6];     // Mix per axis
  uint16_t lockMask;  // bit k = direction k locked
  float sens;         // overall sensitivity
  uint32_t color;     // LED 0xRRGGBB
  uint8_t bright;     // LED brightness 0..255
};

struct Settings {
  uint32_t magic;
  uint16_t version;
  uint8_t mode;
  uint8_t favCount;
  uint32_t fav[8];  // favourite LED colours shown in the tray menu
  Profile p[MODE_COUNT];

  Profile& cur() { return p[mode < MODE_COUNT ? mode : 0]; }
};

extern Settings settings;

void settingsLoad();
void settingsSave();
void settingsDefaultProfile(uint8_t mode);
