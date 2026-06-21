#include "net.h"
#include "config.h"
#include "settings.h"
#include "net_validate.h"
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <WiFiManager.h>

namespace {
WiFiUDP   udp;
Settings  g_settings;
NetState  g_state = NetState::Connecting;
bool      g_portal = false;

void on_portal(WiFiManager*) { g_portal = true; }
}

void net_begin() {
  g_settings = settings_load();

  char portStr[8];
  snprintf(portStr, sizeof(portStr), "%u", g_settings.port);

  WiFiManager wm;
  WiFiManagerParameter pGroup("group", "Multicast group", g_settings.group, 16);
  WiFiManagerParameter pPort ("port",  "Multicast port",  portStr, 8);
  wm.addParameter(&pGroup);
  wm.addParameter(&pPort);
  wm.setAPCallback(on_portal);

  g_state = NetState::Connecting;
  bool ok = wm.autoConnect(AP_NAME);   // blocks: portal if no saved creds / fail

  // Persist any operator edits to group/port.
  Settings edited = g_settings;
  if (valid_multicast_group(pGroup.getValue())) {
    strncpy(edited.group, pGroup.getValue(), sizeof(edited.group) - 1);
    edited.group[sizeof(edited.group) - 1] = '\0';
  }
  long port = atol(pPort.getValue());
  if (valid_port(port)) edited.port = (uint16_t)port;
  if (strcmp(edited.group, g_settings.group) != 0 || edited.port != g_settings.port) {
    settings_save(edited);
    g_settings = edited;
  }

  if (!ok) { g_state = NetState::Disconnected; return; }

  IPAddress group;
  group.fromString(g_settings.group);
  udp.beginMulticast(group, g_settings.port);
  g_state = NetState::Connected;
}

int net_poll(char* buf, size_t maxlen) {
  if (WiFi.status() != WL_CONNECTED) {
    g_state = NetState::Disconnected;
    return 0;
  }
  g_state = NetState::Connected;
  int len = udp.parsePacket();
  if (len <= 0) return 0;
  int n = udp.read(buf, maxlen);
  return n > 0 ? n : 0;
}

NetState net_state() {
  if (g_portal && WiFi.status() != WL_CONNECTED) return NetState::Portal;
  return g_state;
}
