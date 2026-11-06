// The intake form's shared rules for the Functions — the single source is ../intake-rules.js (a classic script that defines
// INTAKE_RULES on the global object; intake.html loads the very same file). Change the rules there. The `_` prefix keeps
// this file from becoming a route.
import '../intake-rules.js';
export const INTAKE_RULES = globalThis.INTAKE_RULES;
