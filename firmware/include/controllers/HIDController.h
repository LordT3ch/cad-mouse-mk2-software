#pragma once

#include <Adafruit_TinyUSB.h>
#include <Arduino.h>

class HIDController {
 public:
  void begin();  // reads settings.mode: SpaceMouse or Joystick USB identity
  void task();
  bool sendReports(const float motion[6], uint32_t buttonBits);
  void setMap(const int8_t map[6]);
  void setPress(int8_t to, bool flip, bool hidButtons);

 private:
  struct __attribute__((packed)) ReportAxes {
    int16_t x, y, z, rx, ry, rz;
  };

  struct __attribute__((packed)) ReportButtons {
    uint16_t bits;
  };

  struct __attribute__((packed)) ReportJoystick {
    ReportAxes axes;
    uint32_t buttons;
  };

  ReportAxes makeAxesReport(const float motion[6], uint32_t buttons) const;
  bool axesReportChanged(const ReportAxes& axes) const;

  Adafruit_USBD_HID usbHid_;
  bool joystick_ = false;
  uint32_t buttonBitsSent_ = 0;
  ReportAxes lastSentAxes_{};
  unsigned long lastAxesMs_ = 0;
  int8_t map_[6] = {1, 2, 3, 4, 5, 6};
  int8_t pressTo_ = 0;
  bool pressFlip_ = false;
  bool hidButtons_ = true;
};
