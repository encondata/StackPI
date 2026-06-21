#include <unity.h>

void setUp(void) {}
void tearDown(void) {}

void test_sanity(void) { TEST_ASSERT_EQUAL_INT(2, 1 + 1); }

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_sanity);
  return UNITY_END();
}
