#include "Settings.h"

#include <EEPROM.h>
#include <string.h>

Settings settings;

namespace {
const uint32_t kMagic = 0xCAD0A002;
const uint16_t kVersion = 1;

// Pseudo-inverse of the original MK2 formula (gains 28/28/24, 18/18/20, signs
// -+-+++) scaled to 350: with these the mouse behaves exactly like upstream
// until the user teaches their own movements.
const float DEFAULT_TEMPLATES[12][9] = {
  {-12.5f, 0, 0, -12.5f, 0, 0, -12.5f, 0, 0},                       // Tx+
  {12.5f, 0, 0, 12.5f, 0, 0, 12.5f, 0, 0},                          // Tx-
  {0, 12.5f, 0, 0, 12.5f, 0, 0, 12.5f, 0},                          // Ty+
  {0, -12.5f, 0, 0, -12.5f, 0, 0, -12.5f, 0},                       // Ty-
  {0, 0, -14.58333f, 0, 0, -14.58333f, 0, 0, -14.58333f},           // Tz+
  {0, 0, 14.58333f, 0, 0, 14.58333f, 0, 0, 14.58333f},              // Tz-
  {0, 0, -11.22626f, 0, 0, 5.61313f, 0, 0, 5.61313f},               // Rx+
  {0, 0, 11.22626f, 0, 0, -5.61313f, 0, 0, -5.61313f},              // Rx-
  {0, 0, 0, 0, 0, -9.72222f, 0, 0, 9.72222f},                       // Ry+
  {0, 0, 0, 0, 0, 9.72222f, 0, 0, -9.72222f},                       // Ry-
  {10.10363f, 0, 0, -5.05181f, -8.75f, 0, -5.05181f, 8.75f, 0},     // Rz+
  {-10.10363f, 0, 0, 5.05181f, 8.75f, 0, 5.05181f, -8.75f, 0},      // Rz-
};
}  // namespace

// Knoflík na pružině se v praxi jen naklání (Rx, Ry), otáčí (Rz) a zmáčkne (Tz+).
// Posuny Tx/Ty a povytažení (Tz-) jsou vypnuté: nulový otisk = nesoupeří při rozkladu.
const uint16_t kUnusedMask = (1u << 0) | (1u << 1) | (1u << 2) | (1u << 3) | (1u << 5);

void settingsDefaultProfile(uint8_t mode) {
  Profile& p = settings.p[mode];
  memcpy(p.tpl, DEFAULT_TEMPLATES, sizeof(p.tpl));
  for (int k = 0; k < 12; k++) {
    p.dsens[k] = 1.0f;
    if (kUnusedMask & (1u << k)) memset(p.tpl[k], 0, sizeof(p.tpl[k]));
  }
  for (int i = 0; i < 6; i++) {
    p.dead[i] = (i < 3) ? 16.0f : 20.0f;
    p.mix[i] = MIX_FREE;
  }
  p.lockMask = kUnusedMask;
  p.sens = 1.0f;
  p.color = (mode == MODE_JOYSTICK) ? 0xFF0000 : 0x0040FF;
  p.bright = 40;
}

void settingsLoad() {
  EEPROM.begin(2048);
  static_assert(sizeof(Settings) <= 2048, "Settings too big for EEPROM page");
  EEPROM.get(0, settings);
  if (settings.magic == kMagic && settings.version == kVersion &&
      settings.mode < MODE_COUNT && settings.favCount <= 8) {
    return;
  }
  memset(&settings, 0, sizeof(settings));
  settings.magic = kMagic;
  settings.version = kVersion;
  settings.mode = MODE_SPACEMOUSE;
  const uint32_t favs[] = {0xFF0000, 0x0040FF, 0xFF6000, 0xFFFFFF};
  settings.favCount = 4;
  memcpy(settings.fav, favs, sizeof(favs));
  for (uint8_t m = 0; m < MODE_COUNT; m++) settingsDefaultProfile(m);
}

void settingsSave() {
  EEPROM.put(0, settings);
  EEPROM.commit();
}
