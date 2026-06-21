#pragma once

// Lightweight on-device test page (port 80). Call web_begin() once after Wi-Fi
// connects, then web_handle() each loop iteration.
void web_begin();
void web_handle();
