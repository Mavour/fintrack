import 'dotenv/config';
import { getDatabase, closeDatabase } from './database.js';

getDatabase();
closeDatabase();
// eslint-disable-next-line no-console
console.log('Migration OK');
