#include "sound_map.h"
#include <string.h>

struct Entry { const char* id; const char* path; };

// Extend this table as StackPI introduces new sound identifiers.
static const Entry kMap[] = {
  { "alert", "/alert.wav" },
  { "error", "/error.wav" },
  { "info",  "/info.wav"  },
};

const char* sound_file_for(const char* id) {
  if (!id || id[0] == '\0') return nullptr;
  for (const auto& e : kMap)
    if (strcmp(e.id, id) == 0) return e.path;
  return nullptr;
}
