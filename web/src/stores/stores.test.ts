import { beforeEach, describe, expect, it } from "vitest"

import { useCompressStore } from "./compress"
import { useConvertStore } from "./convert"
import { useRotateStore } from "./rotate"
import { useSplitStore } from "./split"

describe("tool stores", () => {
  beforeEach(() => {
    useCompressStore.getState().reset()
    useRotateStore.getState().reset()
    useConvertStore.getState().reset()
    useSplitStore.getState().reset()
  })

  it("holds state outside React, so it survives page unmounts", () => {
    useCompressStore.setState({ status: "loading" })
    expect(useCompressStore.getState().status).toBe("loading")
  })

  it("supports functional updates", () => {
    useCompressStore.setState({ files: [new File(["a"], "a.pdf")] })
    useCompressStore.setState((state) => ({
      files: [...state.files, new File(["b"], "b.pdf")],
    }))
    expect(useCompressStore.getState().files.map((f) => f.name)).toEqual(["a.pdf", "b.pdf"])
  })

  it("reset restores the initial state", () => {
    useCompressStore.setState({ status: "error", error: "boom", quality: "screen" })
    useCompressStore.getState().reset()
    expect(useCompressStore.getState()).toMatchObject({
      status: "idle",
      error: null,
      quality: "ebook",
      files: [],
    })
  })

  it("rotate store carries page cards", () => {
    useRotateStore.setState({
      cards: [{ originalIndex: 0, rotation: 90, thumbnail: null }],
    })
    expect(useRotateStore.getState().cards[0].rotation).toBe(90)
    useRotateStore.getState().reset()
    expect(useRotateStore.getState().cards).toEqual([])
  })

  it("convert store resets target and dpi", () => {
    useConvertStore.setState({ target: "docx", dpi: 300, status: "loading" })
    useConvertStore.getState().reset()
    expect(useConvertStore.getState()).toMatchObject({ target: null, dpi: 150, status: "idle" })
  })

  it("resets the split store", () => {
    useSplitStore.setState({
      step: "build",
      parts: [{ pages: [0] }],
      downloadNames: ["a-1.pdf"],
    })
    useSplitStore.getState().reset()
    expect(useSplitStore.getState().step).toBe("upload")
    expect(useSplitStore.getState().parts).toEqual([])
    expect(useSplitStore.getState().downloadNames).toEqual([])
  })
})
