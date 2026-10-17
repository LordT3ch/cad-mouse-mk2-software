#pragma once

#include "State.h"

class SleepState : public State {
 public:
  void enter() override;
  void update() override;
  void exit() override;
};
