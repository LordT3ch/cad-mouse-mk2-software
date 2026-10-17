#pragma once

#include <Arduino.h>
#include <AceButton.h>

class InputController {
 public:
  InputController();
  void begin();
  void update();

  uint16_t buttonBits() const;     // what the PC should see
  float modeHoldProgress() const;  // 0..1 while both held, -1 otherwise
  bool takeModeSwitchRequest();
  bool takeActivity();
  bool anyPressed() const { return rawBits() != 0; }

 private:
  static void handleButtonEvent(ace_button::AceButton* button, uint8_t eventType,
                                uint8_t buttonState);
  void onButtonEvent(ace_button::AceButton* button, uint8_t eventType);
  uint16_t rawBits() const;

  ace_button::AceButton leftBtn_;
  ace_button::AceButton rightBtn_;

  bool leftPressed_ = false;
  bool rightPressed_ = false;
  bool hadActivity_ = false;

  unsigned long pendingSinceMs_ = 0;
  uint16_t pendingBits_ = 0;
  bool released_ = false;  // chord window passed, buttons pass through
  bool chord_ = false;
  unsigned long chordStartMs_ = 0;
  bool modeFired_ = false;
  bool modeSwitchRequested_ = false;
  uint16_t reported_ = 0;
  uint16_t pulseBits_ = 0;
  unsigned long pulseUntilMs_ = 0;

  static InputController* instance_;
};
