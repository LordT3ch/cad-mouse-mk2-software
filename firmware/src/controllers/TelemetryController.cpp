#include "controllers/TelemetryController.h"

#include <Arduino.h>
#include <stdlib.h>
#include <string.h>

#include "Config.h"
#include "Controllers.h"
#include "Settings.h"

// Text protocol over USB serial, one command per line, answer "ok" / "err".
//   get                      -> one line "cfg {json}" (current mode profile)
//   mode <0|1>               -> save + reboot as SpaceMouse / Joystick
//   color <rrggbb>  bright <0-255>  sens <f>
//   dsens <k> <f>  dead <axis> <f>  mix <axis> <0-2>  lock <mask>
//   tpl <k> <9 floats>       -> learned fingerprint of direction k
//   fav <rrggbb,...>         -> favourite colours (max 8)
//   map <6 ints>             -> HID output remap (±1..6 source axis, 0 = off), not saved
//   press <±axis> <flip> <hidButtons> -> knob press added to an output axis, reversed while a side
//                               button is held; hidButtons 0 = buttons not sent as HID; not saved
//   cal                      -> recalibrate rest pose
//   stream <0|1>             -> "s" lines: 9 deltas, 6 axes, buttons
// Unasked: "b <bits> <knobUsed>" whenever the side buttons change, "z 1|0" on sleep/wake.
//   save                     -> write settings to flash
//   defaults                 -> reset current profile (not saved)

namespace {
const int kStreamEvery = 2;

void printHex(uint32_t c) {
  char buf[8];
  snprintf(buf, sizeof(buf), "%06lX", (unsigned long)(c & 0xFFFFFF));
  Serial.print(buf);
}

template <typename T>
void printArray(const T* v, int n, int digits) {
  Serial.print('[');
  for (int i = 0; i < n; i++) {
    if (i) Serial.print(',');
    Serial.print((float)v[i], digits);
  }
  Serial.print(']');
}

void printConfig(bool asleep) {
  const Profile& p = settings.cur();
  Serial.print("cfg {\"mode\":");
  Serial.print(settings.mode);
  Serial.print(",\"sleep\":");
  Serial.print(asleep ? 1 : 0);
  Serial.print(",\"fav\":[");
  for (int i = 0; i < settings.favCount; i++) {
    if (i) Serial.print(',');
    Serial.print('"');
    printHex(settings.fav[i]);
    Serial.print('"');
  }
  Serial.print("],\"color\":\"");
  printHex(p.color);
  Serial.print("\",\"bright\":");
  Serial.print(p.bright);
  Serial.print(",\"sens\":");
  Serial.print(p.sens, 3);
  Serial.print(",\"lock\":");
  Serial.print(p.lockMask);
  Serial.print(",\"dsens\":");
  printArray(p.dsens, 12, 3);
  Serial.print(",\"dead\":");
  printArray(p.dead, 6, 1);
  Serial.print(",\"mix\":[");
  for (int i = 0; i < 6; i++) {
    if (i) Serial.print(',');
    Serial.print(p.mix[i]);
  }
  Serial.print("],\"tpl\":[");
  for (int k = 0; k < 12; k++) {
    if (k) Serial.print(',');
    printArray(p.tpl[k], 9, 4);
  }
  Serial.println("]}");
}

bool argInt(char*& s, long& out) {
  char* end;
  out = strtol(s, &end, 0);
  if (end == s) return false;
  s = end;
  return true;
}

bool argFloat(char*& s, float& out) {
  char* end;
  out = strtof(s, &end);
  if (end == s) return false;
  s = end;
  return true;
}
}  // namespace

void TelemetryController::begin() { tick_ = 0; }

bool TelemetryController::enabled() const { return streaming_; }

bool TelemetryController::takeCalibrationRequest() {
  const bool out = calRequested_;
  calRequested_ = false;
  return out;
}

void TelemetryController::poll() {
  while (Serial.available()) {
    const char c = Serial.read();
    if (c == '\r') continue;
    if (c != '\n') {
      if (len_ < sizeof(line_) - 1) line_[len_++] = c;
      continue;
    }
    line_[len_] = 0;
    len_ = 0;
    Serial.println(handle(line_) ? "ok" : "err");
  }
}

