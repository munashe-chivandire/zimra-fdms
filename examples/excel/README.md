# Fiscalising invoices kept in Excel

For a business that raises invoices in Excel and has no POS. Excel cannot talk
to FDMS itself (FDMS needs mutual TLS and a signed hash chain), so this script
sits between the two: save the sheet as CSV, run the script, paste the results
back.

## The sheet

One row per invoice line. Rows with the same `InvoiceNo` become one receipt.

| Column      | Example        | Notes                                                    |
| ----------- | -------------- | -------------------------------------------------------- |
| `InvoiceNo` | `INV-1001`     | Up to 50 characters                                      |
| `Item`      | `Bread`        |                                                          |
| `Qty`       | `2`            |                                                          |
| `UnitPrice` | `1.20`         | Tax inclusive, at most two decimals                      |
| `VAT`       | `15`           | `15`, `0` or `exempt`                                    |
| `Payment`   | `Cash`         | `Cash`, `Card`, `MobileWallet`, `BankTransfer`, `Credit`, `Coupon`, `Other` |
| `Currency`  | `USD`          | Three-letter code                                        |

Other columns (customer name and so on) are ignored. Column order does not
matter. See [sales.csv](sales.csv).

The `VAT` values map to tax IDs at the top of the script. Tax IDs differ
between taxpayers: run `npx zimra-fdms config` and edit the `TAX` table to
match before the first real run.

## Run it

```sh
npx zimra-fdms register --device-id 12345 --serial MYPOS01 --activation-key AAAABBBB   # once
npx zimra-fdms day open                                                               # each trading day
node excel-fiscalise.mjs sales.csv results.csv
npx zimra-fdms day close                                                              # end of day
```

In Excel use **File > Save As > CSV UTF-8**. `results.csv` gets one row per
invoice: `Status`, `ReceiptID`, `GlobalNo`, `Total`, `QRData` and `Error`.

Running the same sheet again skips invoices already marked `OK` in
`results.csv` and appends new ones, so a crash or a fixed row never
fiscalises an invoice twice. Keep `results.csv` with the day's sales. The
script exits with code 2 if any invoice failed.

## Before you rely on it

- **Fiscalise before you print.** The QR code and receipt number must be on
  the invoice the customer gets. Fiscalising a ledger at the end of the day
  does not make receipts already handed out compliant.
- **One machine per device.** The fiscal-day hash chain lives in the
  `.zimra` profile directory. Run the script on the machine that opened the
  day, and keep `.zimra/` backed up and out of shared folders: it holds the
  device private key.
- **A failed row does not break the day.** Bad input (an unknown VAT value,
  three-decimal prices, payments that do not add up) is refused before
  anything is signed. Fix the row and run again.

## Try it against the simulator

```sh
npx zimra-fdms-simulator --ca sim-ca.pem &
export ZIMRA_BASE_URL=https://localhost:8443 ZIMRA_CA=sim-ca.pem
npx zimra-fdms register --device-id 12345 --serial EXCEL01 --activation-key AAAABBBB
npx zimra-fdms day open
node excel-fiscalise.mjs sales.csv results.csv
npx zimra-fdms day close
```
