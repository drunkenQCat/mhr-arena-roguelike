/**
 * 可播种确定性 RNG —— 替代 C# System.Random。
 * mulberry32：小而快、逐位可复现；同 seed 必产生同一序列
 * （联机各端重放一致的前提，MhwRogue.Tests 的种子重放测试守护这一约定）。
 */

/**
 * 32 位乘法（Math.imul 的可移植替代）。
 * TSTL 不支持 Math.imul；拆 16 位半积在 JS 与 Lua 5.4 下逐位一致。
 */
function imul32(a: number, b: number): number {
  const ah = (a >>> 16) & 0xffff;
  const al = a & 0xffff;
  const bh = (b >>> 16) & 0xffff;
  const bl = b & 0xffff;
  const high = ((ah * bl + al * bh) & 0xffff) << 16;
  const low = (al * bl) & 0xffffffff;
  return ((high >>> 0) + (low >>> 0)) >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed?: number) {
    // 0 会让 mulberry32 退化为常量序列，强制非零
    this.state = (seed === undefined ? (Date.now() | 0) : seed | 0) || 0x9e3779b9;
    // 空转预热：让相邻种子的首个取值进一步去相关（廉价保险）。同 seed 仍产生同序列。
    for (let i = 0; i < 10; i++) this.nextUint();
  }

  /** [0, 0xffffffff) 的无符号整数。 */
  nextUint(): number {
    let t = (this.state += 0x6d2b79f5);
    t = imul32(t ^ (t >>> 15), t | 1);
    t ^= t + imul32(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** [0, n) 的整数（等价 C# Random.Next(n)）。
   * 注意必须先归一化到 [0,1) 再缩放：整数 u 直接 (u*n)%n 恒为 0。 */
  int(n: number): number {
    return Math.floor((this.nextUint() / 4294967296) * n);
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
