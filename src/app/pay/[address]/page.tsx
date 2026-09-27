// SPDX-License-Identifier: MIT

import { redirect } from "next/navigation";
import Link from "next/link";
import prisma from "@/lib/prisma";
import { isValidStellarAddress, getStellarExplorerUrl } from "@/lib/stellar";
import { formatAmount, shortenAddress } from "@/lib/utils";

interface PayPageProps {
  params: Promise<{ address: string }>;
  searchParams: Promise<{
    amount?: string;
    memo?: string;
    asset?: string;
    due?: string;
    dueDate?: string;
    requestId?: string;
  }>;
}

/**
 * Shareable payment link route.
 * Redirects to the send form pre-filled with the recipient address and
 * any optional amount/memo/asset query params.
 * If a payment request is overdue, displays a prominent overdue invoice warning.
 */
export default async function PayPage({ params, searchParams }: PayPageProps) {
  const { address } = await params;
  const { amount, memo, asset, due, dueDate, requestId } = await searchParams;

  if (!isValidStellarAddress(address)) {
    return (
      <div className="max-w-lg mx-auto mt-12 animate-fade-in">
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-8 text-center">
          <div className="h-16 w-16 mx-auto rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mb-4">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              className="w-8 h-8 text-red-600 dark:text-red-400"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
              />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">
            Invalid Payment Link
          </h2>
          <p className="text-sm text-red-600 dark:text-red-400 mb-6 max-w-sm mx-auto">
            The recipient address in this link is not a valid Stellar address.
            Please check the link and try again.
          </p>
          <a
            href="/send"
            className="inline-block px-5 py-2.5 rounded-lg bg-ophir-600 text-white text-sm font-medium hover:bg-ophir-700 transition-colors"
          >
            Go to Send
          </a>
        </div>
      </div>
    );
  }

  let isOverdue = false;
  let isPaid = false;
  let txHash: string | null = null;
  let finalAmount = amount;
  let finalAsset = asset || "XLM";
  let finalMemo = memo;
  let finalDueDate: Date | null = null;

  if (due || dueDate) {
    const parsedDate = new Date((due || dueDate)!);
    if (!isNaN(parsedDate.getTime())) {
      finalDueDate = parsedDate;
      if (parsedDate < new Date()) {
        isOverdue = true;
      }
    }
  }

  if (requestId) {
    try {
      const requestRecord = await prisma.paymentRequest.findUnique({
        where: { id: requestId },
      });
      if (requestRecord) {
        finalAmount = finalAmount || requestRecord.amount.toString();
        finalAsset = requestRecord.assetCode;
        finalMemo = finalMemo || requestRecord.description || undefined;
        if (requestRecord.dueDate) {
          finalDueDate = requestRecord.dueDate;
          if (new Date(requestRecord.dueDate) < new Date()) {
            isOverdue = true;
          }
        }
        if (requestRecord.status === "OVERDUE") {
          isOverdue = true;
        } else if (requestRecord.status === "PAID") {
          isPaid = true;
          txHash = requestRecord.transactionHash;
        }
      }
    } catch {
      // Database unavailable or model mismatch — fallback gracefully
    }
  }

  const sendQuery = new URLSearchParams();
  sendQuery.set("dest", address);
  if (finalAmount) sendQuery.set("amount", finalAmount);
  if (finalMemo) sendQuery.set("memo", finalMemo);
  if (finalAsset) sendQuery.set("asset", finalAsset);

  // If already paid, display confirmation view
  if (isPaid) {
    return (
      <div className="max-w-lg mx-auto mt-12 animate-fade-in">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-xl overflow-hidden p-8 text-center">
          <div className="h-16 w-16 mx-auto rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mb-4">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
              className="w-8 h-8 text-emerald-600 dark:text-emerald-400"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
            Payment Request Already Settled
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
            This payment request has already been paid and settled.
          </p>
          {txHash && (
            <div className="mb-6 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg text-xs font-mono text-gray-600 dark:text-gray-300 break-all">
              Tx:{" "}
              <a
                href={getStellarExplorerUrl(txHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ophir-600 dark:text-ophir-400 underline"
              >
                {txHash}
              </a>
            </div>
          )}
          <Link
            href="/"
            className="inline-block px-5 py-2.5 rounded-lg bg-ophir-600 text-white text-sm font-medium hover:bg-ophir-700 transition-colors"
          >
            Return to OphirPay
          </Link>
        </div>
      </div>
    );
  }

  // If request is overdue, show explicit overdue alert and public invoice view
  if (isOverdue) {
    const formattedDue = finalDueDate
      ? finalDueDate.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Past Due Date";

    return (
      <div className="max-w-lg mx-auto mt-12 animate-fade-in">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border-2 border-red-300 dark:border-red-900/60 shadow-xl overflow-hidden">
          {/* Header Banner */}
          <div className="bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900/50 p-6 text-center">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
              Payment Request Overdue
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">
              Overdue Payment Request
            </h2>
            <p className="text-sm text-red-600 dark:text-red-400 mt-1 font-medium">
              This payment was due on {formattedDue}
            </p>
          </div>

          {/* Details Body */}
          <div className="p-6 space-y-4">
            <div className="p-4 rounded-xl bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 space-y-3">
              {finalAmount && (
                <div className="flex justify-between items-center text-sm">
                  <span className="text-gray-500 dark:text-gray-400">Amount Due</span>
                  <span className="font-bold text-lg text-gray-900 dark:text-white">
                    {formatAmount(finalAmount, finalAsset)}
                  </span>
                </div>
              )}
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-500 dark:text-gray-400">Recipient</span>
                <span className="font-mono text-gray-800 dark:text-gray-200" title={address}>
                  {shortenAddress(address, 6)}
                </span>
              </div>
              {finalMemo && (
                <div className="flex justify-between items-center text-sm">
                  <span className="text-gray-500 dark:text-gray-400">Memo / Note</span>
                  <span className="text-gray-800 dark:text-gray-200 font-medium">
                    {finalMemo}
                  </span>
                </div>
              )}
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-500 dark:text-gray-400">Status</span>
                <span className="text-red-600 dark:text-red-400 font-semibold flex items-center gap-1">
                  ● Overdue
                </span>
              </div>
            </div>

            <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
              You can still fulfill this overdue invoice by proceeding below.
            </p>

            <div className="flex flex-col gap-2 pt-2">
              <Link
                href={`/send?${sendQuery.toString()}`}
                className="w-full py-3 px-4 rounded-xl text-center font-medium bg-gradient-to-r from-ophir-600 to-stellar-dark text-white hover:from-ophir-700 hover:to-stellar transition-all shadow-md"
              >
                Proceed to Pay Overdue Invoice
              </Link>
              <Link
                href="/"
                className="w-full py-2.5 px-4 rounded-xl text-center text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                Return to Home
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Not overdue or paid — redirect to send form prefilled
  redirect(`/send?${sendQuery.toString()}`);
}
