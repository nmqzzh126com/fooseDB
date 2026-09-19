import { v4 as uuidv4 } from "uuid";

class FooseTools {
  static createUuid(): string {
    return "id" + uuidv4().replaceAll("-", "");
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
}
export default FooseTools;
