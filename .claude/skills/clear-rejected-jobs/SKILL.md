---
name: clear-rejected-jobs
description: Clear all rejected jobs from the database
disable-model-invocation: true
---

Delete all jobs with status "rejected" from the SQLite database using Prisma.

Run this command:
```
npx prisma db execute --stdin <<< "DELETE FROM Job WHERE status = 'rejected';"
```

Confirm to the user how many rows were deleted.
