import { describe, expect, it } from "vitest";
import {
  newDraftScope,
  readDraft,
  readPending,
  saveDraft,
  savePending,
  type StorageLike,
} from "./persistence";
import { pending } from "./workspace.fixtures";

function memory(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}
describe("scoped durable browser state", () => {
  it("keeps drafts separate between projects, reloads and explicit new-project boundaries", () => {
    const storage = memory();
    const initial = newDraftScope(false, storage);
    saveDraft(initial, "unsent brief", storage);
    saveDraft("project:one", "project correction", storage);
    expect(newDraftScope(false, storage)).toBe(initial);
    const next = newDraftScope(true, storage);
    expect(next).not.toBe(initial);
    expect(readDraft(next, storage)).toBe("");
    expect(readDraft(initial, storage)).toBe("unsent brief");
    expect(readDraft("project:one", storage)).toBe("project correction");
    expect(readDraft("project:two", storage)).toBe("");
  });
  it("retains action identity, assets, correction and original revision verbatim after reload", () => {
    const storage = memory();
    savePending("project:project-one", pending, storage);
    expect(readPending("project:project-one", storage)).toEqual(pending);
    saveDraft("project:project-one", "a different local draft", storage);
    expect(readPending("project:project-one", storage)?.payload).toEqual(
      pending.payload,
    );
    savePending("project:other", pending, storage);
    expect(readPending("project:other", storage)).toBeNull();
  });
  it("handles corrupt JSON, denied reads and exhausted storage without crashing", () => {
    const storage = memory();
    storage.setItem("molecule:v1:action:project:one", "{broken");
    expect(readPending("project:one", storage)).toBeNull();
    const denied = () => {
      throw new Error("denied");
    };
    const unavailable: StorageLike = {
      getItem: denied,
      setItem: denied,
      removeItem: denied,
    };
    expect(readDraft("project:one", unavailable)).toBe("");
    expect(saveDraft("project:one", "text", unavailable)).toBe(false);
    expect(saveDraft("project:one", "", unavailable)).toBe(false);
    expect(readPending("project:one", unavailable)).toBeNull();
    expect(savePending("project:one", pending, unavailable)).toBe(false);
    expect(newDraftScope(true, unavailable)).toMatch(/^new:/);
  });
  it("keeps both tabs' exact unresolved payloads across reload instead of overwriting the first action", () => {
    const storage = memory();
    const firstTab = memory();
    const secondTab = memory();
    const scope = "project:project-one";
    const second = {
      ...pending,
      key: "message:two",
      payload: { ...pending.payload!, text: "Different correction" },
    };
    savePending(scope, pending, storage, firstTab);
    savePending(scope, second, storage, secondTab);
    expect(readPending(scope, storage, firstTab)).toEqual(pending);
    expect(readPending(scope, storage, secondTab)).toEqual(second);
    savePending(scope, { ...pending, status: "succeeded" }, storage, firstTab);
    expect(readPending(scope, storage, secondTab)).toEqual(second);
  });
});
