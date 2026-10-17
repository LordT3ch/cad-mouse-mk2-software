#pragma once

#include "State.h"

class CalibratingState : public State {
 public:
  void enter() override;
  void update() override;
  void exit() override;
};
