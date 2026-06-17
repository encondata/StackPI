// Map IANA timezone → operator-friendly label shown under the date on the
// kiosk status bar. We operate globally; the lookup table covers commonly-
// deployed regions with readable region names. For any IANA zone not in the
// table, we fall back to "Continent / City" reformatted from the IANA name
// itself — always produces something the operator can sanity-check rather
// than hiding the value. Shared by /status and /trucks (via KioskStatusBar).
const TZ_FRIENDLY: Record<string, string> = {
  // United States
  "America/New_York":      "US Eastern",
  "America/Detroit":       "US Eastern",
  "America/Indiana/Indianapolis": "US Eastern (Indiana)",
  "America/Chicago":       "US Central",
  "America/Denver":        "US Mountain",
  "America/Phoenix":       "US Arizona",
  "America/Los_Angeles":   "US Pacific",
  "America/Anchorage":     "US Alaska",
  "America/Adak":          "US Aleutian",
  "Pacific/Honolulu":      "US Hawaii",
  // Canada
  "America/Toronto":       "Canada Eastern",
  "America/Montreal":      "Canada Eastern",
  "America/Winnipeg":      "Canada Central",
  "America/Edmonton":      "Canada Mountain",
  "America/Vancouver":     "Canada Pacific",
  "America/Halifax":       "Canada Atlantic",
  "America/St_Johns":      "Canada Newfoundland",
  // Mexico / Central America
  "America/Mexico_City":   "Mexico Central",
  "America/Cancun":        "Mexico Eastern",
  "America/Monterrey":     "Mexico Central",
  "America/Tijuana":       "Mexico Pacific",
  "America/Guatemala":     "Guatemala",
  "America/Costa_Rica":    "Costa Rica",
  "America/Panama":        "Panama",
  // South America
  "America/Sao_Paulo":     "Brazil (São Paulo)",
  "America/Argentina/Buenos_Aires": "Argentina (Buenos Aires)",
  "America/Santiago":      "Chile",
  "America/Lima":          "Peru",
  "America/Bogota":        "Colombia",
  "America/Caracas":       "Venezuela",
  "America/La_Paz":        "Bolivia",
  // Europe (West / Central / East)
  "Europe/London":         "UK",
  "Europe/Dublin":         "Ireland",
  "Europe/Lisbon":         "Portugal",
  "Europe/Madrid":         "Spain",
  "Europe/Paris":          "France",
  "Europe/Brussels":       "Belgium",
  "Europe/Amsterdam":      "Netherlands",
  "Europe/Berlin":         "Germany",
  "Europe/Zurich":         "Switzerland",
  "Europe/Vienna":         "Austria",
  "Europe/Rome":           "Italy",
  "Europe/Copenhagen":     "Denmark",
  "Europe/Stockholm":      "Sweden",
  "Europe/Oslo":           "Norway",
  "Europe/Helsinki":       "Finland",
  "Europe/Warsaw":         "Poland",
  "Europe/Prague":         "Czech Republic",
  "Europe/Budapest":       "Hungary",
  "Europe/Bucharest":      "Romania",
  "Europe/Athens":         "Greece",
  "Europe/Istanbul":       "Türkiye",
  "Europe/Moscow":         "Russia (Moscow)",
  "Europe/Kiev":           "Ukraine",
  "Europe/Kyiv":           "Ukraine",
  // Africa
  "Africa/Casablanca":     "Morocco",
  "Africa/Algiers":        "Algeria",
  "Africa/Tunis":          "Tunisia",
  "Africa/Cairo":          "Egypt",
  "Africa/Lagos":          "Nigeria",
  "Africa/Accra":          "Ghana",
  "Africa/Nairobi":        "Kenya",
  "Africa/Addis_Ababa":    "Ethiopia",
  "Africa/Johannesburg":   "South Africa",
  // Middle East
  "Asia/Jerusalem":        "Israel",
  "Asia/Beirut":           "Lebanon",
  "Asia/Amman":            "Jordan",
  "Asia/Baghdad":          "Iraq",
  "Asia/Riyadh":           "Saudi Arabia",
  "Asia/Dubai":            "UAE",
  "Asia/Tehran":           "Iran",
  // South & Central Asia
  "Asia/Karachi":          "Pakistan",
  "Asia/Kolkata":          "India",
  "Asia/Calcutta":         "India",
  "Asia/Colombo":          "Sri Lanka",
  "Asia/Dhaka":            "Bangladesh",
  "Asia/Kathmandu":        "Nepal",
  // East / Southeast Asia
  "Asia/Bangkok":          "Thailand",
  "Asia/Ho_Chi_Minh":      "Vietnam",
  "Asia/Manila":           "Philippines",
  "Asia/Jakarta":          "Indonesia (Jakarta)",
  "Asia/Makassar":         "Indonesia (Makassar)",
  "Asia/Singapore":        "Singapore",
  "Asia/Kuala_Lumpur":     "Malaysia",
  "Asia/Hong_Kong":        "Hong Kong",
  "Asia/Taipei":           "Taiwan",
  "Asia/Shanghai":         "China",
  "Asia/Seoul":            "South Korea",
  "Asia/Pyongyang":        "North Korea",
  "Asia/Tokyo":            "Japan",
  // Oceania
  "Australia/Perth":       "Australia Western",
  "Australia/Adelaide":    "Australia Central",
  "Australia/Darwin":      "Australia Central (Darwin)",
  "Australia/Brisbane":    "Australia Eastern (Brisbane)",
  "Australia/Sydney":      "Australia Eastern (Sydney)",
  "Australia/Melbourne":   "Australia Eastern (Melbourne)",
  "Australia/Hobart":      "Australia Eastern (Tasmania)",
  "Pacific/Auckland":      "New Zealand",
  "Pacific/Fiji":          "Fiji",
  "Pacific/Port_Moresby":  "Papua New Guinea",
  // UTC / GMT specials
  "UTC":                   "UTC",
  "Etc/UTC":               "UTC",
  "GMT":                   "GMT",
  "Etc/GMT":               "GMT",
};

export function friendlyTimezone(iana: string | null | undefined): string {
  if (!iana) return "";
  const mapped = TZ_FRIENDLY[iana];
  if (mapped) return mapped;
  // Universal fallback: turn "Continent/City_Name" into "Continent / City Name".
  // Always produces something readable rather than hiding the value.
  return iana.replace(/_/g, " ").replace(/\//g, " / ");
}
