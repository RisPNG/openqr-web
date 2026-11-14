defmodule OpenQR.ApiKeys.ApiKeyService do
  use Ash.Domain,
    otp_app: :openqr,
    extensions: [AshPaperTrail.Domain]

  paper_trail do
    include_versions? true
  end

  resources do
    resource OpenQR.Accounts.ApiKey
  end
end
