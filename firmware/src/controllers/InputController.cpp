#include "controllers/InputController.h"

#include "Config.h"

using namespace ace_button;

namespace {
const unsigned long kChordWindowMs = 100;   // wait this long for the 2nd button
const unsigned long kModeHoldMs = 3000;     // hold both this long = switch mode
const unsigned long kTapPulseMs = 30;       // a tap shorter than the window
const uint16_t leftButtonMask = 0x0001;
const uint16_t rightButtonMask = 0x0002;
}  // namespace

InputController* InputController::instance_ = nullptr;

InputController::InputController()
    : leftBtn_(Config::PIN_LEFT_BTN), rightBtn_(Config::PIN_RIGHT_BTN) {}

void InputController::begin() {
  pinMode(Config::PIN_LEFT_BTN, INPUT_PULLUP);
  pinMode(Config::PIN_RIGHT_BTN, INPUT_PULLUP);

  ButtonConfig* cfg = ButtonConfig::getSystemButtonConfig();
  cfg->setEventHandler(handleButtonEvent);

  instance_ = this;
}

uint16_t InputController::rawBits() const {
  return (leftPressed_ ? leftButtonMask : 0) | (rightPressed_ ? rightButtonMask : 0);
}

// Buttons go to the PC with a short delay so that pressing both together
// (mode switch) never reaches the PC as two separate button presses.
void InputController::update() {
  const unsigned long now = millis();
  leftBtn_.check();
  rightBtn_.check();
  const uint16_t raw = rawBits();

  if (raw == 0) {
    if (pendingSinceMs_ != 0 && !chord_ && !released_) {
      // Tapped and released inside the window: still deliver a short press.
      pulseBits_ = pendingBits_;
      pulseUntilMs_ = now + kTapPulseMs;
    }
    pendingSinceMs_ = 0;
    pendingBits_ = 0;
    chord_ = false;
    released_ = false;
    modeFired_ = false;
    reported_ = (now < pulseUntilMs_) ? pulseBits_ : 0;
    return;
  }

  if (pendingSinceMs_ == 0) {
    pendingSinceMs_ = now;
  }
  pendingBits_ |= raw;

  if (chord_) {
    reported_ = 0;
    if (!modeFired_ && now - chordStartMs_ >= kModeHoldMs) {
      modeFired_ = true;
      modeSwitchRequested_ = true;
    }
    return;
  }

  if (!released_) {
    if (raw == (leftButtonMask | rightButtonMask)) {
      chord_ = true;
      chordStartMs_ = now;
      reported_ = 0;
      return;
    }
    if (now - pendingSinceMs_ < kChordWindowMs) {
      reported_ = 0;
      return;
    }
    released_ = true;  // window over: normal buttons from now on
  }
  reported_ = raw;
}

uint16_t InputController::buttonBits() const { return reported_; }

float InputController::modeHoldProgress() const {
  if (!chord_ || modeFired_) return -1.0f;
  return min(1.0f, (millis() - chordStartMs_) / (float)kModeHoldMs);
}

bool InputController::takeModeSwitchRequest() {
  const bool out = modeSwitchRequested_;
  modeSwitchRequested_ = false;
  return out;
}

bool InputController::takeActivity() {
  const bool out = hadActivity_;
  hadActivity_ = false;
  return out;
}

void InputController::handleButtonEvent(AceButton* button, uint8_t eventType,
                                        uint8_t /*buttonState*/) {
  if (instance_ == nullptr) {
    return;
  }
  instance_->onButtonEvent(button, eventType);
}

void InputController::onButtonEvent(AceButton* button, uint8_t eventType) {
  const bool pressed = (eventType == AceButton::kEventPressed);
  if (!pressed && eventType != AceButton::kEventReleased) {
    return;
  }
  if (button->getPin() == Config::PIN_LEFT_BTN) {
    leftPressed_ = pressed;
  } else if (button->getPin() == Config::PIN_RIGHT_BTN) {
    rightPressed_ = pressed;
  } else {
    return;
  }
  hadActivity_ = true;
}
