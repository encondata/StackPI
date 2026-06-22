#pragma once
#include <stddef.h>
#include <stdint.h>

enum class NetState : uint8_t { Portal, Connecting, Connected, Disconnected };

void     net_begin();                          // WiFiManager + multicast join
int      net_poll(char* buf, size_t maxlen);   // 0 if no datagram
NetState net_state();

uint32_t net_hb_timeout_ms();                  // heartbeat watchdog timeout (ms); 0 = off
uint16_t net_hb_timeout_s();                   // same, in seconds (for the web form)
uint8_t  net_hb_fail_count();                  // misses until red alarm

// Update the heartbeat settings at runtime and persist them to NVS (survives reboot).
void     net_set_heartbeat(uint16_t timeout_s, uint8_t fail_count);
