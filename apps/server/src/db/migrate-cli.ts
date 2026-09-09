import '../load-env.js';

import { openDatabase } from './index.js';

const database = openDatabase();
console.log(`Database migrations applied: ${database.path}`);
database.sqlite.close();
