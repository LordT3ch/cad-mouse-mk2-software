#pragma once

#include <stdint.h>

#include "State.h"

class IdleState : public State {
 public:
  void enter() override;
  void update() override;
  void exit() override;
  void swallowWakePress() { swallowButtons_ = true; }

 private:
  bool handleCalibrationRequest();
  void handleModeSwitch();
  void runMotionPipeline(float dt, unsigned long now);
  void handleSleepTransition(unsigned long now);

  unsigned long lastUpdateMs_ = 0;
  unsigned long lastActivityMs_ = 0;
  bool showingProgress_ = false;
  uint16_t lastButtonBits_ = 0;
  bool knobUsedWhileHeld_ = false;
  bool swallowButtons_ = false;
};
