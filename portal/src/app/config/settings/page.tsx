import { redirect } from "next/navigation";

// Settings is a sidebar group, not a leaf — direct visits to /config/settings
// land on the first child page.
export default function SettingsIndex() {
  redirect("/config/settings/system");
}
