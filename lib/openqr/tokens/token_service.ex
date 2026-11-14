defmodule OpenQR.Tokens.TokenService do
  use Ash.Domain,
    otp_app: :openqr,
    extensions: [AshAdmin.Domain]

  admin do
    show? true
  end

  resources do
    resource OpenQR.Accounts.Token
  end
end
