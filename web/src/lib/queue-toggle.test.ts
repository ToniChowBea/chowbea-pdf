import { describe, expect, it } from "vitest"

import { resolveQueueToggle } from "./queue-toggle"

describe("resolveQueueToggle", () => {
  it("navigates to the queue and remembers where you were", () => {
    expect(resolveQueueToggle("/rotate", null)).toEqual({ to: "/queue", remember: "/rotate" })
  })

  it("returns to the remembered location from the queue", () => {
    expect(resolveQueueToggle("/queue", "/rotate")).toEqual({ to: "/rotate", remember: "/rotate" })
  })

  it("falls back to home when the queue was the entry point", () => {
    expect(resolveQueueToggle("/queue", null)).toEqual({ to: "/", remember: null })
  })
})
