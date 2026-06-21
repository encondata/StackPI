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
  p.end();

  if (!valid_multicast_group(g.c_str())) g = DEFAULT_MCAST_GROUP;
  if (!valid_port((long)port))           port = DEFAULT_MCAST_PORT;

  strncpy(s.group, g.c_str(), sizeof(s.group) - 1);
  s.group[sizeof(s.group) - 1] = '\0';
  s.port = (uint16_t)port;
  return s;
}

void settings_save(const Settings& s) {
  Preferences p;
  p.begin(NS, false);                      // read-write
  p.putString("group", s.group);
  p.putUInt("port", s.port);
  p.end();
}
