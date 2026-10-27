import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/lib/paths.mjs -> skill root is two levels up.
export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DASHBOARD_DIR = path.join(SKILL_DIR, 'scripts', 'dashboard');
export const MOCK_CLAUDE = path.join(SKILL_DIR, 'scripts', 'test', 'mock-claude.mjs');
// Cross-project memory: lessons from retrospectives feed future CTO planning sessions.
export const USER_DIR = path.join(os.homedir(), '.yourteam');
export const LESSONS_FILE = path.join(USER_DIR, 'lessons.md');
