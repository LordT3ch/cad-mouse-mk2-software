#pragma once

#include <stddef.h>

// USB serial: settings commands from the tray/tuning page + optional data stream.
class TelemetryController {
 public:
  void begin();
  void poll();
  void publish(const float raw[9], const float* baseline, const float motion[6],
               int buttonBits);
  bool enabled() const;
  bool takeCalibrationRequest();
  void buttonEvent(int buttonBits, bool knobUsed);
  void sleepEvent(bool asleep);

 private:
  bool handle(char* line);

  int tick_ = 0;
  bool streaming_ = false;
  bool calRequested_ = false;
  bool asleep_ = false;
  char line_[200] = {};
  size_t len_ = 0;
};
