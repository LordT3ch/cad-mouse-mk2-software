#include "controllers/LEDController.h"
#include "Config.h"
#include "Settings.h"

LEDController::LEDController()
    : ring_(Config::LED_COUNT, Config::PIN_LED_DATA,
            NEO_GRB + NEO_KHZ800) {}

void LEDController::fillAll(unsigned long color) {
  for (int i = 0; i < ring_.numPixels(); i++) {
    ring_.setPixelColor(i, color);
  }
}

unsigned long LEDController::toNeoColor(unsigned long color) {
  int r = (color >> 16) & 0xFF;
  int g = (color >> 8) & 0xFF;
  int b = color & 0xFF;
  return ring_.Color(r, g, b);
}

void LEDController::begin() {
  pinMode(Config::PIN_LED_LS, OUTPUT);
  digitalWrite(Config::PIN_LED_LS, LOW);

  ring_.begin();
  ring_.setBrightness(settings.cur().bright);
  ring_.show();
}

void LEDController::setPower(bool enabled) {
  if (enabled == isPowered_) {
    return;
  }

  isPowered_ = enabled;
  digitalWrite(Config::PIN_LED_LS, enabled ? HIGH : LOW);
  delay(10);
  
}

void LEDController::setSolid(unsigned long color) {
  mode_ = Mode::Solid;
  color_ = toNeoColor(color);
  setPower(true);
  fillAll(color_);
  ring_.show();
}

void LEDController::startSpinner(unsigned long color) {
  mode_ = Mode::Spinner;
  color_ = toNeoColor(color);
  spinnerIndex_ = 0;
  lastSpinnerStepMs_ = 0;
  setPower(true);
}

void LEDController::updateSpinner() {
  if (mode_ != Mode::Spinner) {
    return;
  }

  const unsigned long now = millis();
  if (lastSpinnerStepMs_ != 0 && (now - lastSpinnerStepMs_) < 60) {
    return;
  }
  lastSpinnerStepMs_ = now;

  fillAll(0);
  int pixelCount = ring_.numPixels();
  ring_.setPixelColor(spinnerIndex_, color_);
  ring_.show();

  spinnerIndex_++;
  if (spinnerIndex_ >= pixelCount) {
    spinnerIndex_ = 0;
  }
}

void LEDController::setBrightness(uint8_t b) {
  ring_.setBrightness(b);
  if (mode_ == Mode::Solid) {
    fillAll(color_);
    ring_.show();
  }
}

// Mode-switch feedback: the ring fills with the target mode colour.
void LEDController::showProgress(float progress, unsigned long color) {
  mode_ = Mode::Progress;
  setPower(true);
  const int n = ring_.numPixels();
  const int lit = (int)(progress * n + 0.5f);
  const unsigned long c = toNeoColor(color);
  for (int i = 0; i < n; i++) ring_.setPixelColor(i, i < lit ? c : 0);
  ring_.show();
}

void LEDController::off() {
  mode_ = Mode::Off;
  fillAll(0);
  ring_.show();
  setPower(false);
}
