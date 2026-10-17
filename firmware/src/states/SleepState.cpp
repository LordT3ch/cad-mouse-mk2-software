#include "states/SleepState.h"

#include <Arduino.h>

#include "Config.h"
#include "Controllers.h"
#include "StateMachine.h"

void SleepState::enter() {
  ledController.off();
  telemetryController.sleepEvent(true);
}

// Probouzí jen boční tlačítko (jako originál); knoflík ve spánku nic nedělá.
void SleepState::update() {
  inputController.update();
  if (inputController.takeActivity()) {
    StateMachine::idleState.swallowWakePress();
    stateMachine.changeState(&StateMachine::idleState);
  }
}

void SleepState::exit() { telemetryController.sleepEvent(false); }
