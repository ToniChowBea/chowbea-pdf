import {
  HeadContent,
  Link,
  Scripts,
  createRootRoute,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { TanStackDevtools } from "@tanstack/react-devtools"
import { HugeiconsIcon } from "@hugeicons/react"
import { File01Icon } from "@hugeicons/core-free-icons"

import { resolveQueueToggle } from "@/lib/queue-toggle"
import appCss from "../styles.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        name: "description",
        content:
          "Bold, free PDF tools. Pick a tool, drop a PDF — your files never leave the browser.",
      },
      { name: "theme-color", content: "#FFF3E2" },
      { title: "Chowbea PDF" },
    ],
    links: [
      // Bold Blocks type: Bricolage Grotesque (display) + Hanken Grotesk (body).
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700;12..96,800&family=Hanken+Grotesk:wght@400;500;600;700;800&display=swap",
      },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  notFoundComponent: () => (
    <div className="flex flex-col items-center justify-center gap-4 py-32 text-center">
      <div className="font-heading text-7xl font-extrabold text-ink uppercase">
        404
      </div>
      <p className="text-lg font-medium text-subtext">
        That page wandered off.
      </p>
      <Link
        to="/"
        className="press inline-flex items-center gap-2 rounded-full border-2 border-ink bg-card px-5 py-2.5 text-sm font-extrabold tracking-wide text-ink uppercase shadow-block-sm"
      >
        Back to tools
      </Link>
    </div>
  ),
  shellComponent: RootDocument,
})

/** Amber logo block + wordmark — the constant top-left mark on every screen. */
function Wordmark() {
  return (
    <Link to="/" className="flex items-center gap-3">
      <span className="flex size-10 items-center justify-center rounded-xl border-2 border-ink bg-amber text-ink">
        <HugeiconsIcon icon={File01Icon} className="size-5" strokeWidth={2.4} />
      </span>
      <span className="font-heading text-xl font-extrabold tracking-tight text-ink">
        Chowbea PDF
      </span>
    </Link>
  )
}

// Where the user was before toggling to the queue; module scope so it
// survives re-renders without being page state.
let rememberedPath: string | null = null

/** The header Queue pill: navigates like a link but toggles back on the
second click. Middle-click / open-in-new-tab keep normal link behavior. */
function QueueLink() {
  const router = useRouter()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return (
    <Link
      to="/queue"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
        event.preventDefault()
        const { to, remember } = resolveQueueToggle(pathname, rememberedPath)
        rememberedPath = remember
        router.history.push(to)
      }}
      className="press inline-flex items-center gap-2 rounded-full border-2 border-ink bg-card px-5 py-2.5 text-sm font-extrabold tracking-wide text-ink uppercase shadow-block-sm"
    >
      Queue
    </Link>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div className="min-h-svh bg-cream">
          <div className="mx-auto flex min-h-svh w-full max-w-7xl flex-col px-5 py-7 sm:px-8 sm:py-9 lg:px-10">
            {/* Top bar: wordmark left, queue link right. */}
            <header className="flex items-center justify-between">
              <Wordmark />
              <QueueLink />
            </header>

            <main className="flex-1">{children}</main>

            {/* Footer line, echoing the design-system footer. */}
            <footer className="mt-14 flex flex-col items-center justify-between gap-3 border-t-[3px] border-ink pt-6 sm:flex-row">
              <span className="font-heading text-sm font-extrabold text-ink">
                Chowbea PDF — Bold Blocks
              </span>
              <span className="text-[13px] font-semibold text-muted-ink">
                Free &amp; ad-free · your files never leave the browser
              </span>
            </footer>
          </div>
        </div>

        <TanStackDevtools
          config={{ position: "bottom-right" }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
