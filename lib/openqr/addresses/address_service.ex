defmodule OpenQR.Addresses.AddressService do
  use Ash.Domain,
    otp_app: :openqr,
    extensions: [AshPaperTrail.Domain]

  paper_trail do
    include_versions? true
  end

  resources do
    resource OpenQR.Address
  end
end
