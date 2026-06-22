#include <unity.h>
#include "watchdog.h"

void setUp(void) {}
void tearDown(void) {}

// timeout 10s, fail count 4
void test_no_alarm_within_window(void) {
  AlarmState a = watchdog_eval(9000, 10000, 4);
  TEST_ASSERT_EQUAL_INT((int)AlarmKind::None, (int)a.kind);
  TEST_ASSERT_EQUAL_UINT8(0, a.miss);
}

void test_disabled_when_timeout_zero(void) {
  AlarmState a = watchdog_eval(999999, 0, 4);
  TEST_ASSERT_EQUAL_INT((int)AlarmKind::None, (int)a.kind);
}

void test_miss1_yellow_2s(void) {
  AlarmState a = watchdog_eval(10000, 10000, 4);   // 1 miss
  TEST_ASSERT_EQUAL_INT((int)AlarmKind::YellowFlash, (int)a.kind);
  TEST_ASSERT_EQUAL_UINT8(1, a.miss);
  TEST_ASSERT_EQUAL_UINT32(2000, a.period_ms);
}

void test_miss2_yellow_1s(void) {
  AlarmState a = watchdog_eval(20000, 10000, 4);   // 2 misses
  TEST_ASSERT_EQUAL_INT((int)AlarmKind::YellowFlash, (int)a.kind);
  TEST_ASSERT_EQUAL_UINT32(1000, a.period_ms);
}

void test_miss3_yellow_half_s(void) {
  AlarmState a = watchdog_eval(30000, 10000, 4);   // 3 misses
  TEST_ASSERT_EQUAL_INT((int)AlarmKind::YellowFlash, (int)a.kind);
  TEST_ASSERT_EQUAL_UINT32(500, a.period_ms);
}

void test_miss4_red(void) {
  AlarmState a = watchdog_eval(40000, 10000, 4);   // 4 misses = fail count
  TEST_ASSERT_EQUAL_INT((int)AlarmKind::Red, (int)a.kind);
  TEST_ASSERT_EQUAL_UINT8(4, a.miss);
}

void test_red_stays_red_beyond(void) {
  AlarmState a = watchdog_eval(200000, 10000, 4);  // way past
  TEST_ASSERT_EQUAL_INT((int)AlarmKind::Red, (int)a.kind);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_no_alarm_within_window);
  RUN_TEST(test_disabled_when_timeout_zero);
  RUN_TEST(test_miss1_yellow_2s);
  RUN_TEST(test_miss2_yellow_1s);
  RUN_TEST(test_miss3_yellow_half_s);
  RUN_TEST(test_miss4_red);
  RUN_TEST(test_red_stays_red_beyond);
  return UNITY_END();
}
