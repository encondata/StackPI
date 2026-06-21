#pragma once
// Pure validators for the operator-supplied multicast group/port.
bool valid_multicast_group(const char* ip);  // 224.0.0.0 .. 239.255.255.255
bool valid_port(long port);                   // 1 .. 65535
