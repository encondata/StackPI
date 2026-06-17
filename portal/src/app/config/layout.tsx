import { Sidebar } from "@/components/Sidebar";

export default function ConfigLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-zinc-50 text-zinc-900">
      <Sidebar />
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
