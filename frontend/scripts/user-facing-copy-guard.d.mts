export interface UserFacingCopyViolation {
  column: number;
  filePath: string;
  identifiers: string[];
  line: number;
  text: string;
}

export function internalIdentifiersInText(value: string): string[];
export function internalIdentifiersInTsxSource(
  sourceText: string,
  filePath?: string,
): UserFacingCopyViolation[];
export function userFacingCopyViolations(
  frontendRoot: string,
): UserFacingCopyViolation[];
export function assertUserFacingCopy(frontendRoot: string): void;
