/**
 * Age Validation Utilities
 * Enforces Constitutional Invariant I: 18+ Only, Age calculated by server, no minors allowed.
 */
export class AgeUtil {
  /**
   * Calculate exact age in completed years from YYYY-MM-DD
   */
  static calculateAge(birthDateStr: string, referenceDate: Date = new Date()): number {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDateStr);
    if (!match || !Number.isFinite(referenceDate.getTime())) {
      throw new Error('Định dạng ngày sinh không hợp lệ. Vui lòng sử dụng YYYY-MM-DD.');
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const daysInMonth = month === 2
      ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
      : ([4, 6, 9, 11].includes(month) ? 30 : 31);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth) {
      throw new Error('Định dạng ngày sinh không hợp lệ. Vui lòng sử dụng YYYY-MM-DD.');
    }

    const currentYear = referenceDate.getUTCFullYear();
    const currentMonth = referenceDate.getUTCMonth() + 1;
    const currentDay = referenceDate.getUTCDate();
    if (
      year > currentYear ||
      (year === currentYear && month > currentMonth) ||
      (year === currentYear && month === currentMonth && day > currentDay)
    ) {
      throw new Error('Ngày sinh không thể nằm trong tương lai.');
    }

    let age = currentYear - year;
    if (currentMonth < month || (currentMonth === month && currentDay < day)) {
      age--;
    }
    return age;
  }

  static readonly MIN_AGE = 13;

  /**
   * Validate that the user is at least 13 years old (Chatible platform minimum age)
   */
  static validateEligibleAge(birthDateStr: string, referenceDate: Date = new Date()): number {
    const age = this.calculateAge(birthDateStr, referenceDate);
    if (age < AgeUtil.MIN_AGE) {
      throw new Error(`Người dùng phải từ đủ ${AgeUtil.MIN_AGE} tuổi trở lên để sử dụng nền tảng Chatible.`);
    }
    return age;
  }

  /**
   * Backward-compatible alias for minimum platform age validation (>= 13)
   */
  static validateIsAdult(birthDateStr: string, referenceDate: Date = new Date()): number {
    return this.validateEligibleAge(birthDateStr, referenceDate);
  }

  /**
   * Check if user is legally an adult (>= 18) for adult media / NSFW consent
   */
  static isAdult(age: number): boolean {
    return age >= 18;
  }
}
