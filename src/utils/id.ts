/**
 * Room code generation utility.
 * Produces 6-character alphanumeric codes (A-Z, 0-9) with collision checking.
 */

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_LENGTH = 6;

/**
 * Generates a random 6-character alphanumeric room code.
 * Checks against existing codes to avoid collisions.
 *
 * @param existingCodes - Set of codes currently in use
 * @param maxAttempts - Maximum attempts before throwing (default 100)
 * @returns A unique 6-character room code
 */
export function generateRoomCode(
  existingCodes: Set<string>,
  maxAttempts: number = 100
): string {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      const index = Math.floor(Math.random() * CHARSET.length);
      code += CHARSET[index];
    }

    if (!existingCodes.has(code)) {
      return code;
    }
  }

  throw new Error(
    `Failed to generate unique room code after ${maxAttempts} attempts`
  );
}
