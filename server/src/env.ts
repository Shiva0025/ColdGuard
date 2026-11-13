import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the repository-root .env (if present) regardless of the working directory.
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../.env'), quiet: true } as any);
