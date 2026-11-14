defmodule OpenQR.SearchTest.Domain do
  use Ash.Domain, otp_app: :openqr, validate_config_inclusion?: false

  resources do
    resource OpenQR.SearchTest.Category
    resource OpenQR.SearchTest.Record
  end
end
