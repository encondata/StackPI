"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutGrid,
  Settings,
  FileText,
  Fingerprint,
  Database,
  Radio,
  ChevronDown,
  ChevronRight,
  Menu as MenuIcon,
  type LucideIcon,
} from "lucide-react";

// Nested children whose href is a /prefix/ match should still expand & highlight
// the parent. Stable across sub-pages without one rule per child.
function startsWithPath(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

type SubItem = {
  title: string;
  href: string;
  external?: boolean;
};

type MenuItem = {
  title: string;
  icon: LucideIcon;
  color: string;
  href?: string;
  children?: SubItem[];
};

const EXPANDED_WIDTH = 280;
const COLLAPSED_WIDTH = 70;
const PGWEB_PORT = 8081;

function buildMenu(pgwebHost: string): MenuItem[] {
  return [
    { title: "Overview", href: "/config", icon: LayoutGrid, color: "#1890ff" },
    {
      title: "StackPI Registration",
      href: "/config/registration",
      icon: Fingerprint,
      color: "#722ed1",
    },
    {
      title: "Portal Data",
      icon: Database,
      color: "#0ea5e9",
      children: [
        { title: "Cloud Sync", href: "/config/portal-data/cloud-sync" },
      ],
    },
    {
      title: "DB",
      icon: Database,
      color: "#13c2c2",
      children: [
        { title: "DB Status", href: "/config/db/status" },
        {
          title: "DB Admin",
          href: `http://${pgwebHost}:${PGWEB_PORT}`,
          external: true,
        },
      ],
    },
    {
      title: "RFID",
      icon: Radio,
      color: "#eb2f96",
      children: [
        { title: "RFID Readers", href: "/config/rfid/readers" },
        { title: "RFID Logs", href: "/config/rfid/logs" },
        { title: "RFID Settings", href: "/config/rfid/settings" },
      ],
    },
    {
      title: "Settings",
      icon: Settings,
      color: "#fa8c16",
      children: [
        { title: "System", href: "/config/settings/system" },
        { title: "Network", href: "/config/settings/network" },
        { title: "Hardware", href: "/config/settings/hardware" },
        { title: "Screen Settings", href: "/config/settings/screen-settings" },
        { title: "Status Screen", href: "/config/settings/screen-status" },
        { title: "Notifications", href: "/config/settings/notifications" },
        { title: "Software Update", href: "/config/settings/update" },
      ],
    },
    { title: "Logs", href: "/config/logs", icon: FileText, color: "#52c41a" },
  ];
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [pgwebHost, setPgwebHost] = useState("localhost");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const pathname = usePathname();
  const width = collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH;

  useEffect(() => {
    if (typeof window !== "undefined") {
      setPgwebHost(window.location.hostname);
    }
  }, []);

  const menu = buildMenu(pgwebHost);

  function toggleGroup(title: string) {
    setExpanded((e) => ({ ...e, [title]: !(e[title] ?? true) }));
  }

  function activeStyle(color: string) {
    return {
      borderLeftColor: color,
      backgroundColor: `${color}14`,
      color,
    } as const;
  }

  const inactiveStyle = { borderLeftColor: "transparent" } as const;

  return (
    <aside
      className="flex shrink-0 flex-col border-r border-zinc-200 bg-white transition-[width] duration-300"
      style={{ width }}
    >
      <div
        className={`flex min-h-16 items-center px-4 ${
          collapsed ? "justify-center" : "justify-between"
        }`}
      >
        <Link
          href="/config"
          className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-900"
        >
          <Image
            src="/stackpi-logo.png"
            alt="StackPI"
            width={120}
            height={80}
            priority
            className="h-8 w-auto object-contain"
          />
          {!collapsed && <span>StackPI</span>}
        </Link>
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((c) => !c)}
          className="flex h-8 w-8 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
        >
          <MenuIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="border-t border-zinc-200" />

      <nav className="flex-1 py-2">
        {menu.map((item) => {
          const Icon = item.icon;

          // --- Group with children ---
          if (item.children) {
            const isExpanded = expanded[item.title] ?? true; // default open
            const groupActive = item.children.some(
              (c) => !c.external && startsWithPath(pathname, c.href)
            );

            return (
              <div key={item.title}>
                <button
                  type="button"
                  onClick={() => toggleGroup(item.title)}
                  className={`flex w-full items-center gap-3 border-l-[3px] px-4 py-3 text-sm transition-colors ${
                    collapsed ? "justify-center" : ""
                  } ${groupActive ? "font-semibold" : "text-zinc-700 hover:bg-zinc-50"}`}
                  style={groupActive ? activeStyle(item.color) : inactiveStyle}
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  {!collapsed && (
                    <>
                      <span className="flex-1 text-left">{item.title}</span>
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </>
                  )}
                </button>

                {!collapsed &&
                  isExpanded &&
                  item.children.map((child) => {
                    const childActive =
                      !child.external && startsWithPath(pathname, child.href);
                    const cls = `block border-l-[3px] py-2 pl-12 pr-4 text-sm transition-colors ${
                      childActive
                        ? "font-semibold"
                        : "text-zinc-600 hover:bg-zinc-50"
                    }`;
                    const style: React.CSSProperties = childActive
                      ? activeStyle(item.color)
                      : inactiveStyle;

                    if (child.external) {
                      return (
                        <a
                          key={child.title}
                          href={child.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cls}
                          style={style}
                        >
                          {child.title} ↗
                        </a>
                      );
                    }
                    return (
                      <Link
                        key={child.title}
                        href={child.href}
                        className={cls}
                        style={style}
                      >
                        {child.title}
                      </Link>
                    );
                  })}
              </div>
            );
          }

          // --- Leaf item ---
          const active = pathname === item.href;
          return (
            <Link
              key={item.title}
              href={item.href!}
              className={`flex items-center gap-3 border-l-[3px] px-4 py-3 text-sm transition-colors ${
                collapsed ? "justify-center" : ""
              } ${active ? "font-semibold" : "text-zinc-700 hover:bg-zinc-50"}`}
              style={active ? activeStyle(item.color) : inactiveStyle}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {!collapsed && <span>{item.title}</span>}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
