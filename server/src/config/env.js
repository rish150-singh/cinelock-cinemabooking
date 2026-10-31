import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep one shared .env file in the project root for the server and Prisma CLI.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

dotenv.config({ path: resolve(projectRoot, '.env') });
