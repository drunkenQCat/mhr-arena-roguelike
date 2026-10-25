import { describe, expect, it } from "vitest";
import path from "node:path";
import ts from "typescript";
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
    expect(questData.content).toContain("get_field(name: never): never;");
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

describe("generated SDK compiler checks", () => {
  it("rejects wrong field names, values and method arguments, with an explicit raw escape", () => {
    const root = path.resolve(".local/virtual-sdk-test");
    const entry = path.join(root, "gen/types/check.ts");
    const virtualFiles = new Map<string, string>();
    virtualFiles.set(path.join(root, "sdk.ts"), `
      export interface REManagedObject {
        get_field(name: string): unknown;
        set_field(name: string, value: unknown): void;
        call(name: string, ...args: unknown[]): unknown;
      }
      export function unsafeGameObject(obj: REManagedObject): REManagedObject { return obj; }
    `);
    for (const file of generateTypes(miniDump, new Set(["snow_quest_QuestType"])).files) {
      virtualFiles.set(path.join(root, "gen/types", file.name), finalize(file.content, file.flat));
    }
    virtualFiles.set(entry, `
      import type { snow_quest_QuestData } from "./snow_quest_QuestData";
      import type { snow_quest_NormalQuestData_Param } from "./snow_quest_NormalQuestData_Param";
      import { unsafeGameObject } from "../../sdk";
      declare const q: snow_quest_QuestData;
      declare const normal: snow_quest_NormalQuestData_Param;
      const count: number = q.get_field("_QuestOrderMax");
      q.set_field("_QuestOrderMax", 42);
      q.call("getQuestData(System.Int32)", 101);
      // @ts-expect-error wrong field value
      q.set_field("_QuestOrderMax", "not a number");
      // @ts-expect-error unknown field
      q.set_field("_Typo", 42);
      // @ts-expect-error unknown getter
      q.get_field("_Typo");
      // @ts-expect-error wrong method argument
      q.call("getQuestData(System.Int32)", "not a number");
      // @ts-expect-error wrong argument count
      q.call("getQuestData(System.Int32)");
      // @ts-expect-error unknown method
      q.call("notInDump");
      // @ts-expect-error no inherited fallback on types without methods
      normal.call("notInDump");
      unsafeGameObject(q).call("verifiedMissingSignature", 123);
    `);
    const options: ts.CompilerOptions = {
      strict: true, noEmit: true, skipLibCheck: true,
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS,
      ignoreDeprecations: "6.0",
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const directoryExists = host.directoryExists!.bind(host);
    host.fileExists = (file) => virtualFiles.has(path.resolve(file)) || fileExists(file);
    host.directoryExists = (dir) => [...virtualFiles.keys()].some((file) =>
      file.startsWith(path.resolve(dir) + path.sep)) || directoryExists(dir);
    host.getSourceFile = (file, languageVersion, ...rest) => {
      const content = virtualFiles.get(path.resolve(file));
      return content === undefined ? getSourceFile(file, languageVersion, ...rest)
        : ts.createSourceFile(file, content, languageVersion, true);
    };
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });
});