bool TelemetryController::handle(char* line) {
  char* cmd = strtok(line, " ");
  if (cmd == nullptr) return false;
  char* rest = strtok(nullptr, "");
  if (rest == nullptr) rest = (char*)"";
  Profile& p = settings.cur();
  long i = 0;
  float f = 0;

  if (!strcmp(cmd, "get")) {
    printConfig(asleep_);
    return true;
  }
  if (!strcmp(cmd, "mode")) {
    if (!argInt(rest, i) || i < 0 || i >= MODE_COUNT) return false;
    settings.mode = (uint8_t)i;
    settingsSave();
    Serial.println("ok");
    Serial.flush();
    delay(50);
    rp2040.reboot();
    return true;
  }
  if (!strcmp(cmd, "color")) {
    p.color = strtoul(rest, nullptr, 16) & 0xFFFFFF;
    if (ledController.isSolid()) ledController.setSolid(p.color);
    return true;
  }
  if (!strcmp(cmd, "bright")) {
    if (!argInt(rest, i) || i < 0 || i > 255) return false;
    p.bright = (uint8_t)i;
    ledController.setBrightness(p.bright);
    return true;
  }
  if (!strcmp(cmd, "sens")) {
    if (!argFloat(rest, f) || f < 0 || f > 10) return false;
    p.sens = f;
    return true;
  }
  if (!strcmp(cmd, "dsens")) {
    if (!argInt(rest, i) || i < 0 || i > 11 || !argFloat(rest, f) || f < 0 || f > 10) return false;
    p.dsens[i] = f;
    return true;
  }
  if (!strcmp(cmd, "dead")) {
    if (!argInt(rest, i) || i < 0 || i > 5 || !argFloat(rest, f) || f < 0 || f > 350) return false;
    p.dead[i] = f;
    return true;
  }
  if (!strcmp(cmd, "mix")) {
    long m;
    if (!argInt(rest, i) || i < 0 || i > 5 || !argInt(rest, m) || m < 0 || m > 2) return false;
    p.mix[i] = (uint8_t)m;
    return true;
  }
  if (!strcmp(cmd, "lock")) {
    if (!argInt(rest, i) || i < 0 || i > 0xFFF) return false;
    p.lockMask = (uint16_t)i;
    return true;
  }
  if (!strcmp(cmd, "tpl")) {
    float t[9];
    if (!argInt(rest, i) || i < 0 || i > 11) return false;
    for (int j = 0; j < 9; j++) {
      if (!argFloat(rest, t[j])) return false;
    }
    memcpy(p.tpl[i], t, sizeof(t));
    return true;
  }
  if (!strcmp(cmd, "fav")) {
    uint8_t n = 0;
    for (char* tok = strtok(rest, ", "); tok && n < 8; tok = strtok(nullptr, ", ")) {
      settings.fav[n++] = strtoul(tok, nullptr, 16) & 0xFFFFFF;
    }
    settings.favCount = n;
    return true;
  }
  if (!strcmp(cmd, "map")) {
    int8_t m[6];
    for (int j = 0; j < 6; j++) {
      if (!argInt(rest, i) || i < -6 || i > 6) return false;
      m[j] = (int8_t)i;
    }
    hidController.setMap(m);  // neukládá se: platí pro program v popředí, posílá ikonka
    return true;
  }
  if (!strcmp(cmd, "press")) {
    long flip, hb;
    if (!argInt(rest, i) || i < -6 || i > 6 || !argInt(rest, flip) || !argInt(rest, hb)) return false;
    hidController.setPress((int8_t)i, flip != 0, hb != 0);  // neukládá se, posílá ikonka
    return true;
  }
  if (!strcmp(cmd, "cal")) {
    calRequested_ = true;
    return true;
  }
  if (!strcmp(cmd, "stream")) {
    if (!argInt(rest, i)) return false;
    streaming_ = (i != 0);
    return true;
  }
  if (!strcmp(cmd, "save")) {
    settingsSave();
    return true;
  }
  if (!strcmp(cmd, "defaults")) {
    settingsDefaultProfile(settings.mode);
    ledController.setBrightness(settings.cur().bright);
    if (ledController.isSolid()) ledController.setSolid(settings.cur().color);
    return true;
  }
  return false;
}

// Posílá se vždy (i bez streamu) — jen při změně, takže nic nezahlcuje.
void TelemetryController::buttonEvent(int buttonBits, bool knobUsed) {
  Serial.print("b ");
  Serial.print(buttonBits);
  Serial.print(' ');
  Serial.println(knobUsed ? 1 : 0);
}

// "z 1" = myš usnula, "z 0" = probudila se (stránka a ikonka to ukážou).
void TelemetryController::sleepEvent(bool asleep) {
  asleep_ = asleep;
  Serial.println(asleep ? "z 1" : "z 0");
}

void TelemetryController::publish(const float raw[9], const float* baseline,
                                  const float motion[6], int buttonBits) {
  if (!streaming_) {
    return;
  }
  tick_++;
  if ((tick_ % kStreamEvery) != 0) {
    return;
  }
  Serial.print("s ");
  for (int i = 0; i < 9; i++) {
    Serial.print(raw[i] - baseline[i], 3);
    Serial.print(' ');
  }
  for (int i = 0; i < 6; i++) {
    Serial.print(motion[i], 1);
    Serial.print(' ');
  }
  Serial.println(buttonBits);
}
