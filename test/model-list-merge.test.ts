import { mergeModelLists } from "../app/utils/model-list";
import { LLMModel } from "../app/client/api";

function model(name: string, providerId: string, sorted = 1): LLMModel {
  return {
    name,
    available: true,
    sorted,
    provider: {
      id: providerId,
      providerName: providerId,
      providerType: providerId,
      sorted,
    },
  };
}

describe("mergeModelLists", () => {
  it("dedupes models by stable provider identity instead of provider object reference", () => {
    const base = [model("gpt-test", "openai")];
    const persisted = Array.from({ length: 1000 }, () =>
      model("gpt-test", "openai"),
    );

    const merged = mergeModelLists(base, persisted);

    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("gpt-test");
    expect(merged[0].provider.id).toBe("openai");
  });

  it("keeps distinct providers for the same model name", () => {
    const merged = mergeModelLists(
      [model("shared-name", "openai")],
      [model("shared-name", "azure")],
    );

    expect(merged.map((item) => item.provider.id).sort()).toEqual([
      "azure",
      "openai",
    ]);
  });
});
