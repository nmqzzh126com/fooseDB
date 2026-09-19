export { default as dayjs } from "dayjs";
export { useDark, cloneDeep, randomGradient } from "@pureadmin/utils";
export const PASSWORD_MAX = 30;
export const PASSWORD_MIN = 10;
export type PasswordValidateResult = {
  valid: boolean;
  message: string;
};
// 字符池，和校验正则保持一致,用于生成随机密码
const CHAR_POOL = {
  letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  specials: '!@#$%^&*()_+{}[]:;|.<>/?'
};

export function getRandomIntBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 清除字符串中的所有空格（包括全角空格）
export function clearAllSpace(str: string) {
  return str.replace(/[\s\u3000]+/g, "");
}
//统一密码的检验规则
export function validatePassword(password: string): PasswordValidateResult {
  if (!password) {
    return { valid: false, message: "密码不能为空" };
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return { valid: false, message: `密码长度必须为${PASSWORD_MIN}-${PASSWORD_MAX}位` };
  }
  if (!/[a-zA-Z]/.test(password)) {
    return { valid: false, message: "密码必须包含英文字母" };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: "密码必须包含数字" };
  }
  if (!/[!@#$%^&*()_+{\}[\]:;|.<>/?]/.test(password)) {
    return { valid: false, message: "密码必须包含特殊字符 !@#$%^&*()_+{}[\]:;|.<>/? " };
  }
  return { valid: true, message: "校验通过" };
}
/**
 * 随机从字符串取单个字符
 */
function getRandomChar(str: string): string {
  const idx = Math.floor(Math.random() * str.length);
  return str[idx];
}
/**
 * 打乱数组（Fisher-Yates 洗牌算法，比 sort 随机更均匀）
 */
function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * 生成符合密码规则的随机密码
 * @param length 密码长度，默认取最小长度 PASSWORD_MIN
 */
export function generatePassword(length: number = PASSWORD_MIN + 5): string {
  // 长度合法性校验
  if (length < PASSWORD_MIN || length > PASSWORD_MAX) {
    throw new Error(`密码长度必须在 ${PASSWORD_MIN} ~ ${PASSWORD_MAX} 之间`);
  }

  const pwdChars: string[] = [];

  // 【保底】每一类至少放1个，保证校验一定通过
  pwdChars.push(getRandomChar(CHAR_POOL.letters));
  pwdChars.push(getRandomChar(CHAR_POOL.digits));
  pwdChars.push(getRandomChar(CHAR_POOL.specials));

  // 剩余字符，从全部字符集合随机填充
  const allChars = CHAR_POOL.letters + CHAR_POOL.digits + CHAR_POOL.specials;
  const remainCount = length - 3;
  for (let i = 0; i < remainCount; i++) {
    pwdChars.push(getRandomChar(allChars));
  }

  // 打乱顺序，防止前3位固定是字母、数字、特殊符号
  const shuffled = shuffleArray(pwdChars);
  return shuffled.join('');
}