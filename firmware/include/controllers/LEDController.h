#pragma once

#include <Adafruit_NeoPixel.h>
#include <Arduino.h>

class LEDController {
 public:
  LEDController();
  void begin();
  void setSolid(unsigned long color);
  void startSpinner(unsigned long color);
  void updateSpinner();
  void setBrightness(uint8_t b);
  void showProgress(float progress, unsigned long color);
  void off();
  bool isSolid() const { return mode_ == Mode::Solid; }

 private:
  enum class Mode {
    Off,
    Solid,
    Spinner,
    Progress,
  };

  void setPower(bool enabled);
  void fillAll(unsigned long color);
  unsigned long toNeoColor(unsigned long color);

  bool isPowered_ = false;
  Mode mode_ = Mode::Off;
  unsigned long color_ = 0;
  int spinnerIndex_ = 0;
  unsigned long lastSpinnerStepMs_ = 0;
  Adafruit_NeoPixel ring_;
};
