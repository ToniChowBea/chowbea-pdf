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

  it("takeMatching removes only matching files and leaves the rest pending", () => {
    const pdf = new File(["a"], "a.pdf", { type: "application/pdf" })
    const png = new File(["b"], "b.png", { type: "image/png" })
    useHandoffStore.setState({ files: [png, pdf] })
    const taken = useHandoffStore.getState().takeMatching((f) => f.name.endsWith(".pdf"))
    expect(taken).toEqual([pdf])
    expect(useHandoffStore.getState().files).toEqual([png])
  })

  it("takeMatching honors the limit and keeps over-limit matches pending", () => {
    const one = new File(["1"], "one.pdf")
    const two = new File(["2"], "two.pdf")
    useHandoffStore.setState({ files: [one, two] })
    const taken = useHandoffStore.getState().takeMatching((f) => f.name.endsWith(".pdf"), 1)
    expect(taken).toEqual([one])
    expect(useHandoffStore.getState().files).toEqual([two])
  })

  it("takeMatching with no matches leaves the store untouched", () => {
    const png = new File(["b"], "b.png")
    useHandoffStore.setState({ files: [png] })
    expect(useHandoffStore.getState().takeMatching((f) => f.name.endsWith(".pdf"))).toEqual([])
    expect(useHandoffStore.getState().files).toEqual([png])
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
