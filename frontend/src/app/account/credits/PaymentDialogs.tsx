"use client";

import { useEffect, useRef } from "react";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import WalletIcon from "./WalletIcon";
import SolanaMark from "./SolanaMark";
import styles from "./PaymentDialogs.module.css";

type PaymentDialogOrder = {
  creditAmount: string;
  usdCents: number;
  expectedLamports: string;
  network: "devnet" | "mainnet-beta";
  status: string;
  statusLabel?: string;
  reviewReason: string | null;
  transactionSignature: string | null;
};

type PaymentDialogWallet = {
  name: string;
  address: string;
  icon: string | null;
};

type DialogProps = {
  open: boolean;
  order: PaymentDialogOrder | null;
  wallet: PaymentDialogWallet | null;
  busy: boolean;
  error: string;
  secondsLeft: number;
  onPay: () => void;
  onClose: () => void;
};

function useDialog(open: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return {
    dialogRef,
    onClose: () => {
      if (dialogRef.current?.open) dialogRef.current.close();
      onClose();
    },
  };
}

function formatCredits(value: string): string {
  return Number(value).toLocaleString("en-GB", { maximumFractionDigits: 0 });
}

function formatSol(lamports: string): string {
  const amount = Number(BigInt(lamports)) / 1_000_000_000;
  return `${amount.toFixed(9).replace(/0+$/, "").replace(/\.$/, "")} SOL`;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function explorerUrl(signature: string, network: PaymentDialogOrder["network"]): string {
  const base = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`;
  return network === "devnet" ? `${base}?cluster=devnet` : base;
}

export function PaymentReviewDialog({
  open,
  order,
  wallet,
  busy,
  error,
  secondsLeft,
  onPay,
  onClose,
}: DialogProps) {
  const { dialogRef, onClose: closeDialog } = useDialog(open, onClose);

  if (!order || !wallet) return null;

  const canPay = order.status === "PENDING" && secondsLeft > 0;
  const pending = ["SUBMITTED", "CONFIRMING", "VERIFIED"].includes(order.status);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="payment-review-title"
      onClose={onClose}
      onCancel={(event) => { event.preventDefault(); if (!busy) closeDialog(); }}
    >
      <div className={styles.dialogHeader}>
        <h2 id="payment-review-title">Review payment</h2>
        <button className={styles.dialogClose} type="button" onClick={closeDialog} disabled={busy} aria-label="Close payment review">×</button>
      </div>

      <div className={styles.amountSummary}>
        <strong>{formatCredits(order.creditAmount)}</strong>
        <span>SIM Credits</span>
      </div>

      <dl className={styles.paymentDetails}>
        <div>
          <dt>Price</dt>
          <dd>{formatUsd(order.usdCents)}</dd>
        </div>
        <div>
          <dt>You pay</dt>
          <dd className={styles.solAmount}><SolanaMark className={styles.solanaMark} />{formatSol(order.expectedLamports)}</dd>
        </div>
      </dl>

      <div className={styles.connectedWallet}>
        <WalletIcon icon={wallet.icon} />
        <span><small>Wallet</small><strong>{wallet.name}</strong></span>
        <code>{wallet.address.slice(0, 5)}…{wallet.address.slice(-5)}</code>
      </div>

      {order.statusLabel ? <p className={styles.orderStatus} role="status">{order.statusLabel}</p> : null}
      {order.reviewReason ? <p className={styles.dialogError} role="alert">{order.reviewReason}</p> : null}
      {error ? <p className={styles.dialogError} role="alert">{error}</p> : null}
      {pending ? (
        <p className={styles.dialogStatus} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          Payment sent. Waiting for confirmation…
        </p>
      ) : null}

      {canPay ? (
        <button className={styles.primaryButton} type="button" onClick={onPay} disabled={busy}>
          {busy ? <span className={styles.spinner} aria-hidden="true" /> : null}
          {busy ? "Waiting for wallet…" : `Pay ${formatSol(order.expectedLamports)}`}
        </button>
      ) : null}
      {order.status === "EXPIRED" ? <p className={styles.orderStatus}>This quote expired. Continue to get a new one.</p> : null}
      {order.status === "FAILED" || order.status === "UNDERPAID" ? (
        <p className={styles.orderStatus}>Payment not completed. Close this quote and try again.</p>
      ) : null}
      {order.transactionSignature ? (
        <a className={styles.explorerLink} href={explorerUrl(order.transactionSignature, order.network)} target="_blank" rel="noreferrer">
          View transaction
        </a>
      ) : null}
      <button className={styles.cancelButton} type="button" onClick={closeDialog} disabled={busy}>
        Close
      </button>
    </dialog>
  );
}

export function PaymentSuccessDialog({
  open,
  order,
  wallet,
  onClose,
}: Pick<DialogProps, "open" | "order" | "wallet" | "onClose">) {
  const { dialogRef, onClose: closeDialog } = useDialog(open, onClose);

  if (!order) return null;

  return (
    <dialog
      ref={dialogRef}
      className={`${styles.dialog} ${styles.successDialog}`}
      aria-labelledby="payment-success-title"
      onClose={onClose}
      onCancel={(event) => { event.preventDefault(); closeDialog(); }}
    >
      <CheckCircleRoundedIcon className={styles.successIcon} aria-hidden="true" />
      <h2 id="payment-success-title">Payment successful</h2>
      <p className={styles.successCopy}>{formatCredits(order.creditAmount)} SIM Credits added.</p>
      <div className={styles.successAmount}>
        <SolanaMark className={styles.solanaMark} />
        <strong>{formatSol(order.expectedLamports)}</strong>
        <span>paid</span>
      </div>
      {wallet ? (
        <div className={styles.successWallet}>
          <WalletIcon icon={wallet.icon} size={28} />
          <span>{wallet.name}</span>
          <code>{wallet.address.slice(0, 5)}…{wallet.address.slice(-5)}</code>
        </div>
      ) : null}
      {order.transactionSignature ? (
        <a className={styles.explorerLink} href={explorerUrl(order.transactionSignature, order.network)} target="_blank" rel="noreferrer">
          View transaction
        </a>
      ) : null}
      <button className={styles.primaryButton} type="button" onClick={closeDialog}>Done</button>
    </dialog>
  );
}
