#include "settings.h"
#include "config.h"
#include "net_validate.h"
#include <Arduino.h>
#include <Preferences.h>
#include <string.h>

static const char* NS = "stacklight";

Settings settings_load() {
  Settings s;
  Preferences p;
  p.begin(NS, false);                      // read-write: creates the namespace
                                           // on first boot (avoids a NOT_FOUND
                                           // error log from a read-only open)
  String g = p.getString("group", DEFAULT_MCAST_GROUP);
  uint32_t port = p.getUInt("port", DEFAULT_MCAST_PORT);
  uint32_t hbsec = p.getUInt("hbsec", DEFAULT_HB_TIMEOUT_S);
  uint32_t hbcnt = p.getUInt("hbcnt", DEFAULT_HB_FAIL_COUNT);
  p.end();

  if (!valid_multicast_group(g.c_str())) g = DEFAULT_MCAST_GROUP;
  if (!valid_port((long)port))           port = DEFAULT_MCAST_PORT;
  if (hbsec > 65535)                     hbsec = DEFAULT_HB_TIMEOUT_S;
  if (hbcnt < 1 || hbcnt > 50)           hbcnt = DEFAULT_HB_FAIL_COUNT;

  strncpy(s.group, g.c_str(), sizeof(s.group) - 1);
  s.group[sizeof(s.group) - 1] = '\0';
  s.port = (uint16_t)port;
  s.hb_timeout_s  = (uint16_t)hbsec;
  s.hb_fail_count = (uint8_t)hbcnt;
  return s;
}

void settings_save(const Settings& s) {
  Preferences p;
  p.begin(NS, false);                      // read-write
  p.putString("group", s.group);
  p.putUInt("port", s.port);
  p.putUInt("hbsec", s.hb_timeout_s);
  p.putUInt("hbcnt", s.hb_fail_count);
  p.end();
}
