defmodule OpenQR.Ledgers.LedgerService do
  use Ash.Domain,
    otp_app: :openqr,
    extensions: [AshPaperTrail.Domain]

  paper_trail do
    include_versions? true
  end

  resources do
    resource OpenQR.Ledger.Account
    resource OpenQR.Ledger.Balance
    resource OpenQR.Ledger.Transfer
  end
end
