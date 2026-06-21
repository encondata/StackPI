#include <unity.h>
#include <string.h>
#include "protocol.h"

void setUp(void) {}
void tearDown(void) {}

void test_light_full(void) {
  const char* j = "{\"v\":1,\"type\":\"light\",\"pattern\":\"flash\",\"color\":\"red\","
                  "\"brightness\":80,\"duration\":500,\"repeat_count\":3}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Light, (int)m.kind);
  TEST_ASSERT_EQUAL_INT((int)Color::Red, (int)m.light.color);
  TEST_ASSERT_EQUAL_INT((int)Pattern::Flash, (int)m.light.pattern);
  TEST_ASSERT_EQUAL_UINT8(80, m.light.brightness);
  TEST_ASSERT_EQUAL_UINT32(500, m.light.duration_ms);
  TEST_ASSERT_EQUAL_UINT8(3, m.light.repeat_count);
}

void test_sound_full(void) {
  const char* j = "{\"v\":1,\"type\":\"sound\",\"sound\":\"alert\","
                  "\"volume\":70,\"duration\":400,\"repeat_count\":2}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Sound, (int)m.kind);
  TEST_ASSERT_EQUAL_STRING("alert", m.sound.sound);
  TEST_ASSERT_EQUAL_UINT8(70, m.sound.volume);
  TEST_ASSERT_EQUAL_UINT8(2, m.sound.repeat_count);
}

void test_wrong_version_ignored(void) {
  const char* j = "{\"v\":2,\"type\":\"light\",\"pattern\":\"solid\",\"color\":\"red\"}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Ignore, (int)m.kind);
}

void test_unknown_type_ignored(void) {
  const char* j = "{\"v\":1,\"type\":\"buzz\"}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Ignore, (int)m.kind);
}

void test_unknown_color_ignored(void) {
  const char* j = "{\"v\":1,\"type\":\"light\",\"pattern\":\"solid\",\"color\":\"purple\"}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Ignore, (int)m.kind);
}

void test_bad_json_ignored(void) {
  const char* j = "not json at all";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Ignore, (int)m.kind);
}

void test_clamping(void) {
  const char* j = "{\"v\":1,\"type\":\"light\",\"pattern\":\"solid\",\"color\":\"green\","
                  "\"brightness\":250,\"duration\":0,\"repeat_count\":99}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Light, (int)m.kind);
  TEST_ASSERT_EQUAL_UINT8(100, m.light.brightness);     // clamped 0..100
  TEST_ASSERT_EQUAL_UINT32(1, m.light.duration_ms);     // clamped >=1
  TEST_ASSERT_EQUAL_UINT8(5, m.light.repeat_count);     // clamped 1..5
}

void test_defaults_applied(void) {
  // Missing optional fields fall back to documented defaults.
  const char* j = "{\"v\":1,\"type\":\"light\",\"pattern\":\"solid\",\"color\":\"blue\"}";
  ParsedMessage m = parse_message(j, strlen(j));
  TEST_ASSERT_EQUAL_INT((int)MsgKind::Light, (int)m.kind);
  TEST_ASSERT_EQUAL_UINT8(100, m.light.brightness);
  TEST_ASSERT_EQUAL_UINT8(1, m.light.repeat_count);
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_light_full);
  RUN_TEST(test_sound_full);
  RUN_TEST(test_wrong_version_ignored);
  RUN_TEST(test_unknown_type_ignored);
  RUN_TEST(test_unknown_color_ignored);
  RUN_TEST(test_bad_json_ignored);
  RUN_TEST(test_clamping);
  RUN_TEST(test_defaults_applied);
  return UNITY_END();
}
