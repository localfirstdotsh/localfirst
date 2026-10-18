import { z } from 'zod';

// Zod's optional eval/JIT probe reports CSP violations even when it catches the error.
// Use its supported interpreter mode for all website validation, including client interactions.
z.config({ jitless: true });
export { z };
