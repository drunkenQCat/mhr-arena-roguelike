import { describe, expect, it } from "vitest";
import { finalize, flatName, generateTypes, mapType } from "./gen-types";

const miniDump = {
  generated: "test",
  count: 2,
  errors: {},
  types: {
    "snow.quest.QuestData": {
      fields: [
        { name: "<RawNormal>k__BackingField", type: "snow.quest.NormalQuestData.Param", static: false, offset: 0 },
        { name: "_QuestOrderMax", type: "System.Int32", static: false, offset: 16 },
        { name: "SomeStatic", type: "System.Int32", static: true, offset: 0 },
      ],
      methods: [
        { name: "get_RawNormal", ret: "snow.quest.NormalQuestData.Param", params: [], static: false, overloads: 1 },
        {
          name: "getQuestData(System.Int32)",
          ret: "snow.quest.QuestData",
          params: [{ name: "questNo", type: "System.Int32" }],
          static: false,
          overloads: 3,
        },
      ],
    },
    "snow.quest.NormalQuestData.Param": {
      fields: [{ name: "_QuestType", type: "snow.quest.QuestType", static: false, offset: 16 }],
      methods: [],
    },
  },
};

describe("gen-types（Stage 2 代码生成）", () => {
  it("mapType：基元/数组/枚举/未知 四类映射", () => {
    const known = new Set(["snow.quest.NormalQuestData.Param"]);
    const enums = new Set(["snow_quest_QuestType"]);
    expect(mapType("System.Int32", known, enums)).toBe("number");
    expect(mapType("System.String", known, enums)).toBe("string");
    expect(mapType("System.Void", known, enums)).toBe("void");
    expect(mapType("System.Guid[]", known, enums)).toBe("REManagedObject");
    expect(mapType("snow.quest.QuestType", known, enums)).toBe("number"); // 枚举→Stage1 数字常量
    expect(mapType("snow.quest.NormalQuestData.Param", known, enums)).toBe("snow_quest_NormalQuestData_Param");
    expect(mapType("some.Undocumented.Type", known, enums)).toBe("REManagedObject");
  });

  it("generateTypes：字段精确重载 + 兜底 + extends 基线 + call 签名", () => {
    const enums = new Set(["snow_quest_QuestType"]);
    const { files } = generateTypes(miniDump, enums);
    const questData = files.find((f) => f.name === "snow_quest_QuestData.ts")!;
    expect(questData.content).toContain("export interface snow_quest_QuestData extends REManagedObject {");
    expect(questData.content).toContain(
      'get_field(name: "<RawNormal>k__BackingField"): snow_quest_NormalQuestData_Param;',
    );
    expect(questData.content).toContain('get_field(name: "_QuestOrderMax"): number;');
    expect(questData.content).not.toContain("SomeStatic"); // 静态字段不生成实例重载
    expect(questData.content).toContain("get_field(name: string): unknown;");
    expect(questData.content).toContain('call(name: "getQuestData(System.Int32)", arg0: number): snow_quest_QuestData;');
    expect(questData.content).toContain("共 3 个重载");
  });

  it("generateTypes：跳过泛型实例化类型名", () => {
    const dump = JSON.parse(JSON.stringify(miniDump));
    dump.types["snow.BitSetFlag`1<snow_enemy_X>"] = { fields: [], methods: [] };
    const { files } = generateTypes(dump, new Set());
    expect(files.find((f) => f.name.includes("`"))).toBeUndefined();
  });

  it("finalize：自动补 import 头（类型跨引用 + REManagedObject）", () => {
    const { files } = generateTypes(miniDump, new Set(["snow_quest_QuestType"]));
    const questData = files.find((f) => f.name === "snow_quest_QuestData.ts")!;
    const full = finalize(questData.content, questData.flat);
    expect(full).toContain('import type { REManagedObject } from "../../sdk";');
    expect(full).toContain('import type { snow_quest_NormalQuestData_Param } from "./snow_quest_NormalQuestData_Param";');
    // 头必须在 interface 之前
    expect(full.indexOf("import type")).toBeLessThan(full.indexOf("export interface"));
  });

  it("flatName：命名空间扁平化", () => {
    expect(flatName("snow.quest.QuestData")).toBe("snow_quest_QuestData");
    expect(flatName("snow::gui::GuiManager")).toBe("snow_gui_GuiManager");
  });
});
