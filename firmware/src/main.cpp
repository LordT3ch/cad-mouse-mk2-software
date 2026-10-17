#include <Arduino.h>

#include "Config.h"
#include "Controllers.h"
#include "Settings.h"
#include "StateMachine.h"

InputController inputController;
LEDController ledController;
SensorController sensorController;
MotionController motionController;
HIDController hidController;
TelemetryController telemetryController;

void setup() {
  settingsLoad();  // before USB: the saved mode picks the USB identity
  hidController.begin();

  Serial.begin(115200);

  inputController.begin();
  ledController.begin();
  sensorController.begin();
  motionController.reset();
  telemetryController.begin();

  stateMachine.changeState(&StateMachine::calibratingState);
}

void loop() {
  hidController.task();
  telemetryController.poll();
  stateMachine.update();
}
