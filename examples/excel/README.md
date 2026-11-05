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
npx zimra-fdms register --env production --device-id 12345 --serial MYPOS01 --activation-key AAAABBBB   # once
npx zimra-fdms day open                                   # each trading day
node excel-fiscalise.mjs sales.csv results.csv
npx zimra-fdms day close                                  # end of day
```

`register` defaults to ZIMRA's test environment. Leave out `--env production`
while you are trying things out, and register a separate production device
for real sales.

In Excel use **File > Save As > CSV UTF-8**. `results.csv` gets a row per
invoice with `Status`, `ReceiptID`, `GlobalNo`, `Total`, `QRData`, `Warnings`
and `Error`. Keep it with the day's sales: it is how the script knows what is
already fiscalised.

## Reruns and crashes

The script writes a `PENDING` row before each submit and the outcome after
it. The latest row for an invoice decides what the next run does:

| Status    | Meaning                                    | Next run                    |
| --------- | ------------------------------------------ | --------------------------- |
| `OK`      | Fiscalised                                 | Skipped                     |
| `FAILED`  | FDMS did not take it (see `Error`)         | Submitted again             |
| `PENDING` | The script stopped mid-submit              | Skipped, listed for checking |
| `UNKNOWN` | Sent, but FDMS never answered              | Skipped, listed for checking |

`PENDING` and `UNKNOWN` invoices may already be fiscalised, so the script
never resubmits them on its own. Confirm on the FDMS portal, then append a
row with the invoice number and `OK`, or `FAILED` to submit it again. After
an `UNKNOWN` the run stops, since the connection is probably down; the next
CLI call delivers that receipt before anything else.

`Warnings` lists validation errors FDMS returned for an accepted receipt. A
Red one means the device can no longer close the day; close it on the ZIMRA
portal. The script exits with code 2 if anything failed, got a Red error or needs
checking.

## Before you rely on it

- **Fiscalise before you print.** The QR code and receipt number must be on
  the invoice the customer gets. Fiscalising a ledger at the end of the day
  does not make receipts already handed out compliant.
- **One machine per device.** The fiscal-day hash chain lives in the
  `.zimra` profile directory. Run the script on the machine that opened the
  day, and keep `.zimra/` backed up and out of shared folders: it holds the
  device private key.
- **A failed row does not break the day.** Bad input (an unknown VAT value,
  a blank or three-decimal price, rows of one invoice with different
  currencies or payment types) is refused before anything is signed. Fix the
  row and run again.

## Try it against the simulator

```sh
npx zimra-fdms-simulator --ca sim-ca.pem &
export ZIMRA_BASE_URL=https://localhost:8443 ZIMRA_CA=sim-ca.pem
npx zimra-fdms register --device-id 12345 --serial EXCEL01 --activation-key AAAABBBB
npx zimra-fdms day open
node excel-fiscalise.mjs sales.csv results.csv
npx zimra-fdms day close
```
