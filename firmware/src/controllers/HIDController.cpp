#include "controllers/HIDController.h"

#include <math.h>

#include "Config.h"
#include "Settings.h"

namespace {
// 3Dconnexion-compatible layout (picked up by 3DxWare as SpaceMouse Pro).
const uint8_t kSpaceMouseDescriptor[] PROGMEM = {
    0x05, 0x01,        // USAGE_PAGE (Generic Desktop)
    0x09, 0x08,        // USAGE (Multi-axis Controller)
    0xA1, 0x01,        // COLLECTION (Application)
    0xA1, 0x00,        // COLLECTION (Physical)
    0x85, 0x01,        // REPORT_ID (1)
    0x16, 0xA2, 0xFE,  // LOGICAL_MINIMUM  (-350)
    0x26, 0x5E, 0x01,  // LOGICAL_MAXIMUM  (350)
    0x09, 0x30,        // USAGE (X)
    0x09, 0x31,        // USAGE (Y)
    0x09, 0x32,        // USAGE (Z)
    0x09, 0x33,        // USAGE (Rx)
    0x09, 0x34,        // USAGE (Ry)
    0x09, 0x35,        // USAGE (Rz)
    0x75, 0x10,        // REPORT_SIZE (16)
    0x95, 0x06,        // REPORT_COUNT (6)
    0x81, 0x02,        // INPUT (Data,Var,Abs)
    0xC0,              // END_COLLECTION
    0xA1, 0x00,        // COLLECTION (Physical)
    0x85, 0x03,        // REPORT_ID (3)
    0x05, 0x09,        // USAGE_PAGE (Button)
    0x19, 0x01,        // USAGE_MINIMUM (Button 1)
    0x29, 0x02,        // USAGE_MAXIMUM (Button 2)
    0x15, 0x00,        // LOGICAL_MINIMUM (0)
    0x25, 0x01,        // LOGICAL_MAXIMUM (1)
    0x75, 0x01,        // REPORT_SIZE (1)
    0x95, 0x02,        // REPORT_COUNT (2)
    0x81, 0x02,        // INPUT (Data,Var,Abs)
    0x95, 0x0E,        // REPORT_COUNT (14) padding
    0x81, 0x01,        // INPUT (Const,Array,Abs)
    0xC0,              // END_COLLECTION
    0xC0               // END_COLLECTION
};

// Plain game controller: 6 axes + 32 buttons (room for future extra buttons).
const uint8_t kJoystickDescriptor[] PROGMEM = {
    0x05, 0x01,        // USAGE_PAGE (Generic Desktop)
    0x09, 0x04,        // USAGE (Joystick)
    0xA1, 0x01,        // COLLECTION (Application)
    0x85, 0x01,        // REPORT_ID (1)
    0x16, 0xA2, 0xFE,  // LOGICAL_MINIMUM (-350)
    0x26, 0x5E, 0x01,  // LOGICAL_MAXIMUM (350)
    0x09, 0x30, 0x09, 0x31, 0x09, 0x32,  // X, Y, Z
    0x09, 0x33, 0x09, 0x34, 0x09, 0x35,  // Rx, Ry, Rz
    0x75, 0x10,        // REPORT_SIZE (16)
    0x95, 0x06,        // REPORT_COUNT (6)
    0x81, 0x02,        // INPUT (Data,Var,Abs)
    0x05, 0x09,        // USAGE_PAGE (Button)
    0x19, 0x01,        // USAGE_MINIMUM (Button 1)
    0x29, 0x20,        // USAGE_MAXIMUM (Button 32)
    0x15, 0x00, 0x25, 0x01,
    0x75, 0x01,        // REPORT_SIZE (1)
    0x95, 0x20,        // REPORT_COUNT (32)
    0x81, 0x02,        // INPUT (Data,Var,Abs)
    0xC0               // END_COLLECTION
};

const uint16_t kJoystickVid = 0x2E8A;
const uint16_t kJoystickPid = 0x0CAD;
}  // namespace

void HIDController::begin() {
  joystick_ = (settings.mode == MODE_JOYSTICK);
  if (joystick_) {
    TinyUSBDevice.setID(kJoystickVid, kJoystickPid);
    TinyUSBDevice.setProductDescriptor("CAD Mouse MK2 Joystick");
    usbHid_.setReportDescriptor(kJoystickDescriptor, sizeof(kJoystickDescriptor));
  } else {
    usbHid_.setReportDescriptor(kSpaceMouseDescriptor, sizeof(kSpaceMouseDescriptor));
  }
  if (!TinyUSBDevice.isInitialized()) {
    TinyUSBDevice.begin(0);
  }
  usbHid_.setPollInterval(1);
  usbHid_.begin();
  // The core enumerated before setup(); re-attach so the host reads the
  // identity and HID interface chosen above.
  if (TinyUSBDevice.mounted()) {
    TinyUSBDevice.detach();
    delay(10);
    TinyUSBDevice.attach();
  }
}

