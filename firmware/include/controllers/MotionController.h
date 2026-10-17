#pragma once

struct Profile;

class MotionController {
 public:
  void reset();
  void compute(const float raw[9], const float* baseline, float dt, float out[6]);
  bool hasMotionActivity() const;

 private:
  static float clampf(float v, float lo, float hi);
  static float lowpass(float prev, float x, float dt, float tau);
  void decompose(const float d[9], const Profile& p);
  float filt_[6] = {};
  float act_[12] = {};
  int lastExclusive_ = -1;
  bool motionActive_ = false;
};
