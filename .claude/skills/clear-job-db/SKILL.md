---
name: clear-job-db
description: Clear all jobs from the database
disable-model-invocation: true
---

Delete ALL jobs from the SQLite database using Prisma.

Run this command:
```
npx prisma db execute --stdin <<< "DELETE FROM Job;"
```

Confirm to the user how many rows were deleted.
