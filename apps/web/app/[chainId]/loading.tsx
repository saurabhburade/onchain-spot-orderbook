const rows = ["first", "second", "third", "fourth", "fifth", "sixth"];

export default function Loading() {
  return (
    <main aria-busy="true" className="min-h-screen w-full" role="status">
      <span className="sr-only">Loading page</span>
      <div aria-hidden="true" className="animate-pulse motion-reduce:animate-none">
        <div className="flex h-[65px] items-center gap-3 border-b border-border px-4 sm:px-6 lg:px-5 xl:px-6">
          <div className="h-8 w-60 rounded-full bg-muted" />
          <div className="size-8 rounded-full bg-muted" />
        </div>
        {rows.map((row) => (
          <div
            className="flex h-[69px] items-center justify-between gap-6 border-b border-border/70 px-4 sm:px-6 lg:px-5 xl:px-6"
            key={row}
          >
            <div className="h-8 w-36 rounded-full bg-muted" />
            <div className="h-3 w-16 rounded-full bg-muted" />
            <div className="hidden h-3 w-20 rounded-full bg-muted sm:block" />
            <div className="hidden h-3 w-20 rounded-full bg-muted lg:block" />
          </div>
        ))}
      </div>
    </main>
  );
}
