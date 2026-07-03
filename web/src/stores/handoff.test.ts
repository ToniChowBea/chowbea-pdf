import { beforeEach, describe, expect, it } from "vitest"

import { isSupportedFile } from "@/lib/supported-files"
import { useHandoffStore } from "./handoff"

describe("handoff store", () => {
  beforeEach(() => useHandoffStore.setState({ files: [] }))

  it("take returns the pending files and empties the store", () => {
    const files = [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")]
    useHandoffStore.setState({ files })
    expect(useHandoffStore.getState().take()).toEqual(files)
    expect(useHandoffStore.getState().files).toEqual([])
  })

  it("take on an empty store returns an empty array", () => {
    expect(useHandoffStore.getState().take()).toEqual([])
  })
})

describe("isSupportedFile", () => {
  it.each([
    ["doc.pdf", true],
    ["scan.PNG", true],
    ["photo.jpeg", true],
    ["notes.markdown", true],
    ["page.htm", true],
    ["report.docx", true],
    ["archive.zip", false],
    ["video.mp4", false],
    ["noextension", false],
  ])("%s -> %s", (name, expected) => {
    expect(isSupportedFile(new File(["x"], name))).toBe(expected)
  })
})
