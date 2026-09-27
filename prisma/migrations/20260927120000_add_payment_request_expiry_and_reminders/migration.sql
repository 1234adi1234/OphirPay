-- AlterEnum
ALTER TYPE "RequestStatus" ADD VALUE 'OVERDUE';

-- AlterTable
ALTER TABLE "PaymentRequest" ADD COLUMN "dueDate" TIMESTAMP(3),
ADD COLUMN "remindersCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastReminderAt" TIMESTAMP(3),
ADD COLUMN "overdueNotifiedAt" TIMESTAMP(3);
