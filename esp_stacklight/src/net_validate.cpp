#include "net_validate.h"
#include <stdlib.h>
#include <ctype.h>

bool valid_port(long port) { return port >= 1 && port <= 65535; }

bool valid_multicast_group(const char* ip) {
  if (!ip) return false;
  int octets[4];
  int idx = 0;
  const char* p = ip;
  while (idx < 4) {
    if (!isdigit((unsigned char)*p)) return false;
    long v = 0;
    int digits = 0;
    while (isdigit((unsigned char)*p)) { v = v * 10 + (*p - '0'); p++; digits++; if (v > 255) return false; }
    if (digits == 0) return false;
    octets[idx++] = (int)v;
    if (idx < 4) { if (*p != '.') return false; p++; }
  }
  if (*p != '\0') return false;                 // trailing junk / extra octets
  return octets[0] >= 224 && octets[0] <= 239;  // IPv4 multicast range
}
