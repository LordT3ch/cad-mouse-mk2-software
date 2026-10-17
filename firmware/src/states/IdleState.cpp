#include "states/IdleState.h"

#include <Arduino.h>

#include "Config.h"
#include "Controllers.h"
#include "Settings.h"
#include "StateMachine.h"

void IdleState::enter() {
  lastUpdateMs_ = 0;
  lastActivityMs_ = millis();
  showingProgress_ = false;
  ledController.setSolid(settings.cur().color);
}

bool IdleState::handleCalibrationRequest() {
  if (telemetryController.takeCalibrationRequest()) {
    stateMachine.changeState(&StateMachine::calibratingState);
    return true;
  }
  return false;
}

// Holding both buttons fills the ring with the other mode's colour; when full,
// the mode is saved and the mouse re-enumerates as the other USB device.
void IdleState::handleModeSwitch() {
  const uint8_t target = (settings.mode + 1) % MODE_COUNT;
  if (inputController.takeModeSwitchRequest()) {
    settings.mode = target;
    settingsSave();
    delay(50);
    rp2040.reboot();
  }
  const float progress = inputController.modeHoldProgress();
  if (progress >= 0.0f) {
    ledController.showProgress(progress, settings.p[target].color);
    showingProgress_ = true;
  } else if (showingProgress_) {
    ledController.setSolid(settings.cur().color);
    showingProgress_ = false;
  }
}

void IdleState::runMotionPipeline(float dt, unsigned long now) {
  float raw[9] = {};
  sensorController.readRaw(raw);

  float motion[6] = {};
  motionController.compute(raw, sensorController.baseline(), dt, motion);

  if (motionController.hasMotionActivity()) {
    lastActivityMs_ = now;
  }

  // Stisk, který myš probudil, do PC nepošleme (jinak by spustil akci tlačítka).
  if (swallowButtons_ && !inputController.anyPressed()) swallowButtons_ = false;
  const uint16_t buttonBits = swallowButtons_ ? 0 : inputController.buttonBits();
  hidController.sendReports(motion, buttonBits);

  // Pro ikonku v liště (mapování tlačítek na zkratky): "b <bity> <knoflík použit>".
  // Použit = během držení tlačítka se hýbal knoflík (např. oddálení) -> akce se nespustí.
  if (buttonBits && motionController.hasMotionActivity()) knobUsedWhileHeld_ = true;
  if (buttonBits != lastButtonBits_) {
    telemetryController.buttonEvent(buttonBits, knobUsedWhileHeld_);
    if (!buttonBits) knobUsedWhileHeld_ = false;
    lastButtonBits_ = buttonBits;
  }
  telemetryController.publish(raw, sensorController.baseline(), motion, buttonBits);
}

// Jako originál: po nečinnosti usne (LED zhasne, knoflík nereaguje), probudí se tlačítkem.
// Otevřená ladicí stránka ani doplněk Fusionu spánek nebrání.
void IdleState::handleSleepTransition(unsigned long now) {
  const unsigned long inactiveMs = now - lastActivityMs_;
  if (inactiveMs >= Config::IDLE_SLEEP_TIMEOUT_MS) {
    stateMachine.changeState(&StateMachine::sleepState);
  }
}

void IdleState::update() {
  inputController.update();

  if (handleCalibrationRequest()) {
    return;
  }
  handleModeSwitch();

  const unsigned long now = millis();
  if (inputController.takeActivity()) {
    lastActivityMs_ = now;
  }

  const float dt = (lastUpdateMs_ == 0) ? 0.01
                                        : ((now - lastUpdateMs_) / 1000.0);
  lastUpdateMs_ = now;
  runMotionPipeline(dt, now);
  handleSleepTransition(now);
}

void IdleState::exit() {}
