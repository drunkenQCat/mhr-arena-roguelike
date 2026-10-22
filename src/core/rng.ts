/**
 * 可播种确定性 RNG —— 替代 C# System.Random。
 * mulberry32：小而快、逐位可复现；同 seed 必产生同一序列
 * （联机各端重放一致的前提，MhwRogue.Tests 的种子重放测试守护这一约定）。
 */

export class Rng {
  private state: number;

  constructor(seed?: number) {
    // 0 会让 mulberry32 退化为常量序列，强制非零
    this.state = (seed === undefined ? (Date.now() | 0) : seed | 0) || 0x9e3779b9;
  }

  /** [0, 0xffffffff) 的无符号整数。 */
  nextUint(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  }

  /** [0, n) 的整数（等价 C# Random.Next(n)）。 */
  int(n: number): number {
    return Math.floor(this.nextUint() * n) % n;
  }

  /** 就地 Fisher-Yates 洗牌（TSTL/Lua table 语义友好）。 */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }
    return arr;
  }
}