void HIDController::task() { TinyUSBDevice.task(); }

// Přemapování os pro program v popředí (posílá ikonka příkazem "map"): výstupní osa i
// dostane osu |map_[i]|-1 (záporné = obráceně), 0 = vypnuto. Výchozí 1..6 = beze změny.
void HIDController::setMap(const int8_t map[6]) {
  for (int i = 0; i < 6; i++) map_[i] = map[i];
}

// Zmáčknutí jako zoom: síla zmáčknutí se přičte k výstupní ose |to| (znaménko = směr), s podrženým
// bočním tlačítkem obráceně (flip). hidButtons = 0: tlačítka do PC nejdou (řeší je ikonka zkratkami).
void HIDController::setPress(int8_t to, bool flip, bool hidButtons) {
  pressTo_ = to;
  pressFlip_ = flip;
  hidButtons_ = hidButtons;
}

HIDController::ReportAxes HIDController::makeAxesReport(const float motion[6], uint32_t buttons) const {
  float m[6];
  for (int i = 0; i < 6; i++) {
    const int s = map_[i];
    m[i] = s == 0 ? 0.0f : (s > 0 ? motion[s - 1] : -motion[-s - 1]);
  }
  if (pressTo_ != 0) {
    float v = fabsf(motion[2]) * (pressTo_ > 0 ? 1.0f : -1.0f);
    if (pressFlip_ && buttons) v = -v;
    const int t = (pressTo_ > 0 ? pressTo_ : -pressTo_) - 1;
    m[t] = fmaxf(-Config::AXIS_LIMIT, fminf(Config::AXIS_LIMIT, m[t] + v));
  }
  ReportAxes axes{};
  axes.x = static_cast<int16_t>(m[0]);
  axes.y = static_cast<int16_t>(m[1]);
  axes.z = static_cast<int16_t>(m[2]);
  axes.rx = static_cast<int16_t>(m[3]);
  axes.ry = static_cast<int16_t>(m[4]);
  axes.rz = static_cast<int16_t>(m[5]);
  return axes;
}

bool HIDController::axesReportChanged(const ReportAxes& axes) const {
  return axes.x != lastSentAxes_.x || axes.y != lastSentAxes_.y ||
         axes.z != lastSentAxes_.z || axes.rx != lastSentAxes_.rx ||
         axes.ry != lastSentAxes_.ry || axes.rz != lastSentAxes_.rz;
}

bool HIDController::sendReports(const float motion[6], uint32_t buttonBits) {
  const ReportAxes axes = makeAxesReport(motion, buttonBits);
  if (!hidButtons_ && !joystick_) buttonBits = 0;  // v joysticku tlačítka vždy pro hru
  // Při pohybu posílat průběžně i nezměněné hodnoty (jako originální SpaceMouse): na plné
  // výchylce se hodnota nemění, a kdyby zprávy přestaly chodit, Blender pohyb ukončí (sekání).
  const bool moving = axes.x || axes.y || axes.z || axes.rx || axes.ry || axes.rz;
  const unsigned long now = millis();
  const bool sendAxes = axesReportChanged(axes) || (moving && now - lastAxesMs_ >= 8);
  if (sendAxes) lastAxesMs_ = now;
  const bool sendButtons = (buttonBits != buttonBitsSent_);

  if (!usbHid_.ready() || (!sendAxes && !sendButtons)) {
    return false;
  }

  if (joystick_) {
    ReportJoystick rep{axes, buttonBits};
    usbHid_.sendReport(0x01, &rep, sizeof(rep));
    lastSentAxes_ = axes;
    buttonBitsSent_ = buttonBits;
    return true;
  }

  if (sendAxes) {
    usbHid_.sendReport(0x01, &axes, sizeof(axes));
    lastSentAxes_ = axes;
  }
  if (sendButtons) {
    ReportButtons btn{};
    btn.bits = buttonBits & 0x0003;
    usbHid_.sendReport(0x03, &btn, sizeof(btn));
    buttonBitsSent_ = buttonBits;
  }
  return true;
}
