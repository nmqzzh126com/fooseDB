/**
 * FooseTools — FoosDB 通用工具类
 * =================================
 * 从 foose_db.ts 的 Layer 6 剥离而来（2026-09-26）。
 * 零业务依赖、零第三方包依赖——可独立使用。
 */

/** 生成 UUID v4 字符串（自研实现，不依赖第三方库） */
function genUuidv4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export class FooseTools {
  /** 字符池，和校验正则保持一致——用于 generatePassword 保底 */
  static CHAR_POOL = {
    letters: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    digits: "0123456789",
    specials: "!@#$%^&*()_+{}[]:;|.<>/?"
  };
  /** 生成带 "id" 前缀的 uuidv4（连字符已去掉） */
  static createUuid(): string {
    return "id" + genUuidv4().replaceAll("-", "");
  }
  static toNumber(v: number | string): number {
    return Number(v);
  }
  static toString(v: number | string): string {
    return String(v);
  }
  static toBoolean(v: number | string): boolean {
    return Boolean(v);
  }
  static toDate(v: number | string): Date {
    return new Date(v);
  }
  /** 去掉所有空白字符（含全角空格 \u3000）并 trim */
  static clearAllSpace(v: string): string {
    if (!v) return "";
    return v.replace(/[\s\u3000]+/g, "").trim();
  }
  /**
   * 生成符合密码规则的随机密码
   * 【保底】每一类（letters/digits/specials）至少 1 个 → 保证校验通过
   * @param length 密码长度，默认 8；至少 3（保底需要）
   */
  static generatePassword(length: number = 8): string {
    const pwdChars: string[] = [];
    // 保底位
    pwdChars.push(this.getRandomChar(this.CHAR_POOL.letters));
    pwdChars.push(this.getRandomChar(this.CHAR_POOL.digits));
    pwdChars.push(this.getRandomChar(this.CHAR_POOL.specials));

    // 剩余字符全池随机填充
    const allChars =
      this.CHAR_POOL.letters + this.CHAR_POOL.digits + this.CHAR_POOL.specials;
    const remainCount = Math.max(length - 3, 0);
    for (let i = 0; i < remainCount; i++) {
      pwdChars.push(this.getRandomChar(allChars));
    }

    return this.shuffleArray(pwdChars).join("");
  }
  private static getRandomChar(str: string): string {
    const idx = Math.floor(Math.random() * str.length);
    return str[idx];
  }
  private static shuffleArray<T>(arr: T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}
