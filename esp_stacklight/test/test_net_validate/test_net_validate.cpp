#include <unity.h>
#include "net_validate.h"

void setUp(void) {}
void tearDown(void) {}

void test_valid_groups(void) {
  TEST_ASSERT_TRUE(valid_multicast_group("239.10.10.10"));
  TEST_ASSERT_TRUE(valid_multicast_group("224.0.0.1"));
  TEST_ASSERT_TRUE(valid_multicast_group("239.255.255.255"));
}

void test_invalid_groups(void) {
  TEST_ASSERT_FALSE(valid_multicast_group("192.168.1.1")); // not multicast
  TEST_ASSERT_FALSE(valid_multicast_group("240.0.0.1"));   // above range
  TEST_ASSERT_FALSE(valid_multicast_group("223.0.0.1"));   // below range
  TEST_ASSERT_FALSE(valid_multicast_group("239.10.10"));   // too few octets
  TEST_ASSERT_FALSE(valid_multicast_group("239.10.10.256"));// octet > 255
  TEST_ASSERT_FALSE(valid_multicast_group("hello"));        // garbage
}

void test_ports(void) {
  TEST_ASSERT_TRUE(valid_port(5005));
  TEST_ASSERT_TRUE(valid_port(1));
  TEST_ASSERT_TRUE(valid_port(65535));
  TEST_ASSERT_FALSE(valid_port(0));
  TEST_ASSERT_FALSE(valid_port(65536));
  TEST_ASSERT_FALSE(valid_port(-1));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_valid_groups);
  RUN_TEST(test_invalid_groups);
  RUN_TEST(test_ports);
  return UNITY_END();
}
