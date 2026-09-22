const socialLinkClassName =
  "relative grid size-8 place-items-center rounded-full bg-secondary text-muted-foreground outline-none before:absolute before:-inset-1.5 before:content-[''] transition-[color,background-color,transform] hover:bg-secondary/70 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 active:scale-[0.96]";

function GitHubLogo() {
  return (
    <svg aria-hidden="true" className="size-3" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.419 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.455-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.071 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.091-.646.349-1.087.635-1.337-2.221-.253-4.555-1.111-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.833a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.748-1.025 2.748-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.337 4.687-4.565 4.935.359.309.679.919.679 1.852 0 1.337-.012 2.415-.012 2.744 0 .268.18.579.688.481A10.004 10.004 0 0 0 22 12c0-5.523-4.477-10-10-10Z" />
    </svg>
  );
}

function XLogo() {
  return (
    <svg aria-hidden="true" className="size-3" fill="currentColor" viewBox="0 0 24 24">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817-5.966 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  );
}

export function AppFooter() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto flex min-h-11 w-full max-w-[1540px] items-center justify-between gap-3 px-2 sm:px-3">
        <p className="whitespace-nowrap text-[11px] text-muted-foreground">
          Built by{" "}
          <a
            className="font-medium text-foreground/80 outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
            href="https://x.com/saurabh_evm"
            rel="noreferrer"
            target="_blank"
          >
            x/saurabh_evm
          </a>
        </p>
        <nav aria-label="Social links" className="flex items-center gap-3">
          <a
            aria-label="View the project on GitHub"
            className={socialLinkClassName}
            href="https://github.com/saurabhburade/onchain-spot-orderbook"
            rel="noreferrer"
            target="_blank"
          >
            <GitHubLogo />
          </a>
          <a
            aria-label="Follow saurabh_evm on X"
            className={socialLinkClassName}
            href="https://x.com/saurabh_evm"
            rel="noreferrer"
            target="_blank"
          >
            <XLogo />
          </a>
        </nav>
      </div>
    </footer>
  );
}
