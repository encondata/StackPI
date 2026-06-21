#include <unity.h>
#include "lamp_state.h"

void setUp(void) {}
void tearDown(void) {}

static LightCommand cmd(Pattern p, uint8_t bright, uint32_t dur, uint8_t rep) {
  LightCommand c;
  c.color = Color::Red;
  c.pattern = p;
  c.brightness = bright;
  c.duration_ms = dur;
  c.repeat_count = rep;
  return c;
}

void test_initial_off(void) {
  LampState s;
  TEST_ASSERT_EQUAL_UINT8(0, s.duty(0));
  TEST_ASSERT_EQUAL_UINT8(0, s.duty(10000));
}

void test_solid_full_holds(void) {
  LampState s;
  s.apply(cmd(Pattern::Solid, 100, 500, 1), 1000);
  TEST_ASSERT_EQUAL_UINT8(255, s.duty(1000));
  TEST_ASSERT_EQUAL_UINT8(255, s.duty(99999));   // holds forever
}

void test_solid_brightness_zero_off(void) {
  LampState s;
  s.apply(cmd(Pattern::Solid, 0, 500, 1), 0);
  TEST_ASSERT_EQUAL_UINT8(0, s.duty(0));
  TEST_ASSERT_EQUAL_UINT8(0, s.duty(5000));
}

void test_solid_brightness_scaled(void) {
  LampState s;
  s.apply(cmd(Pattern::Solid, 80, 500, 1), 0);
  TEST_ASSERT_EQUAL_UINT8(204, s.duty(0));       // round(80*255/100)
}

void test_flash_square_then_off(void) {
  LampState s;
  s.apply(cmd(Pattern::Flash, 100, 500, 3), 0);  // period 500, 3 cycles -> off at 1500
  TEST_ASSERT_EQUAL_UINT8(255, s.duty(0));       // first half on
  TEST_ASSERT_EQUAL_UINT8(0,   s.duty(300));     // second half off
  TEST_ASSERT_EQUAL_UINT8(255, s.duty(500));     // next cycle on
  TEST_ASSERT_EQUAL_UINT8(0,   s.duty(1500));    // all cycles done -> off
  TEST_ASSERT_EQUAL_UINT8(0,   s.duty(9000));    // stays off
}

void test_pulse_peaks_midcycle_then_off(void) {
  LampState s;
  s.apply(cmd(Pattern::Pulse, 100, 400, 1), 0);  // period 400, 1 cycle -> off at 400
  TEST_ASSERT_EQUAL_UINT8(0,   s.duty(0));        // starts dark
  TEST_ASSERT_EQUAL_UINT8(255, s.duty(200));      // peak at half period
  TEST_ASSERT_EQUAL_UINT8(0,   s.duty(400));      // cycle done -> off
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_initial_off);
  RUN_TEST(test_solid_full_holds);
  RUN_TEST(test_solid_brightness_zero_off);
  RUN_TEST(test_solid_brightness_scaled);
  RUN_TEST(test_flash_square_then_off);
  RUN_TEST(test_pulse_peaks_midcycle_then_off);
  return UNITY_END();
}
