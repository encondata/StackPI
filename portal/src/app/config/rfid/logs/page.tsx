export default function RFIDLogsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">RFID Logs</h1>
        <p className="text-sm text-zinc-500">
          Recent raw and processed RFID scan activity.
        </p>
      </header>
      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Coming soon</h2>
        <p className="mt-2 text-sm text-zinc-600">
          A live tail of <code className="font-mono">local_rfid_raw_scans</code>{" "}
          and{" "}
          <code className="font-mono">local_rfid_processed_scans</code> will
          appear here, with filtering by reader and tag.
        </p>
      </section>
    </div>
  );
}
