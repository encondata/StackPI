#pragma once
#include <stddef.h>

enum class NetState : uint8_t { Portal, Connecting, Connected, Disconnected };

void     net_begin();                          // WiFiManager + multicast join
int      net_poll(char* buf, size_t maxlen);   // 0 if no datagram
NetState net_state();
